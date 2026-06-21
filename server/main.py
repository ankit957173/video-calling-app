import os
import io
import re
import base64
import asyncio
from collections import OrderedDict
from pathlib import Path
from dotenv import load_dotenv
import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from google import genai as google_genai

load_dotenv()

# ── Gemini setup ───────────────────────────────────────────────────────────────
_gemini_key = os.getenv("GEMINI_API_KEY")
gemini_client = google_genai.Client(api_key=_gemini_key) if _gemini_key else None
# gemini-2.0-flash-lite has a higher free-tier RPM (30 vs 15) than gemini-2.0-flash
GEMINI_MODEL  = "gemini-2.0-flash-lite"

# ── Translation cache ─────────────────────────────────────────────────────────
# Keyed by (text, source_lang, target_lang) → translated string.
# Prevents duplicate API calls for repeated phrases.
_trans_cache: OrderedDict[tuple, str] = OrderedDict()
_CACHE_LIMIT = 500

# BCP-47 code → human-readable name used in translation prompts
LANG_NAMES: dict[str, str] = {
    "en-US": "English",
    "hi-IN": "Hindi",
    "es-ES": "Spanish",
    "fr-FR": "French",
    "de-DE": "German",
    "zh-CN": "Chinese (Simplified)",
    "ja-JP": "Japanese",
    "ar-SA": "Arabic",
    "pt-BR": "Portuguese",
    "ru-RU": "Russian",
}


# Languages that must be shown in native script, not romanized Latin letters
NATIVE_SCRIPT_LANGS = frozenset({"hi-IN", "zh-CN", "ja-JP", "ar-SA", "ru-RU"})

# BCP-47 → deep-translator language code
_DEEPL_LANG: dict[str, str] = {
    "en-US": "en",
    "hi-IN": "hi",
    "es-ES": "es",
    "fr-FR": "fr",
    "de-DE": "de",
    "zh-CN": "zh-CN",
    "ja-JP": "ja",
    "ar-SA": "ar",
    "pt-BR": "pt",
    "ru-RU": "ru",
}

# Extra instruction so Gemini returns native script (not WhatsApp-style romanization)
_NATIVE_SCRIPT_HINTS: dict[str, str] = {
    "hi-IN": "Write the output in Devanagari script (हिंदी). Do NOT use romanized Latin letters.",
    "zh-CN": "Write the output in Simplified Chinese characters. Do NOT use pinyin or Latin letters.",
    "ja-JP": "Write the output in Japanese script (kanji/kana). Do NOT use romaji.",
    "ar-SA": "Write the output in Arabic script. Do NOT use Latin transliteration.",
    "ru-RU": "Write the output in Cyrillic script. Do NOT use Latin transliteration.",
}


def _safe_print(msg: str) -> None:
    """Print without crashing on Windows cp1252 consoles (Hindi/CJK in logs)."""
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", errors="backslashreplace").decode("ascii"))


def _log_translation(provider: str, source_lang: str, target_lang: str, text: str) -> None:
    _safe_print(f"[Translation/{provider}] {source_lang} -> {target_lang}: {text!r}")


def _deepl_code(bcp47: str) -> str:
    return _DEEPL_LANG.get(bcp47, bcp47.split("-")[0])


