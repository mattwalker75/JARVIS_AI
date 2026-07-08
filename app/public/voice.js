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
  let cfg = { wake_word: "jarvis", stop_phrase: "jarvis stop listening", silence_timeout_seconds: 12, followup_seconds: 0, tts: true, stt: true };
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

  // Schedule the wake-mode "go back to sleep" transition after `seconds` of no input.
  function scheduleSleep(seconds) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { if (listenMode === "wake" && waking === "listening") { waking = "asleep"; setState("asleep"); } },
      Math.max(0, seconds) * 1000);
  }
  function clearSleep() { clearTimeout(silenceTimer); }
  function armSilence() { scheduleSleep(cfg.silence_timeout_seconds || 12); }
  // True when the conversational follow-up window is active: Wake mode + a configured
  // window + spoken replies on (the window is anchored to the AI finishing speaking).
  function followupOn() { return listenMode === "wake" && (Number(cfg.followup_seconds) || 0) > 0 && cfg.tts !== false; }
  // Called right after we hand the user's turn to the app. If follow-up is on we DON'T
  // count down now — the window (re)opens when the AI stops talking (see finishSpeaking).
  // Otherwise fall back to the classic silence timeout.
  function afterUserTurn() { if (followupOn()) clearSleep(); else armSilence(); }

  function onResult(ev) {
    let finalText = "", anySpeech = false;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const alt = ev.results[i][0];
      if (alt && alt.transcript && alt.transcript.trim()) anySpeech = true;   // interim OR final
      if (ev.results[i].isFinal) finalText += alt.transcript;
    }
    // You've STARTED talking — stop the short follow-up countdown so it can't cut you off
    // mid-sentence. Re-arm to the generous "engaged" timeout; your final utterance (below)
    // then decides what happens next. This also self-recovers from stray noise/no-final.
    if (anySpeech && listenMode === "wake" && waking === "listening") armSilence();
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
        waking = "listening"; setState("listening");
        const after = text.slice(idx + cfg.wake_word.length).replace(/^[\s,.!?]+/, "").trim();
        if (after) { handlers.onUtterance && handlers.onUtterance(after); afterUserTurn(); }
        else armSilence();   // just the wake word — wait for them to actually speak
      }
      return;
    }
    // already awake (freshly woken, or inside a follow-up window): wake word optional
    if (low === cfg.wake_word) { armSilence(); return; }
    let utter = text;
    if (low.startsWith(cfg.wake_word)) utter = text.slice(cfg.wake_word.length).replace(/^[\s,.!?]+/, "").trim();
    if (utter) { handlers.onUtterance && handlers.onUtterance(utter); afterUserTurn(); }
    else armSilence();
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

  // Emoji + pictographs: keep them in the on-screen text (they're great for tone), but
  // never speak them — otherwise the voice reads "🎉" as nothing useful / an odd pause.
  // Covers pictographs, flags (regional indicators), skin-tone modifiers, variation
  // selectors, ZWJ, and keycaps.
  const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;
  function cleanForSpeech(text) {
    return String(text || "")
      .replace(/\[importance:\s*\w+\]/gi, " ")
      .replace(/```[\s\S]*?```/g, " (code block) ")   // complete fenced code — don't read aloud
      .replace(/```[\s\S]*$/g, " (code) ")            // a still-streaming/unterminated fence
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\bhttps?:\/\/\S+/g, " link ")
      .replace(EMOJI_RE, " ")                         // strip emojis/pictographs from speech
      .replace(/[*_#>~|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPiper() { return cfg.tts_engine === "piper"; }

  // Shared "turn ended" cleanup for both engines: tell the orb we stopped, drop the
  // level meter, and resume listening if the mic was paused for us.
  function finishSpeaking() {
    const wasSpeaking = speaking;
    if (speaking && handlers.onSpeak) { try { handlers.onSpeak(false); } catch (_) {} }
    speaking = false;
    stopLevelLoop();
    if (handlers.onLevel) { try { handlers.onLevel(0); } catch (_) {} }
    if (enabled && resumeAfterTts) { resumeAfterTts = false; wantRunning = true; startRecognition(); }
    // Conversational follow-up: after the AI stops talking, keep the mic awake in Wake
    // mode for cfg.followup_seconds so you can reply WITHOUT the wake word — the window
    // starts now (end of speech), not when you last spoke. Say the wake word again after
    // it lapses. Makes Wake mode a natural back-and-forth instead of "name every turn".
    if (wasSpeaking && followupOn()) {
      waking = "listening"; setState("listening");
      if (wantRunning) startRecognition();
      scheduleSleep(Number(cfg.followup_seconds) || 0);
    }
  }

  // ---- Browser engine (Web Speech API SpeechSynthesis) ----
  function browserNext() {
    if (!ttsQueue.length) return finishSpeaking();
    if (!speaking && handlers.onSpeak) { try { handlers.onSpeak(true); } catch (_) {} }
    speaking = true;
    const u = new SpeechSynthesisUtterance(ttsQueue.shift());
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = cfg.tts_rate || 1.0; u.pitch = cfg.tts_pitch || 1.0;
    u.onboundary = () => { if (handlers.onBoundary) { try { handlers.onBoundary(); } catch (_) {} } };  // per-word pulse
    u.onend = () => setTimeout(browserNext, 0);
    u.onerror = () => setTimeout(browserNext, 0);
    try { window.speechSynthesis.speak(u); } catch (_) { setTimeout(browserNext, 0); }
  }

  // ---- Piper engine (neural, synthesized server-side, played via Web Audio) ----
  // Web Audio (rather than a plain <audio>) so we can read the REAL amplitude of the
  // spoken audio and drive the ambient orb with it. Sentences are prefetched one ahead
  // so playback is gapless despite the network round-trip.
  let audioCtx = null, analyser = null, levelData = null, curSource = null, levelRAF = null, prefetch = null;
  function ensureCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.75;
      levelData = new Uint8Array(analyser.frequencyBinCount);
      analyser.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (_) {} }
    return audioCtx;
  }
  async function fetchPiper(text) {
    const r = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: cfg.tts_voice || "", rate: cfg.tts_rate || 1.0 }),
    });
    if (!r.ok) throw new Error("tts " + r.status);
    const buf = await r.arrayBuffer();
    return await new Promise((res, rej) => audioCtx.decodeAudioData(buf, res, rej));
  }
  function stopLevelLoop() { if (levelRAF) { cancelAnimationFrame(levelRAF); levelRAF = null; } }
  function levelLoop() {
    if (!curSource || !analyser) { levelRAF = null; return; }
    analyser.getByteTimeDomainData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i++) { const v = (levelData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / levelData.length);
    if (handlers.onLevel) { try { handlers.onLevel(Math.min(1, rms * 2.4)); } catch (_) {} }
    levelRAF = requestAnimationFrame(levelLoop);
  }
  async function piperNext() {
    if (!ttsQueue.length) return finishSpeaking();
    if (!ensureCtx()) return finishSpeaking();   // no Web Audio → can't play piper
    if (!speaking && handlers.onSpeak) { try { handlers.onSpeak(true); } catch (_) {} }
    speaking = true;
    const text = ttsQueue.shift();
    let decoded = null;
    try { decoded = (prefetch && prefetch.text === text) ? await prefetch.p : await fetchPiper(text); }
    catch (_) { decoded = null; }
    // Kick off the next sentence's fetch while this one plays (gapless).
    prefetch = ttsQueue.length ? { text: ttsQueue[0], p: fetchPiper(ttsQueue[0]).catch(() => null) } : null;
    if (!decoded) return setTimeout(piperNext, 0);   // skip a sentence that failed to synth
    const src = audioCtx.createBufferSource();
    src.buffer = decoded; src.connect(analyser);
    curSource = src;
    if (!levelRAF) levelRAF = requestAnimationFrame(levelLoop);
    src.onended = () => { if (curSource === src) curSource = null; setTimeout(piperNext, 0); };
    try { src.start(); } catch (_) { curSource = null; setTimeout(piperNext, 0); }
  }

  function ttsNext() { return isPiper() ? piperNext() : browserNext(); }

  // Speak text — queued and split into sentence-sized chunks. Call it repeatedly with
  // streamed fragments; each completed sentence plays as soon as it arrives.
  function speak(text) {
    if (!cfg.tts) return;
    if (!isPiper() && !window.speechSynthesis) return;
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
    ttsQueue = []; prefetch = null;
    try { window.speechSynthesis.cancel(); } catch (_) {}
    if (curSource) { try { curSource.onended = null; curSource.stop(); } catch (_) {} curSource = null; }
    stopLevelLoop();
    if (handlers.onLevel) { try { handlers.onLevel(0); } catch (_) {} }
    if (was && handlers.onSpeak) { try { handlers.onSpeak(false); } catch (_) {} }
    speaking = false;
    if (enabled && (resumeAfterTts || was)) { resumeAfterTts = false; wantRunning = true; startRecognition(); }
  }

  function setTts(on) { cfg.tts = !!on; if (!on) stopSpeaking(); else if (isPiper()) ensureCtx(); }
  function setEngine(e) { cfg.tts_engine = e === "piper" ? "piper" : "browser"; if (isPiper()) ensureCtx(); }
  function setVoice(name) { cfg.tts_voice = name || ""; }
  function setRate(r) { cfg.tts_rate = Math.min(2, Math.max(0.5, Number(r) || 1)); }
  function setPitch(p) { cfg.tts_pitch = Math.min(2, Math.max(0.5, Number(p) || 1)); }
  function listVoices() { if (!voices.length) loadVoices(); return voices.map((v) => ({ name: v.name, lang: v.lang, default: !!v.default })); }
  // Speak a one-off sample in the CURRENT engine/voice/rate, even if TTS is muted (preview).
  function test(sample) {
    const txt = sample || "Hi, this is how I sound.";
    if (isPiper()) {
      if (!ensureCtx()) return;
      fetchPiper(txt).then((buf) => {
        const src = audioCtx.createBufferSource();
        src.buffer = buf; src.connect(audioCtx.destination); src.start();
      }).catch(() => {});
      return;
    }
    if (!window.speechSynthesis) return;
    try { window.speechSynthesis.cancel(); } catch (_) {}
    const u = new SpeechSynthesisUtterance(txt);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = cfg.tts_rate || 1.0; u.pitch = cfg.tts_pitch || 1.0;
    try { window.speechSynthesis.speak(u); } catch (_) {}
  }

  window.JarvisVoice = {
    init(c, h) { cfg = Object.assign(cfg, c || {}); handlers = h || {}; return supportInfo().ok; },
    setMode, listenOnce, speak, stopSpeaking, setTts, setEngine, setVoice, setRate, setPitch, listVoices, test,
    supported: () => supportInfo().ok,
    supportMessage: () => supportInfo().msg || "",
    mode: () => listenMode,
    engine: () => (cfg.tts_engine === "piper" ? "piper" : "browser"),
    ttsEnabled: () => cfg.tts !== false,
  };
})();
