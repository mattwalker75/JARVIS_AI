# Voice

Hands-free voice conversation, built on the browser-native **Web Speech API** —
free, offline, and best in **Chrome** (also works in Safari). Speech-to-text and
text-to-speech both run in the browser; JARVIS itself just gets text.

Implementation: `app/public/voice.js` (engine) + wiring in `app/public/app.js`.

## The controls

Open the UI at `http://localhost:8110` (a **secure context** — localhost or HTTPS is
required for the mic). Two independent things: whether JARVIS **speaks** its replies,
and how it **listens**.

| Control | Behavior |
| --- | --- |
| **🔊 Voice** | Toggles **spoken replies** (text-to-speech) on/off. Persists. |
| **🎤 Talk** | Push-to-talk — tap, speak one utterance, it's sent. **Enabled only when the mic is Off** (Wake/Open already listen, so it's disabled there). |
| Mic mode: **Off** | Mic disabled (use push-to-talk). |
| Mic mode: **Wake** | Continuous; say the wake word to start; sleeps after silence. |
| Mic mode: **Open** | Continuous; every utterance is sent — full hands-free. |

**Hands-free like ChatGPT:** set mic mode to **Open** (or **Wake**) and turn **🔊 Voice**
on — now you talk and it talks back. In any continuous mode, saying
**"<wake word> stop listening"** turns the mic off.

To interrupt while it's speaking (barge-in): **tap the mic**, press **Esc**, or click
**Stop**.

## The wake word

In **Wake** mode you start a turn by saying the wake word. It's **configurable** via
`voice.wake_word` in `JARVIS_CONFIG.json` (and the matching `voice.stop_phrase`); it
defaults to the `assistant_name` ("Jarvis"). The current wake word is shown in the mic
status ("say Jarvis") and updates if you change it.

## Ambient (orb) mode

Click **🌌 Ambient** in the header for a full-screen, hands-free view: the UI disappears
and JARVIS becomes a large glowing **orb** that animates with its state — so you can
lean back and just talk, without watching text. **✕ Exit** returns to the normal UI.

The orb's color + motion track what's happening:

| State | Look |
| --- | --- |
| **Idle** | Soft blue, slow breathing — "tap to talk". |
| **Listening** | Cyan, ripples to your **real voice amplitude** (via the mic). |
| **Thinking** | Purple, churning while the model reasons. |
| **Speaking** | Green, **animates continuously as it talks** (a synthesized speech envelope) with an extra pulse on each word. |

- **Tap the orb** to talk (push-to-talk) — which also interrupts it if it's speaking (barge-in).
- If a continuous mic mode (Wake/Open) is on, just talk — no tap needed.
- Entering ambient turns spoken replies on so it can talk back.

The per-word pulse comes from the browser's speech `boundary` events; the listening
ripple is real microphone amplitude (Web Audio). The one thing the browser won't allow
is reading the *waveform of the synthesized voice itself*, so "speaking" is word-synced
rather than amplitude-synced — but it reads as genuinely alive.

## Choosing the voice

Click the **🎚️** button (next to 🔊 Voice) for the voice-settings popover:

- **Voice** — a dropdown of the speech voices your OS/browser provides. Changing it
  plays a short sample immediately. ("Auto" picks a good English default.)
- **Speed** and **Pitch** sliders.
- **▶ Test voice** — hear the current settings any time (works even if Voice is muted).

All three persist to `JARVIS_CONFIG.json` (`voice.tts_voice`, `voice.tts_rate`,
`voice.tts_pitch`). The **available voices come from your Mac/Chrome** — macOS ships
several (Samantha, Alex, Daniel, Karen…), and you can install more (including premium
neural ones) under **System Settings → Accessibility → Spoken Content → System
Voice → Manage Voices**; they'll appear in the dropdown after a browser refresh.
Chrome also adds its own "Google …" voices.

## How speech output works (ChatGPT-style)

- **Streaming** — replies are spoken **sentence by sentence as they're generated**,
  not after the whole answer finishes. (With a local reasoning model you'll still hear
  nothing during the "thinking" phase, then speech begins as the answer streams.)
- **Queued** — sentences play in order and long replies never hit the browser's
  single-utterance length limit.
- **Cleaned** — code blocks, inline code, URLs, and importance markers are skipped, so
  it speaks the prose, not the punctuation and syntax.
- **Barge-in** — a new message, the Stop button, Esc, or tapping the mic instantly
  silences speech and resumes listening.

While JARVIS is speaking, the mic is **paused** (browser Web Speech has no echo
cancellation for continuous recognition, so otherwise it would hear itself). That
means you can't interrupt *by voice* mid-speech — use the mic tap / Esc / Stop.

## Configuration

In `JARVIS_CONFIG.json` under `voice` (see [Configuration](configuration.md#voice)):
`enabled`, `tts`, `stt`, `mic_mode`, `silence_timeout_seconds`, and optional
`wake_word` / `stop_phrase`. The mic mode and TTS toggle are also settable from the UI
and persist.

## Snappier voice

The main latency is the model "thinking" before it speaks. For a more responsive feel,
point the **chat** tier at a smaller/faster model with the header model switcher (or
`/model`), e.g. `qwen3:8b` — trivial now that everything routes through the gateway.

## Troubleshooting

- **No mic / permission denied** — allow the microphone for `localhost` in the browser,
  and check macOS System Settings → Privacy & Security → Microphone for your browser.
- **"needs a secure context"** — open `http://localhost:8110` (not a LAN IP), or use HTTPS.
- **No speech output** — check the 🔊 toggle and your system output; browser voices
  come from the OS.