def _is_mostly_latin(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return True
    latin = sum(1 for c in letters if ord(c) < 128)
    return latin / len(letters) > 0.6


def _needs_native_script(text: str, target_lang: str) -> bool:
    return target_lang in NATIVE_SCRIPT_LANGS and _is_mostly_latin(text)


def _same_language(a: str, b: str) -> bool:
    return a.split("-")[0].lower() == b.split("-")[0].lower()


_ISO_TO_BCP: dict[str, str] = {
    "en": "en-US",
    "hi": "hi-IN",
    "es": "es-ES",
    "fr": "fr-FR",
    "de": "de-DE",
    "zh-cn": "zh-CN",
    "zh": "zh-CN",
    "ja": "ja-JP",
    "ar": "ar-SA",
    "pt": "pt-BR",
    "ru": "ru-RU",
}


_HINDI_ROMAN_WORDS = frozenset({
    "aap", "apka", "apke", "kaise", "kya", "hai", "hain", "main", "nahi", "haan",
    "namaste", "dhanyavaad", "kahan", "kab", "kyun", "accha", "theek", "mera", "meri",
    "tum", "hum", "yeh", "woh", "kuch", "bahut", "ho", "hoon", "hume", "aapka",
})


def _looks_like_romanized_hindi(text: str) -> bool:
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if not words:
        return False
    hits = sum(1 for w in words if w in _HINDI_ROMAN_WORDS)
    return hits >= 1 and hits / len(words) >= 0.2


def _detect_script_lang(text: str) -> str | None:
    if any("\u0900" <= c <= "\u097f" for c in text):
        return "hi-IN"
    if any("\u4e00" <= c <= "\u9fff" for c in text):
        return "zh-CN"
    if any("\u0600" <= c <= "\u06ff" for c in text):
        return "ar-SA"
    if any("\u0400" <= c <= "\u04ff" for c in text):
        return "ru-RU"
    if any("\u3040" <= c <= "\u30ff" for c in text):
        return "ja-JP"
    return None


def _detect_language_sync(text: str, hint: str) -> str:
    script = _detect_script_lang(text)
    if script:
        return script
    if _looks_like_romanized_hindi(text):
        return "hi-IN"
    try:
        from langdetect import detect, DetectorFactory

        DetectorFactory.seed = 0
        iso = detect(text).lower()
        return _ISO_TO_BCP.get(iso, hint)
    except Exception:
        return hint


async def detect_language(text: str, hint: str) -> str:
    return await asyncio.to_thread(_detect_language_sync, text, hint)


def _translate_google_sync(text: str, source_lang: str, target_lang: str) -> str:
    from deep_translator import GoogleTranslator

    src = _deepl_code(source_lang)
    tgt = _deepl_code(target_lang)
    result = GoogleTranslator(source=src, target=tgt).translate(text)

    # Speech often yields Hinglish in Latin letters; auto-detect keeps it romanized.
    # Treating the phrase as English→Hindi converts it to proper Devanagari.
    if _needs_native_script(result, target_lang) and src != "en":
        result = GoogleTranslator(source="en", target=tgt).translate(text)
    return result


async def _translate_gemini(text: str, source_lang: str, target_lang: str) -> str | None:
    if not gemini_client:
        return None

    src = LANG_NAMES.get(source_lang, source_lang)
    tgt = LANG_NAMES.get(target_lang, target_lang)
    script_hint = _NATIVE_SCRIPT_HINTS.get(target_lang, "")
    prompt = (
        f"Translate the following text from {src} to {tgt}. "
        f"Return ONLY the translated text — no explanations, no quotes."
    )
    if script_hint:
        prompt += f" {script_hint}"
    prompt += f"\n\nText: {text}"

    response = await asyncio.to_thread(
        gemini_client.models.generate_content,
        model=GEMINI_MODEL,
        contents=prompt,
    )
    return response.text.strip()


async def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """Translate text with caching. Gemini first, Google Translate fallback."""
    # Same language but romanized Hinglish → still convert to Devanagari for Hindi viewers
    if source_lang == target_lang:
        if _needs_native_script(text, target_lang):
            source_lang = "en-US" if target_lang == "hi-IN" else source_lang
        else:
            return text

    cache_key = (text, source_lang, target_lang)
    if cache_key in _trans_cache:
        _trans_cache.move_to_end(cache_key)
        return _trans_cache[cache_key]

    translated: str | None = None

    try:
        translated = await _translate_gemini(text, source_lang, target_lang)
        if translated:
            _log_translation("Gemini", source_lang, target_lang, translated)
    except Exception as exc:
        err = str(exc)
        if "429" in err or "RESOURCE_EXHAUSTED" in err:
            _safe_print("[Translation] Gemini quota exceeded — using Google Translate fallback.")
        else:
            _safe_print(f"[Translation/Gemini error] {exc}")

    if not translated or _needs_native_script(translated, target_lang):
        try:
            translated = await asyncio.to_thread(
                _translate_google_sync, text, source_lang, target_lang
            )
            _log_translation("Google", source_lang, target_lang, translated)
        except Exception as exc:
            _safe_print(f"[Translation/Google error] {exc}")
            return text

    _trans_cache[cache_key] = translated
    if len(_trans_cache) > _CACHE_LIMIT:
        _trans_cache.popitem(last=False)
    return translated


def _transcribe_wav_sync(wav_bytes: bytes, lang: str) -> str:
    import speech_recognition as sr

    recognizer = sr.Recognizer()
    with sr.AudioFile(io.BytesIO(wav_bytes)) as source:
        audio = recognizer.record(source)
        return recognizer.recognize_google(audio, language=lang)


async def transcribe_wav(wav_bytes: bytes, lang: str) -> str:
    """Speech-to-text for mobile audio chunks (WAV PCM 16 kHz mono)."""
    try:
        return await asyncio.to_thread(_transcribe_wav_sync, wav_bytes, lang)
    except Exception as exc:
        _safe_print(f"[STT error] {exc}")
        return ""


async def broadcast_caption(sid: str, text: str, source_hint: str) -> None:
    info = user_data.get(sid, {})
    room_id = info.get("roomId")
    if not room_id or room_id not in rooms:
        return

    speaker = info.get("userName", "Peer")
    source_lang = await detect_language(text, source_hint)
    _safe_print(f"[Caption] {speaker}: {text!r} (detected: {source_lang})")

    for peer_sid in list(rooms[room_id]):
        target_lang = user_data.get(peer_sid, {}).get("language", "en-US")
        translated = await translate_text(text, source_lang, target_lang)
        is_self = peer_sid == sid
        needs_voice = not is_self and not _same_language(source_lang, target_lang)
        await sio.emit(
            "caption",
            {
                "from": speaker,
                "text": translated,
                "isSelf": is_self,
                "detectedLang": source_lang,
                "needsVoice": needs_voice,
            },
            to=peer_sid,
        )


# ── Socket.IO async server (ASGI mode, compatible with socket.io-client in JS)
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
)

