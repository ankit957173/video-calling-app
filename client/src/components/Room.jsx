import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import socket from "../socket";
import VideoPlayer from "./VideoPlayer";
import { isMobileDevice, MobileAudioCapturer } from "../utils/mobileCaptions";
import { VoiceTranslator } from "../utils/voiceTranslate";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function useCallTimer(running) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) { setSeconds(0); return; }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function initials(name) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const userName = location.state?.userName || "Guest";
  const language = location.state?.language  || "en-US";

  const localVideoRef     = useRef(null);
  const remoteVideoRef    = useRef(null);
  const localStreamRef    = useRef(null);
  const remoteStreamRef   = useRef(null);
  const pcRef             = useRef(null);
  const pendingCandidates = useRef([]);
  const hasJoined         = useRef(false);
  const recognitionRef    = useRef(null);
  const captionTimers     = useRef({});
  // caption debounce: accumulate short sentences for 1 s before emitting
  const captionBufferRef  = useRef("");
  const captionFlushRef   = useRef(null);
  // watchdog: force-restart recognition if silent for too long (Chrome mobile bug)
  const recWatchdogRef    = useRef(null);
  const mobileCapturerRef = useRef(null);
  const voiceTranslatorRef = useRef(null);
  const ccEnabledRef        = useRef(true);
  const voiceTranslateRef   = useRef(true);
  const languageRef         = useRef(language);
  const remoteLanguageRef   = useRef(null);

  const [remoteUserName, setRemoteUserName]         = useState("");
  const [isMuted, setIsMuted]                       = useState(false);
  const [isCameraOff, setIsCameraOff]               = useState(false);
  const [isRemoteConnected, setIsRemoteConnected]   = useState(false);
  const [isRemoteMuted, setIsRemoteMuted]           = useState(false);
  const [isRemoteCameraOff, setIsRemoteCameraOff]   = useState(false);
  const [copied, setCopied]     = useState(false);
  const [statusMsg, setStatusMsg] = useState("Waiting for someone to join…");
  const [ccEnabled, setCcEnabled]   = useState(true);
  const [voiceTranslateEnabled, setVoiceTranslateEnabled] = useState(true);
  const [remoteLanguage, setRemoteLanguage]       = useState(null);
  const [captions, setCaptions]     = useState([]);
  const [streamReady, setStreamReady] = useState(false);

  const speechActive = ccEnabled || voiceTranslateEnabled;

  useEffect(() => { ccEnabledRef.current = ccEnabled; }, [ccEnabled]);
  useEffect(() => { voiceTranslateRef.current = voiceTranslateEnabled; }, [voiceTranslateEnabled]);
  useEffect(() => {
    languageRef.current = language;
    voiceTranslatorRef.current?.setLang(language);
  }, [language]);

  const languagesDiffer = useCallback((a, b) => {
    if (!a || !b) return false;
    return a.split("-")[0].toLowerCase() !== b.split("-")[0].toLowerCase();
  }, []);

  const applyRemoteAudio = useCallback(() => {
    const stream = remoteStreamRef.current;
    if (!stream) return;
    const muteOriginal =
      voiceTranslateRef.current &&
      languagesDiffer(languageRef.current, remoteLanguageRef.current);
    stream.getAudioTracks().forEach((t) => { t.enabled = !muteOriginal; });
  }, [languagesDiffer]);

  useEffect(() => { remoteLanguageRef.current = remoteLanguage; }, [remoteLanguage]);

  useEffect(() => {
    applyRemoteAudio();
  }, [voiceTranslateEnabled, remoteLanguage, isRemoteConnected, applyRemoteAudio]);

  useEffect(() => {
    const vt = new VoiceTranslator({ lang: language });
    voiceTranslatorRef.current = vt;
    return () => vt.destroy();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const callTimer = useCallTimer(isRemoteConnected);

  // Attach remote stream after the video element mounts
  useEffect(() => {
    if (isRemoteConnected && remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, [isRemoteConnected]);

  // ─── WebRTC ────────────────────────────────────────────────────────────────

  const createPeerConnection = useCallback((remotePeerId) => {
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit("ice-candidate", { to: remotePeerId, candidate });
    };

    pc.ontrack = (event) => {
      remoteStreamRef.current = event.streams[0];
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];

      // Detect remote camera mute via video track muted/enabled
      const videoTrack = event.streams[0].getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener("mute",   () => setIsRemoteCameraOff(true));
        videoTrack.addEventListener("unmute", () => setIsRemoteCameraOff(false));
      }

      setIsRemoteConnected(true);
      setStatusMsg("");
    };

    pc.oniceconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
        setIsRemoteConnected(false);
        setIsRemoteCameraOff(false);
        setRemoteUserName("");
        setRemoteLanguage(null);
        remoteLanguageRef.current = null;
        remoteStreamRef.current = null;
        setStatusMsg("Peer disconnected. Waiting for someone to join…");
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      }
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStreamRef.current);
        if (track.kind === "video") {
          const p = sender.getParameters();
          if (!p.encodings?.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = 8_000_000;
          p.encodings[0].maxFramerate = 60;
          sender.setParameters(p).catch(() => {});
        }
        if (track.kind === "audio") {
          const p = sender.getParameters();
          if (!p.encodings?.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = 256_000;
          sender.setParameters(p).catch(() => {});
        }
      });
    }

    pcRef.current = pc;
    return pc;
  }, []);

  const flushPendingCandidates = useCallback(async () => {
    if (pcRef.current?.remoteDescription) {
      for (const c of pendingCandidates.current) {
        try { await pcRef.current.addIceCandidate(new RTCIceCandidate(c)); }
        catch (e) { console.error(e); }
      }
      pendingCandidates.current = [];
    }
  }, []);

  // ─── Setup ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let active = true;

    const joinRoom = () => {
      if (!active || hasJoined.current) return;
      hasJoined.current = true;
      socket.emit("join-room", { roomId, userName, language });
      socket.emit("status-update", { isMuted: false, isCameraOff: false });
    };

    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920, max: 3840 }, height: { ideal: 1080, max: 2160 }, frameRate: { ideal: 60, max: 60 }, facingMode: "user" },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 2 },
        });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }

        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setStreamReady(true);

        socket.on("connect", joinRoom);

        socket.on("room-full", () => {
          alert("Room is full (max 2 participants).");
          navigate("/");
        });

        socket.on("room-joined", async ({ peers }) => {
          if (peers.length > 0) {
            const { socketId: remotePeerId, userName: remName, language: remLang } = peers[0];
            setRemoteUserName(remName);
            if (remLang) { setRemoteLanguage(remLang); remoteLanguageRef.current = remLang; }
            setStatusMsg("Connecting…");
            const pc = createPeerConnection(remotePeerId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("offer", { to: remotePeerId, offer });
          }
        });

        socket.on("user-joined", ({ userName: remName, language: remLang }) => {
          setRemoteUserName(remName);
          if (remLang) { setRemoteLanguage(remLang); remoteLanguageRef.current = remLang; }
          setStatusMsg(`${remName} is joining…`);
        });

        socket.on("offer", async ({ from, offer, userName: remName }) => {
          setRemoteUserName(remName);
          setStatusMsg("Connecting…");
          const pc = createPeerConnection(from);
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          await flushPendingCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("answer", { to: from, answer });
        });

        socket.on("answer", async ({ answer, userName: remName }) => {
          // The answerer's name arrives here for the joiner (who sent the offer)
          if (remName) setRemoteUserName(remName);
          if (pcRef.current) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
            await flushPendingCandidates();
          }
        });

        socket.on("ice-candidate", async ({ candidate }) => {
          if (pcRef.current?.remoteDescription) {
            try { await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)); }
            catch (e) { console.error(e); }
          } else {
            pendingCandidates.current.push(candidate);
          }
        });

        socket.on("user-left", () => {
          setIsRemoteConnected(false);
          setIsRemoteCameraOff(false);
          setIsRemoteMuted(false);
          setRemoteUserName("");
          setRemoteLanguage(null);
          remoteLanguageRef.current = null;
          remoteStreamRef.current = null;
          setStatusMsg("Peer disconnected. Waiting for someone to join…");
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
          pendingCandidates.current = [];
          hasJoined.current = false;
        });

        socket.on("peer-status", ({ isMuted: rm, isCameraOff: rc }) => {
          setIsRemoteMuted(rm);
          setIsRemoteCameraOff(rc);
        });

        socket.on("caption", ({ from, text, isSelf, needsVoice }) => {
          if (ccEnabledRef.current) {
            const id = Date.now() + Math.random();
            setCaptions((prev) => [...prev.slice(-2), { id, from, text, isSelf }]);
            captionTimers.current[id] = setTimeout(() => {
              setCaptions((prev) => prev.filter((c) => c.id !== id));
              delete captionTimers.current[id];
            }, 5000);
          }
          if (voiceTranslateRef.current && needsVoice && !isSelf && text?.trim()) {
            voiceTranslatorRef.current?.speak(text, languageRef.current);
          }
        });

        if (socket.connected) joinRoom();
        else socket.connect();

      } catch (err) {
        console.error("Media error:", err);
        setStatusMsg("Could not access camera/microphone. Please allow permissions and reload.");
      }
    };

    init();

    return () => {
      active = false;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      pcRef.current?.close(); pcRef.current = null;
      socket.off("connect", joinRoom);
      socket.off("room-full"); socket.off("room-joined"); socket.off("user-joined");
      socket.off("offer"); socket.off("answer"); socket.off("ice-candidate");
      socket.off("user-left"); socket.off("peer-status"); socket.off("caption");
      socket.disconnect();
      hasJoined.current = false;
      pendingCandidates.current = [];
      Object.values(captionTimers.current).forEach(clearTimeout);
      captionTimers.current = {};
      mobileCapturerRef.current?.stop();
      mobileCapturerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Speech Recognition (live captions — desktop only) ───────────────────
  // Android/iOS cannot share the mic between WebRTC and Web Speech API.

  useEffect(() => {
    if (isMobileDevice()) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !streamReady || isMuted || !speechActive) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
      // flush any buffered text immediately on mute/disable
      if (captionFlushRef.current) { clearTimeout(captionFlushRef.current); captionFlushRef.current = null; }
      if (captionBufferRef.current && socket.connected) {
        socket.emit("caption", { text: captionBufferRef.current.trim(), lang: language });
      }
      captionBufferRef.current = "";
      if (recWatchdogRef.current) { clearTimeout(recWatchdogRef.current); recWatchdogRef.current = null; }
      return;
    }

    const rec = new SR();
    rec.lang = language;
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    // ── Watchdog ────────────────────────────────────────────────────────────
    // Chrome (especially Android) sometimes stops recognition silently without
    // firing onend. If no activity for 12 s, force a stop → onend → restart.
    const resetWatchdog = () => {
      if (recWatchdogRef.current) clearTimeout(recWatchdogRef.current);
      recWatchdogRef.current = setTimeout(() => {
        if (recognitionRef.current === rec) {
          try { rec.stop(); } catch (_) {}      // triggers onend → restart
        }
      }, 12000);
    };

    // ── Debounce buffer ─────────────────────────────────────────────────────
    // Accumulate sentences for 1 s before emitting. Consecutive short phrases
    // (e.g. "yes", "okay", "and then") are merged into one API call, cutting
    // Gemini usage by ~3-5x compared to sending each sentence immediately.
    const flushCaptionBuffer = () => {
      const text = captionBufferRef.current.trim();
      if (text && socket.connected) {
        socket.emit("caption", { text, lang: language });
      }
      captionBufferRef.current = "";
      captionFlushRef.current  = null;
    };

    rec.onstart = () => { resetWatchdog(); };

    rec.onresult = (e) => {
      resetWatchdog();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (!text) continue;
          captionBufferRef.current += (captionBufferRef.current ? " " : "") + text;
          if (captionFlushRef.current) clearTimeout(captionFlushRef.current);
          captionFlushRef.current = setTimeout(flushCaptionBuffer, 1000);
        }
      }
    };

    // Restart with exponential backoff starting at 0 ms.
    // Desktop Chrome: rec.start() at 0 ms works fine every time.
    // Android Chrome: the engine may still be tearing down when onend fires,
    // causing an InvalidStateError at 0 ms. We catch that and retry at 150 ms,
    // then 300 ms, then 600 ms — whichever succeeds first. This eliminates the
    // fixed 500 ms dead zone that was producing the audible mic click on mobile.
    rec.onend = () => {
      if (recWatchdogRef.current) { clearTimeout(recWatchdogRef.current); recWatchdogRef.current = null; }
      if (recognitionRef.current !== rec) return;

      const tryRestart = (delayMs) => {
        setTimeout(() => {
          if (recognitionRef.current !== rec) return;
          try {
            rec.start();
          } catch (_) {
            if (delayMs < 600) tryRestart(delayMs === 0 ? 150 : delayMs * 2);
          }
        }, delayMs);
      };

      tryRestart(0);
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (["not-allowed", "service-not-allowed"].includes(e.error)) {
        console.warn("SpeechRecognition: microphone permission denied.");
        recognitionRef.current = null;
      } else {
        console.warn("SpeechRecognition error:", e.error);
      }
    };

    // Tab comes back into focus: Chrome mobile silently stops recognition while
    // backgrounded and may not fire onend until the tab is visible again.
    const onVisible = () => {
      if (!document.hidden && recognitionRef.current === rec) {
        try { rec.start(); } catch (_) {}
        resetWatchdog();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    recognitionRef.current = rec;
    try { rec.start(); } catch (e) { console.warn("SpeechRecognition start failed:", e); }

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (recWatchdogRef.current) { clearTimeout(recWatchdogRef.current); recWatchdogRef.current = null; }
      if (captionFlushRef.current) { clearTimeout(captionFlushRef.current); captionFlushRef.current = null; }
      captionBufferRef.current = "";
      recognitionRef.current = null;
      try { rec.stop(); } catch (_) {}
    };
  }, [streamReady, isMuted, speechActive, language]);

  // ─── Mobile captions via server-side STT (uses existing WebRTC audio track) ─

  useEffect(() => {
    if (!isMobileDevice()) return;

    if (!streamReady || isMuted || !speechActive) {
      mobileCapturerRef.current?.stop();
      mobileCapturerRef.current = null;
      return;
    }

    const stream = localStreamRef.current;
    if (!stream) return;

    const capturer = new MobileAudioCapturer({
      onChunk: (wavBuffer) => {
        if (!socket.connected) return;
        const blob = new Blob([wavBuffer], { type: "audio/wav" });
        const reader = new FileReader();
        reader.onload = () => {
          const audio = reader.result.split(",")[1];
          if (audio) socket.emit("caption-audio", { audio, lang: language });
        };
        reader.readAsDataURL(blob);
      },
    });

    mobileCapturerRef.current = capturer;
    capturer.start(stream);

    return () => {
      capturer.stop();
      if (mobileCapturerRef.current === capturer) mobileCapturerRef.current = null;
    };
  }, [streamReady, isMuted, speechActive, language]);

  // ─── Controls ─────────────────────────────────────────────────────────────

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const next = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setIsMuted(next);
    socket.emit("status-update", { isMuted: next, isCameraOff });
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    const next = !isCameraOff;
    localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = !next; });
    setIsCameraOff(next);
    socket.emit("status-update", { isMuted, isCameraOff: next });
  };

  const leaveCall = () => {
    voiceTranslatorRef.current?.cancel();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    socket.disconnect();
    navigate("/");
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const participantCount = 1 + (isRemoteConnected ? 1 : 0);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="room-container">

      {/* ── Header ── */}
      <div className="room-header">
        <div className="room-header-left">
          <div className="room-logo">
            <div className="room-logo-icon">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M15 10l4.553-2.277A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M4 8h11a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span>VideoCall</span>
          </div>

          {isRemoteConnected && (
            <>
              <div className="live-badge">
                <span className="live-dot" />
                <span>LIVE</span>
              </div>
              <span className="call-timer">{callTimer}</span>
            </>
          )}
        </div>

        <div className="room-header-right">
          <div className="participant-badge">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {participantCount}
          </div>

          <div className="room-id-badge">
            <span>{roomId}</span>
            <button className="copy-btn" onClick={copyRoomId}>
              {copied ? (
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M8 5a2 2 0 002 2h4a2 2 0 002-2M8 5a2 2 0 012-2h4a2 2 0 012 2m0 0h2a2 2 0 012 2v3"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              )}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Body (video + floating controls) ── */}
      <div className="room-body">

        <div className={`video-grid ${isRemoteConnected ? "two-up" : "one-up"}`}>

          {/* Remote */}
          {isRemoteConnected ? (
            <VideoPlayer
              videoRef={remoteVideoRef}
              label={remoteUserName || "Peer"}
              isLocal={false}
              isCameraOff={isRemoteCameraOff}
              isMicOff={isRemoteMuted}
              userName={remoteUserName || "Peer"}
              showConn
            />
          ) : (
            <div className="waiting-screen">
              <div className="waiting-icon-wrap">
                <div className="waiting-ring" />
                <div className="waiting-ring" />
                <div className="waiting-icon">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"
                      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
              <p className="waiting-text">{statusMsg}</p>
              <p className="share-hint">Invite someone by sharing the Room ID below.</p>
              <div className="room-id-share" onClick={copyRoomId} role="button" tabIndex={0} title="Click to copy">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M8 5a2 2 0 002 2h4a2 2 0 002-2M8 5a2 2 0 012-2h4a2 2 0 012 2m0 0h2a2 2 0 012 2v3"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                {roomId}
                <svg viewBox="0 0 24 24" fill="none" style={{marginLeft:"auto"}}>
                  {copied
                    ? <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    : <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                        stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  }
                </svg>
              </div>
            </div>
          )}

          {/* Local (always shown, PIP when in call) */}
          <VideoPlayer
            videoRef={localVideoRef}
            label={`${userName} (You)`}
            isLocal
            isMuted
            isCameraOff={isCameraOff}
            compact={isRemoteConnected}
            userName={userName}
          />

        </div>

        {/* ── Live Captions Overlay ── */}
        {ccEnabled && captions.length > 0 && (
          <div className="captions-overlay">
            {captions.map(c => (
              <div key={c.id} className={`caption-line ${c.isSelf ? "caption-self" : ""}`}>
                <span className="caption-speaker">{c.isSelf ? "You" : c.from}:</span>
                <span className="caption-text"> {c.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Floating Controls Bar ── */}
        <div className="controls-bar">

          <button className={`ctrl-btn ${isMuted ? "active" : ""}`} onClick={toggleMute}>
            {isMuted ? (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M1 1l22 22M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v3M8 23h8"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v3M8 23h8"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            <span>{isMuted ? "Unmute" : "Mute"}</span>
          </button>

          <button className={`ctrl-btn ${isCameraOff ? "active" : ""}`} onClick={toggleCamera}>
            {isCameraOff ? (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h2m5.66 0H14a2 2 0 012 2v3.34l1 1L23 7v10M1 1l22 22"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M15 10l4.553-2.277A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M4 8h11a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            <span>{isCameraOff ? "Start Vid" : "Stop Vid"}</span>
          </button>

          <button className={`ctrl-btn ${ccEnabled ? "active" : ""}`} onClick={() => setCcEnabled(v => !v)}>
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="2" y="6" width="20" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
              <path d="M7 13h2m2 0h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>CC</span>
          </button>

          <button
            className={`ctrl-btn ${voiceTranslateEnabled ? "active" : ""}`}
            onClick={() => {
              setVoiceTranslateEnabled((v) => {
                const next = !v;
                if (!next) voiceTranslatorRef.current?.cancel();
                return next;
              });
            }}
            title="Hear remote speech translated to your language (replaces original audio)"
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8M9 12h6"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M12 16v3M8 21h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>Translate</span>
          </button>

          <div className="ctrl-separator" />

          <button className="ctrl-btn leave-btn" onClick={leaveCall}>
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7 2 2 0 011.72 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.42 19.42 0 013.43 9.19 19.79 19.79 0 01.36 10.56 2 2 0 012 8.39V5.47a2 2 0 011.72-2 12.84 12.84 0 002.81.7 2 2 0 011.72 1.45c0 .27.13.53.2.8"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="23" y1="1" x2="1" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>Leave</span>
          </button>

        </div>
      </div>
    </div>
  );
}
