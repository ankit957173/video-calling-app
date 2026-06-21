/** Queued text-to-speech for real-time voice translation. */
export class VoiceTranslator {
  constructor({ lang, onSpeakStart, onSpeakEnd } = {}) {
    this.lang = lang;
    this.onSpeakStart = onSpeakStart;
    this.onSpeakEnd = onSpeakEnd;
    this.queue = [];
    this.speaking = false;
    this.voicesReady = false;
    this._voicesHandler = () => { this.voicesReady = true; };
    if (window.speechSynthesis) {
      window.speechSynthesis.addEventListener("voiceschanged", this._voicesHandler);
      if (window.speechSynthesis.getVoices().length) this.voicesReady = true;
    }
  }

  setLang(lang) {
    this.lang = lang;
  }

  _pickVoice(lang) {
    const voices = window.speechSynthesis?.getVoices() || [];
    const prefix = lang.split("-")[0];
    return (
      voices.find((v) => v.lang === lang) ||
      voices.find((v) => v.lang.startsWith(prefix)) ||
      voices.find((v) => v.lang.includes(prefix)) ||
      null
    );
  }

  speak(text, lang = this.lang) {
    if (!text?.trim() || !window.speechSynthesis) return;
    this.queue.push({ text: text.trim(), lang });
    this._processQueue();
  }

  _processQueue() {
    if (this.speaking || !this.queue.length) return;

    const { text, lang } = this.queue.shift();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    const voice = this._pickVoice(lang);
    if (voice) utter.voice = voice;
    utter.rate = 1.05;
    utter.pitch = 1;

    utter.onstart = () => {
      this.speaking = true;
      this.onSpeakStart?.();
    };
    utter.onend = () => {
      this.speaking = false;
      this.onSpeakEnd?.();
      this._processQueue();
    };
    utter.onerror = () => {
      this.speaking = false;
      this.onSpeakEnd?.();
      this._processQueue();
    };

    window.speechSynthesis.speak(utter);
  }

  cancel() {
    window.speechSynthesis?.cancel();
    this.queue = [];
    this.speaking = false;
    this.onSpeakEnd?.();
  }

  destroy() {
    this.cancel();
    if (window.speechSynthesis) {
      window.speechSynthesis.removeEventListener("voiceschanged", this._voicesHandler);
    }
  }
}