# ── FastAPI app (health-check route only)
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Socket.IO on top of FastAPI so both share the same port
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# ── In-memory state
# roomId  -> set of socket IDs
rooms: dict[str, set] = {}
# sid     -> {"roomId": str, "userName": str}
user_data: dict[str, dict] = {}


# ── Static frontend (production Docker image copies Vite build to ./static) ───

STATIC_DIR = Path(__file__).resolve().parent / "static"


def _static_file(relative_path: str = "") -> FileResponse | None:
    if not STATIC_DIR.is_dir():
        return None
    if relative_path:
        candidate = (STATIC_DIR / relative_path).resolve()
        try:
            candidate.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return None
        if candidate.is_file():
            return FileResponse(candidate)
    index = STATIC_DIR / "index.html"
    return FileResponse(index) if index.is_file() else None


# ── REST routes ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "message": "Video Calling Signaling Server is running."}


@app.get("/")
async def root():
    if response := _static_file():
        return response
    return {"message": "Video Calling Signaling Server is running."}


@app.get("/{full_path:path}")
async def spa(full_path: str):
    if response := _static_file(full_path):
        return response
    return {"message": "Not found."}


# ── Socket.IO events ──────────────────────────────────────────────────────────

@sio.event
async def connect(sid, environ):
    _safe_print(f"[+] Connected: {sid}")


@sio.on("join-room")
async def join_room(sid, data):
    """Handles the client-side 'join-room' event."""
    room_id  = data.get("roomId")
    user_name = data.get("userName", "Guest")
    language  = data.get("language", "en-US")

    existing = rooms.get(room_id, set())

    if len(existing) >= 2:
        await sio.emit("room-full", to=sid)
        return

    existing.add(sid)
    rooms[room_id] = existing
    await sio.enter_room(sid, room_id)

    user_data[sid] = {"roomId": room_id, "userName": user_name, "language": language}

    # Tell the newcomer about existing peers (with their userName)
    other_peers = [
        {
            "socketId": peer_sid,
            "userName": user_data.get(peer_sid, {}).get("userName", "Peer"),
            "language": user_data.get(peer_sid, {}).get("language", "en-US"),
        }
        for peer_sid in existing
        if peer_sid != sid
    ]
    await sio.emit("room-joined", {"roomId": room_id, "peers": other_peers}, to=sid)

    # Notify existing peers about the newcomer
    await sio.emit(
        "user-joined",
        {"socketId": sid, "userName": user_name, "language": language},
        room=room_id,
        skip_sid=sid,
    )

    _safe_print(f"[Room {room_id}] {user_name} ({sid}) joined. Peers: {len(existing)}")


