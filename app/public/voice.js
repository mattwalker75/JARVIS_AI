"use strict";
// Browser-native voice (Web Speech API). Microphone has three modes:
//   off  - mic disabled; use the push-to-talk button (listenOnce) to talk
//   wake - continuous; say the wake word ("jarvis") to start; sleeps after silence
//   open - continuous; always listening, every utterance is sent (no wake word)
// In any continuous mode, saying the stop phrase ("jarvis stop listening") turns
// the mic off. TTS speaks replies; the mic pauses while JARVIS talks. Errors are
// surfaced via handlers.onError so failures are never silent.
//
// Requires Chrome (best) or Safari and a secure context (http://localhost or https).
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let cfg = { wake_word: "jarvis", stop_phrase: "jarvis stop listening", silence_timeout_seconds: 12, tts: true, stt: true };
  let handlers = {};
  let recognition = null;   // continuous recognizer
  let oneShot = null;       // push-to-talk recognizer
  let listenMode = "off";   // off | wake | open
  let enabled = false;      // listenMode !== "off"
  let waking = "asleep";    // wake-mode sub-state: asleep | listening
  let speaking = false;
  let wantRunning = false;
  let silenceTimer = null;

  const setState = (s) => handlers.onState && handlers.onState(s);
  const reportError = (m) => handlers.onError && handlers.onError(m);

  // --- TTS voice selection ---
  let voices = [];
  function loadVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch (_) {} }
  if (window.speechSynthesis) { loadVoices(); window.speechSynthesis.onvoiceschanged = loadVoices; }
  const VOICE_PREFS = ["google us english", "samantha", "ava", "allison", "microsoft aria", "microsoft jenny", "daniel", "karen", "serena"];
  function pickVoice() {
    if (!voices.length) loadVoices();
    const want = (cfg.tts_voice || "").toLowerCase();
    if (want) { const v = voices.find((x) => x.name.toLowerCase().includes(want)); if (v) return v; }
    for (const p of VOICE_PREFS) { const v = voices.find((x) => x.name.toLowerCase().includes(p)); if (v) return v; }
    return voices.find((x) => /en[-_]/i.test(x.lang)) || voices[0] || null;
  }

  function supportInfo() {
    if (!SR) return { ok: false, msg: "This browser has no Speech Recognition API. Use Google Chrome (recommended) or Safari." };
    if (!window.isSecureContext) return { ok: false, msg: "Microphone needs a secure context. Open JARVIS at http://localhost:8110 (not a LAN IP), or use HTTPS." };
    return { ok: true };
  }
  function describeError(code) {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return "Microphone permission denied. Allow mic access for this site, and check macOS System Settings → Privacy & Security → Microphone for your browser.";
      case "audio-capture": return "No microphone was found or it isn't accessible.";
      case "network": return "The browser's speech service is unreachable (network error).";
      default: return null;
    }
  }
  function handleError(code) {
    const msg = describeError(code);
    if (!msg) return;
    reportError(msg);
    if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") setMode("off");
  }
  async function ensureMicPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "SecurityError")
        reportError("Microphone access is blocked. Click the site-info (lock) or mic icon in the address bar and ALLOW the microphone for localhost, then check macOS System Settings → Privacy & Security → Microphone for your browser.");
      else if (e.name === "NotFoundError" || e.name === "OverconstrainedError")
        reportError("No microphone was found on this Mac.");
      else reportError("Microphone error: " + e.name + (e.message ? " — " + e.message : ""));
      return false;
    }
  }

  function startRecognition() {
    if (!SR || recognition || !wantRunning) return;
    recognition = new SR();
    recognition.lang = "en-US"; recognition.continuous = true; recognition.interimResults = true;
    recognition.onresult = onResult;
    recognition.onerror = (e) => handleError(e.error);
    recognition.onend = () => { recognition = null; if (wantRunning && !speaking) setTimeout(startRecognition, 250); };
    try { recognition.start(); } catch (_) {}
  }
  function stopRecognition() { wantRunning = false; if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; } }

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { if (listenMode === "wake" && waking === "listening") { waking = "asleep"; setState("asleep"); } },
      (cfg.silence_timeout_seconds || 12) * 1000);
  }

  function onResult(ev) {
    let finalText = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
    const text = finalText.trim();
    if (!text) return;
    const low = text.toLowerCase();
    if (low.includes(cfg.stop_phrase)) { setMode("off"); return; }

    if (listenMode === "open") {
      let utter = text;
      if (low.startsWith(cfg.wake_word)) utter = text.slice(cfg.wake_word.length).replace(/^[\s,.!?]+/, "").trim();
      if (utter && low !== cfg.wake_word) handlers.onUtterance && handlers.onUtterance(utter);
      return;
    }
    // wake mode
    if (waking === "asleep") {
      const idx = low.indexOf(cfg.wake_word);
      if (idx !== -1) {
        waking = "listening"; setState("listening"); armSilence();
        const after = text.slice(idx + cfg.wake_word.length).replace(/^[\s,.!?]+/, "").trim();
        if (after) handlers.onUtterance && handlers.onUtterance(after);
      }
      return;
    }
    armSilence();
    if (low === cfg.wake_word) return;
    let utter = text;
    if (low.startsWith(cfg.wake_word)) utter = text.slice(cfg.wake_word.length).replace(/^[\s,.!?]+/, "").trim();
    if (utter) handlers.onUtterance && handlers.onUtterance(utter);
  }

  // mode: "off" | "wake" | "open"
  async function setMode(m) {
    clearTimeout(silenceTimer);
    if (m === "off") { listenMode = "off"; enabled = false; stopRecognition(); setState("off"); return true; }
    const s = supportInfo();
    if (!s.ok) { reportError(s.msg); listenMode = "off"; enabled = false; setState("unsupported"); return false; }
    if (!(await ensureMicPermission())) { listenMode = "off"; enabled = false; setState("off"); return false; }
    listenMode = m; enabled = true; wantRunning = cfg.stt !== false;
    if (m === "wake") { waking = "asleep"; if (wantRunning) startRecognition(); setState("asleep"); }
    else { waking = "listening"; if (wantRunning) startRecognition(); setState("open"); }
    return true;
  }

  async function listenOnce() {
    const s = supportInfo();
    if (!s.ok) { reportError(s.msg); setState("unsupported"); return; }
    stopSpeaking();   // tapping the mic while JARVIS is talking interrupts it (barge-in)
    if (oneShot) { try { oneShot.stop(); } catch (_) {} return; }
    if (!(await ensureMicPermission())) return;
    const resume = wantRunning;
    if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
    const r = new SR();
    r.lang = "en-US"; r.continuous = false; r.interimResults = false;
    oneShot = r; setState("listening");
    r.onresult = (ev) => { const t = (ev.results[0][0].transcript || "").trim(); if (t) handlers.onUtterance && handlers.onUtterance(t); };
    r.onerror = (e) => handleError(e.error);
    r.onend = () => {
      oneShot = null;
      setState(listenMode === "off" ? "off" : listenMode === "open" ? "open" : (waking === "listening" ? "listening" : "asleep"));
      if (resume && enabled && !speaking) { wantRunning = true; startRecognition(); }
    };
    try { r.start(); } catch (e) { oneShot = null; reportError("Could not start the microphone: " + e.message); }
  }

  // --- TTS: a QUEUE so streamed sentences speak in order (like ChatGPT — you hear the
  // answer as it's generated), the browser never truncates a long utterance, and the
  // whole thing can be interrupted (barge-in) via stopSpeaking(). ---
  let ttsQueue = [];
  let resumeAfterTts = false;

  function cleanForSpeech(text) {
    return String(text || "")
      .replace(/\[importance:\s*\w+\]/gi, " ")
      .replace(/```[\s\S]*?```/g, " (code block) ")   // complete fenced code — don't read aloud
      .replace(/```[\s\S]*$/g, " (code) ")            // a still-streaming/unterminated fence
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\bhttps?:\/\/\S+/g, " link ")
      .replace(/[*_#>~|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function ttsNext() {
    if (!ttsQueue.length) {
      if (speaking && handlers.onSpeak) { try { handlers.onSpeak(false); } catch (_) {} }
      speaking = false;
      if (enabled && resumeAfterTts) { resumeAfterTts = false; wantRunning = true; startRecognition(); }
      return;
    }
    if (!speaking && handlers.onSpeak) { try { handlers.onSpeak(true); } catch (_) {} }
    speaking = true;
    const u = new SpeechSynthesisUtterance(ttsQueue.shift());
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = cfg.tts_rate || 1.0; u.pitch = cfg.tts_pitch || 1.0;
    u.onboundary = () => { if (handlers.onBoundary) { try { handlers.onBoundary(); } catch (_) {} } };  // per-word pulse
    u.onend = () => setTimeout(ttsNext, 0);
    u.onerror = () => setTimeout(ttsNext, 0);
    try { window.speechSynthesis.speak(u); } catch (_) { setTimeout(ttsNext, 0); }
  }
  // Speak text — queued and split into sentence-sized chunks. Call it repeatedly with
  // streamed fragments; each completed sentence plays as soon as it arrives.
  function speak(text) {
    if (!cfg.tts || !window.speechSynthesis) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    if (!speaking && ttsQueue.length === 0) {   // first chunk of a turn: pause the mic so we don't hear ourselves
      if (wantRunning) resumeAfterTts = true;
      if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
    }
    const pieces = clean.match(/[^.!?\n]+[.!?\n]+|\S[^.!?\n]*$/g) || [clean];
    for (const p of pieces) { const s = p.trim(); if (s) ttsQueue.push(s); }
    if (!speaking) ttsNext();
  }
  // Barge-in: stop talking immediately, drop the queue, resume listening.
  function stopSpeaking() {
    const was = speaking || ttsQueue.length > 0;
    ttsQueue = [];
    try { window.speechSynthesis.cancel(); } catch (_) {}
    if (was && handlers.onSpeak) { try { handlers.onSpeak(false); } catch (_) {} }
    speaking = false;
    if (enabled && (resumeAfterTts || was)) { resumeAfterTts = false; wantRunning = true; startRecognition(); }
  }

  function setTts(on) { cfg.tts = !!on; if (!on) stopSpeaking(); }

  window.JarvisVoice = {
    init(c, h) { cfg = Object.assign(cfg, c || {}); handlers = h || {}; return supportInfo().ok; },
    setMode, listenOnce, speak, stopSpeaking, setTts,
    supported: () => supportInfo().ok,
    supportMessage: () => supportInfo().msg || "",
    mode: () => listenMode,
    ttsEnabled: () => cfg.tts !== false,
  };
})();
