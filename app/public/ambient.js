"use strict";
// Ambient voice mode: a full-screen glowing orb that IS JARVIS — breathes when idle,
// ripples to your voice when listening (real mic amplitude), churns while thinking, and
// pulses per spoken word while it talks (driven by SpeechSynthesis boundary events).
// A hands-free "just talk to it, don't watch the text" view. Enter/exit with a button.
//
// API (called from app.js):
//   JarvisAmbient.toggle() / enter() / exit()
//   JarvisAmbient.setState("idle"|"listening"|"thinking"|"speaking")
//   JarvisAmbient.pulse()        // bump the orb (per spoken word)
//   JarvisAmbient.active()
//   JarvisAmbient.onTap(fn)      // canvas tap → talk / barge-in
(function () {
  let overlay, canvas, ctx, raf, tapFn = null;
  let micStream = null, analyser = null, dataArr = null, audioCtx = null;
  let state = "idle", energy = 0, pulseE = 0, t = 0, active = false;
  let extLevel = 0, extLevelFrames = 0;   // real amplitude of the AI's own voice (Piper engine)
  let style = "face";                     // "face" (expressive) | "orb" (pulsating) — switchable
  let styleFn = null, styleBtn = null;    // persist callback + the in-overlay toggle button
  let mouthOpen = 0, eyeOpenCur = 1, lookX = 0, lookY = 0, nextBlink = 3, blinkStart = -10;

  const COLORS = {
    idle:      [96, 148, 190],
    listening: [54, 211, 255],
    thinking:  [176, 132, 255],
    speaking:  [72, 222, 176],
  };
  const CAPTION = { idle: "Tap to talk", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…" };

  function build() {
    overlay = document.createElement("div");
    overlay.id = "ambient";
    overlay.innerHTML =
      '<canvas id="ambient-canvas"></canvas>' +
      '<div class="ambient-caption" id="ambient-caption"></div>' +
      '<button class="ambient-style" id="ambient-style" title="Switch between the face and the orb"></button>' +
      '<button class="ambient-exit" id="ambient-exit" title="Exit ambient mode">✕ Exit</button>';
    document.body.appendChild(overlay);
    canvas = overlay.querySelector("#ambient-canvas");
    ctx = canvas.getContext("2d");
    overlay.querySelector("#ambient-exit").addEventListener("click", (e) => { e.stopPropagation(); exit(); });
    styleBtn = overlay.querySelector("#ambient-style");
    styleBtn.addEventListener("click", (e) => { e.stopPropagation(); setStyle(style === "face" ? "orb" : "face"); if (styleFn) styleFn(style); });
    refreshStyleBtn();
    canvas.addEventListener("click", () => { if (tapFn) tapFn(); });
    resize();
    window.addEventListener("resize", resize);
  }
  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function micLevel() {
    if (!analyser) return (Math.sin(t * 2) * 0.5 + 0.5) * 0.15;   // gentle fallback
    analyser.getByteFrequencyData(dataArr);
    let s = 0; for (let i = 0; i < dataArr.length; i++) s += dataArr[i];
    return Math.min(1, (s / dataArr.length) / 110);
  }

  function render() {
    t += 1 / 60;

    // Shared speaking amplitude (0..1). Piper gives the AI's REAL voice amplitude; the
    // browser engine has no waveform, so synthesize a syllable-rate envelope + word pulses.
    // Decrement the Piper freshness counter ONCE per frame here (both renderers read it).
    let amp = 0;
    if (state === "speaking") {
      if (extLevelFrames > 0) { extLevelFrames--; amp = Math.min(1, extLevel * 1.15); }
      else {
        const env = 0.5 * Math.abs(Math.sin(t * 10.5)) + 0.3 * Math.abs(Math.sin(t * 6.1 + 1.1)) + 0.2 * Math.abs(Math.sin(t * 15.7 + 0.5));
        amp = Math.min(1, 0.3 + env * 0.5);
      }
      amp = Math.min(1, amp + pulseE);
    }

    // Energy: drives the orb's size/wobble; a gentle fraction drives the face's head.
    let target = 0.14, smooth = 0.16;
    if (state === "listening") target = 0.18 + micLevel() * 0.85;
    else if (state === "thinking") target = 0.34 + Math.sin(t * 3.1) * 0.12 + Math.sin(t * 7) * 0.05;
    else if (state === "speaking") { target = 0.22 + amp; smooth = 0.32; }
    if (state === "idle") target += Math.sin(t * 1.1) * 0.05;
    energy += (target - energy) * smooth;
    pulseE *= 0.87;

    // Face: the mouth lip-syncs to `amp` (only when SPEAKING — the face is JARVIS, so the
    // user's mic level must not move it). Fast attack, slower release = natural speech.
    const mTarget = state === "speaking" ? Math.max(0, Math.min(1, 0.12 + amp * 0.9)) : 0;
    mouthOpen += (mTarget - mouthOpen) * (mTarget > mouthOpen ? 0.55 : 0.3);
    // Blink every few seconds (open -> shut -> open over ~0.16s).
    if (t >= nextBlink) { blinkStart = t; nextBlink = t + 2.4 + Math.random() * 4; }
    const bt = t - blinkStart;
    let eyeOpen = (bt >= 0 && bt < 0.16) ? Math.abs(Math.cos((bt / 0.16) * Math.PI)) : 1;
    if (state === "listening") eyeOpen = Math.min(1.15, eyeOpen * 1.12);   // wide, attentive
    eyeOpenCur += (eyeOpen - eyeOpenCur) * 0.5;
    // Gaze: eyes wander while thinking, recenter otherwise.
    const gx = state === "thinking" ? Math.sin(t * 1.7) : 0;
    const gy = state === "thinking" ? -0.6 + Math.sin(t * 0.9) * 0.3 : 0;
    lookX += (gx - lookX) * 0.07; lookY += (gy - lookY) * 0.07;

    const w = window.innerWidth, h = window.innerHeight, cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    const [cr, cg, cb] = COLORS[state] || COLORS.idle;
    if (style === "orb") drawOrb(w, h, cx, cy, cr, cg, cb);
    else drawFace(w, h, cx, cy, cr, cg, cb);

    raf = requestAnimationFrame(render);
  }

  function drawEllipse(x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawOrb(w, h, cx, cy, cr, cg, cb) {
    const base = Math.min(w, h) * 0.16;
    const r = base * (1 + energy * 0.55);
    const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.6);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},0.55)`);
    g.addColorStop(0.35, `rgba(${cr},${cg},${cb},0.22)`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2); ctx.fill();

    const spk = state === "speaking" ? 1 : 0;
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.001; a += 0.1) {
      const wob = 1
        + Math.sin(a * 3 + t * 2) * 0.03 * (1 + energy)
        + Math.sin(a * 5 - t * 1.6) * 0.022 * energy
        + Math.sin(a * 8 + t * 3) * (0.012 + spk * 0.02) * (energy + spk * 0.3)
        + spk * Math.sin(a * 6 - t * 9) * 0.022 * (0.4 + pulseE);
      const rr = r * wob;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    body.addColorStop(0, "rgba(255,255,255,0.95)");
    body.addColorStop(0.5, `rgba(${cr},${cg},${cb},0.95)`);
    body.addColorStop(1, `rgba(${(cr * 0.45) | 0},${(cg * 0.45) | 0},${(cb * 0.6) | 0},0.92)`);
    ctx.fillStyle = body; ctx.fill();
  }

  // A glowing, expressive face: same ethereal look as the orb (soft glow + luminous head),
  // but with blinking eyes, a wandering gaze, and a mouth that lip-syncs to the voice.
  function drawFace(w, h, cx, cy, cr, cg, cb) {
    const R = Math.min(w, h) * 0.2 * (1 + energy * 0.12);   // steady head (not a pulsing orb)

    const g = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 2.3);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},0.5)`);
    g.addColorStop(0.4, `rgba(${cr},${cg},${cb},0.15)`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 2.3, 0, Math.PI * 2); ctx.fill();

    const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.32, R * 0.15, cx, cy, R);
    body.addColorStop(0, "rgba(255,255,255,0.94)");
    body.addColorStop(0.55, `rgba(${cr},${cg},${cb},0.95)`);
    body.addColorStop(1, `rgba(${(cr * 0.45) | 0},${(cg * 0.45) | 0},${(cb * 0.6) | 0},0.95)`);
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    const ink = "rgba(16,22,36,0.9)";
    // Eyes (dark luminescent ovals; shift with gaze, squash on blink, small glint).
    const eyeDX = R * 0.4, eyeDY = R * 0.16, ew = R * 0.14, eh = R * 0.2 * Math.max(0.06, eyeOpenCur);
    for (const s of [-1, 1]) {
      const exx = cx + s * eyeDX + lookX * R * 0.05;
      const eyy = cy - eyeDY + lookY * R * 0.05;
      ctx.fillStyle = ink; drawEllipse(exx, eyy, ew, eh);
      if (eyeOpenCur > 0.5) { ctx.fillStyle = "rgba(255,255,255,0.8)"; drawEllipse(exx - ew * 0.3, eyy - eh * 0.35, ew * 0.28, ew * 0.28); }
    }
    // Mouth: open + lip-sync while speaking; a gentle closed curve otherwise.
    const my = cy + R * 0.44, mw = R * 0.44;
    if (state === "speaking" && mouthOpen > 0.05) {
      const mh = R * (0.04 + mouthOpen * 0.34);
      ctx.fillStyle = ink; drawEllipse(cx, my, mw * (0.62 + mouthOpen * 0.3), mh);
      ctx.fillStyle = "rgba(8,11,18,0.92)"; drawEllipse(cx, my + mh * 0.12, mw * (0.45 + mouthOpen * 0.25), mh * 0.66);
    } else {
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(2.5, R * 0.035); ctx.lineCap = "round";
      const curve = state === "thinking" ? 0.0 : 0.13;   // neutral while thinking, else a soft smile
      ctx.beginPath();
      ctx.moveTo(cx - mw * 0.5, my);
      ctx.quadraticCurveTo(cx, my + R * curve, cx + mw * 0.5, my);
      ctx.stroke();
    }
  }

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.7;
      dataArr = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
    } catch (_) { analyser = null; }   // graceful: fall back to a gentle animation
  }
  function stopMic() {
    if (micStream) { micStream.getTracks().forEach((tr) => tr.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    analyser = null;
  }

  function setState(s) {
    if (!(s in COLORS)) s = "idle";
    state = s;
    const cap = overlay && overlay.querySelector("#ambient-caption");
    if (cap) cap.textContent = CAPTION[s] || "";
  }

  // The toggle button shows the style you'll switch TO (so its label is the alternative).
  function refreshStyleBtn() { if (styleBtn) styleBtn.textContent = style === "face" ? "◍ Orb" : "☺ Face"; }
  function setStyle(s) { style = s === "orb" ? "orb" : "face"; refreshStyleBtn(); }

  function enter() {
    if (active) return;
    if (!overlay) build();
    active = true;
    overlay.classList.add("on");
    document.body.classList.add("ambient-on");
    startMic();
    setState(state);
    render();
  }
  function exit() {
    if (!active) return;
    active = false;
    overlay.classList.remove("on");
    document.body.classList.remove("ambient-on");
    cancelAnimationFrame(raf);
    stopMic();
  }

  window.JarvisAmbient = {
    enter, exit, toggle: () => (active ? exit() : enter()),
    setState, pulse: () => { pulseE = Math.min(0.9, pulseE + 0.4); },
    // Real spoken-voice amplitude (0..1) from the Piper engine — makes "speaking" truly
    // amplitude-reactive. Stays "fresh" for a few frames so a dropped update just decays.
    setLevel: (x) => { extLevel = Math.max(0, Math.min(1, x || 0)); extLevelFrames = 10; },
    active: () => active,
    onTap: (fn) => { tapFn = fn; },
    setStyle, style: () => style,
    onStyleChange: (fn) => { styleFn = fn; },
  };
})();