@sio.event
async def offer(sid, data):
    """Relay a WebRTC offer to the target socket."""
    to = data.get("to")
    await sio.emit(
        "offer",
        {
            "from": sid,
            "offer": data.get("offer"),
            "userName": user_data.get(sid, {}).get("userName", "Peer"),
        },
        to=to,
    )


@sio.event
async def answer(sid, data):
    """Relay a WebRTC answer to the target socket."""
    to = data.get("to")
    await sio.emit(
        "answer",
        {
            "from": sid,
            "answer": data.get("answer"),
            "userName": user_data.get(sid, {}).get("userName", "Peer"),
        },
        to=to,
    )


@sio.on("ice-candidate")
async def ice_candidate(sid, data):
    """Relay an ICE candidate to the target socket."""
    to = data.get("to")
    await sio.emit(
        "ice-candidate",
        {"from": sid, "candidate": data.get("candidate")},
        to=to,
    )


@sio.on("status-update")
async def status_update(sid, data):
    """Forward mic/camera status to the other peer in the room."""
    info = user_data.get(sid, {})
    room_id = info.get("roomId")
    if room_id:
        await sio.emit(
            "peer-status",
            {
                "isMuted": data.get("isMuted"),
                "isCameraOff": data.get("isCameraOff"),
                "userName": info.get("userName"),
            },
            room=room_id,
            skip_sid=sid,
        )


@sio.on("caption")
async def caption(sid, data):
    """Receive a transcript from a speaker, translate if needed, and broadcast to all room peers."""
    info = user_data.get(sid, {})
    room_id = info.get("roomId")
    if not room_id or room_id not in rooms:
        _safe_print(f"[Caption] ignored — sid {sid} not in a room")
        return

    text = data.get("text", "").strip()
    source_lang = data.get("lang", info.get("language", "en-US"))
    if not text:
        return

    await broadcast_caption(sid, text, source_lang)


@sio.on("caption-audio")
async def caption_audio(sid, data):
    """Mobile path: transcribe WAV audio from the WebRTC stream, then broadcast captions."""
    info = user_data.get(sid, {})
    room_id = info.get("roomId")
    if not room_id or room_id not in rooms:
        return

    audio_b64 = data.get("audio")
    if not audio_b64:
        return

    lang = data.get("lang", info.get("language", "en-US"))
    try:
        wav_bytes = base64.b64decode(audio_b64)
    except Exception:
        return

    text = await transcribe_wav(wav_bytes, lang)
    if text.strip():
        await broadcast_caption(sid, text.strip(), lang)


@sio.event
async def disconnect(sid):
    """Clean up state and notify room peers when a socket disconnects."""
    info = user_data.pop(sid, {})
    room_id = info.get("roomId")
    user_name = info.get("userName")

    if room_id and room_id in rooms:
        rooms[room_id].discard(sid)
        if not rooms[room_id]:
            del rooms[room_id]
        await sio.emit(
            "user-left",
            {"socketId": sid, "userName": user_name},
            room=room_id,
        )
        _safe_print(f"[-] {user_name or sid} left room {room_id}")

    _safe_print(f"[-] Disconnected: {sid}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 5000))
    if not gemini_client:
        _safe_print("[WARN] GEMINI_API_KEY not set — using Google Translate for captions.")
    else:
        _safe_print(f"[OK] Gemini translation enabled (model: {GEMINI_MODEL}), Google Translate fallback ready")
    _safe_print("[OK] Mobile caption STT enabled (caption-audio -> Google Speech)")
    _safe_print(f"Signaling server listening on http://0.0.0.0:{port}")
    uvicorn.run("main:socket_app", host="0.0.0.0", port=port, reload=True)
