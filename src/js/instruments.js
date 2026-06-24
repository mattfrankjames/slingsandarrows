/**
 * instruments.js — Web Audio + Web MIDI synthesizer
 *
 * Features:
 *  - Polyphonic ADSR synth via Web Audio API
 *  - Computer keyboard input (Z-M white keys, S D G H J black keys)
 *  - On-screen clickable/touchable keyboard
 *  - Web MIDI API input (auto-connects all available inputs)
 *  - Octave shifting (up/down arrows or on-screen buttons)
 *  - Live ADSR / waveform / volume controls
 *
 * ─── iOS Safari AudioContext — the definitive explanation ────────────────────
 *
 * iOS Safari enforces a strict rule: AudioContext.resume() MUST be called
 * synchronously and directly within a trusted user-gesture handler (touchstart,
 * pointerdown, click). "Synchronously" means on the same call-stack frame as
 * the event — the moment you `await` anything before calling resume(), you have
 * yielded execution, left the trusted-gesture context, and iOS will silently
 * refuse to un-suspend the audio hardware. The Promise returned by resume()
 * will resolve (no error is thrown), but the context state stays 'suspended'.
 *
 * All previous fix attempts broke this rule:
 *
 *   Attempt 1 — document-level touchstart → resume() fire-and-forget, then
 *     noteOn() from pointerdown: two separate event handlers, resume() and
 *     noteOn() ran in different call stacks.
 *
 *   Attempt 2 — noteOn() made async, awaits getRunningAudioContext() which
 *     awaits resume(): the `await noteOn(...)` in the touchstart handler
 *     yields the call stack before resume() is even called. By the time
 *     resume() runs the trusted-gesture context is gone.
 *
 * The correct fix has two parts:
 *
 *   A. Call AudioContext constructor AND resume() SYNCHRONOUSLY in the same
 *      touchstart handler that will later call noteOn(). No awaits before
 *      either of these calls.
 *
 *   B. Schedule the actual audio-node work (noteOn) to run AFTER resume()
 *      resolves by chaining .then() on the resume() Promise. This keeps
 *      audio-node creation off the suspended context while still being
 *      triggered by the same gesture.
 *
 * The pattern used in buildKeyboard() for touch devices is therefore:
 *
 *   touchstart handler (synchronous, trusted-gesture context):
 *     1. ensureAudioContextSync()  ← creates ctx + calls resume() synchronously
 *     2. audioCtx.resume().then(() => noteOn(...))  ← schedules note after resume
 *
 * This satisfies iOS's requirement (resume called synchronously in gesture)
 * while also guaranteeing audio nodes are only created on a running context.
 *
 * For pointer/mouse events (desktop) the async/await approach works fine
 * because desktop browsers do not have the same synchronous-gesture restriction.
 *
 * ─── Other Safari quirks addressed ──────────────────────────────────────────
 *
 *  1. webkitAudioContext fallback for Safari < 14.1
 *
 *  2. linearRampToValueAtTime misbehaves without a prior anchor event.
 *     We always call setValueAtTime(0, now) before any ramp.
 *
 *  3. cancelScheduledValues must be followed immediately by setValueAtTime
 *     at the same timestamp or Safari may ignore the cancel.
 *
 *  4. OscillatorNode.stop(t) throws if t is in the past. Guarded with
 *     Math.max(t, audioCtx.currentTime + 0.001).
 *
 *  5. Web MIDI is not supported in Safari. Degrades gracefully with a
 *     neutral (non-error) status banner.
 *
 *  6. pointerup / pointerleave are unreliable on iOS when a touch ends
 *     outside the element. Touch devices use touchstart/touchend/touchcancel
 *     exclusively. Desktop uses pointer events.
 */

// ─── Note table ───────────────────────────────────────────────────────────────

const NOTE_FREQ_OCT4 = {
  C:    261.63,
  'C#': 277.18,
  D:    293.66,
  'D#': 311.13,
  E:    329.63,
  F:    349.23,
  'F#': 369.99,
  G:    391.99,
  'G#': 415.30,
  A:    440.00,
  'A#': 466.16,
  B:    493.88,
};

const CHROMATIC  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK_KEYS = new Set(['C#','D#','F#','G#','A#']);

// ─── Computer-keyboard note mapping ──────────────────────────────────────────
//
//   S   D       G   H   J
//  C# D#      F#  G#  A#
// Z  X  C  V  B  N  M
// C  D  E  F  G  A  B
//
const KB_MAP = {
  z: 'C',  x: 'D',  c: 'E',  v: 'F',  b: 'G',  n: 'A',  m: 'B',
  s: 'C#', d: 'D#', g: 'F#', h: 'G#', j: 'A#',
};

// ─── State ────────────────────────────────────────────────────────────────────

let audioCtx   = null;
let masterGain = null;

const activeNotes = new Map();
const heldKeys    = new Set();
let currentOctave = 4;

const params = {
  waveform: 'sine',
  attack:   0.01,
  decay:    0.10,
  sustain:  0.70,
  release:  0.50,
  volume:   0.30,
};

// True when the device has touch capability.
const isTouchDevice = navigator.maxTouchPoints > 0 || ('ontouchstart' in window);

// ─── Audio context ────────────────────────────────────────────────────────────

/**
 * Create the AudioContext and call resume() SYNCHRONOUSLY.
 *
 * This MUST be called directly (no await before it) inside a trusted
 * user-gesture handler on iOS Safari. The resume() call itself is what
 * iOS checks — it must happen on the same synchronous call-stack frame
 * as the gesture event. We do not await the returned Promise here; callers
 * that need to schedule audio work after resume resolves should chain
 * .then() on audioCtx.resume() themselves.
 *
 * Returns true if the context exists and resume() was called, false if
 * the Web Audio API is unavailable.
 */
function ensureAudioContextSync() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;

  if (!audioCtx) {
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = params.volume;
    masterGain.connect(audioCtx.destination);
  }

  // Call resume() synchronously — iOS Safari checks that this happens
  // within the trusted-gesture call stack. We intentionally do NOT await
  // the returned Promise here; see the module-level comment for why.
  if (audioCtx.state !== 'running') {
    audioCtx.resume().catch(err => {
      console.warn('[instruments] AudioContext resume failed:', err);
    });
  }

  return true;
}

/**
 * Async version for non-touch paths (desktop pointer/keyboard events).
 * Desktop browsers do not require the synchronous-gesture restriction so
 * we can safely await resume() here.
 */
async function getRunningAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!audioCtx) {
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = params.volume;
    masterGain.connect(audioCtx.destination);
  }

  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch (err) {
      console.warn('[instruments] AudioContext resume failed:', err);
      return null;
    }
  }

  return audioCtx.state === 'running' ? audioCtx : null;
}

// ─── Synth engine ─────────────────────────────────────────────────────────────

function getFrequency(noteName, octave) {
  return NOTE_FREQ_OCT4[noteName] * Math.pow(2, octave - 4);
}

/**
 * Start a note. Requires audioCtx to already be running (or at least
 * have had resume() called synchronously before this runs).
 *
 * For touch devices this is called inside the .then() of audioCtx.resume()
 * so the context is guaranteed to be running by the time audio nodes are
 * created. For desktop it is called after awaiting getRunningAudioContext().
 */
function noteOnSync(noteName, octave, velocity = 1.0) {
  if (!audioCtx || audioCtx.state !== 'running') return;

  const key = `${noteName}-${octave}`;
  if (activeNotes.has(key)) return;

  const freq = getFrequency(noteName, octave);
  const now  = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  osc.type            = params.waveform;
  osc.frequency.value = freq;

  const envGain = audioCtx.createGain();

  // Safari fix: anchor at 0 before ramping — without this Safari can
  // skip the attack ramp or produce a click.
  envGain.gain.setValueAtTime(0, now);

  const attackEnd = now + Math.max(params.attack, 0.001);
  envGain.gain.linearRampToValueAtTime(velocity, attackEnd);

  const decayEnd = attackEnd + Math.max(params.decay, 0.001);
  envGain.gain.linearRampToValueAtTime(params.sustain * velocity, decayEnd);

  osc.connect(envGain);
  envGain.connect(masterGain);
  osc.start(now);

  activeNotes.set(key, { osc, gain: envGain });
  setKeyActive(noteName, true);
}

/**
 * Async wrapper used by the desktop/keyboard path.
 */
async function noteOn(noteName, octave, velocity = 1.0) {
  const ctx = await getRunningAudioContext();
  if (!ctx) return;
  noteOnSync(noteName, octave, velocity);
}

/**
 * Release a note (note-off).
 *
 * Safari fixes:
 *  - cancelScheduledValues + immediate setValueAtTime re-anchor
 *  - guard osc.stop() against past timestamps
 */
function noteOff(noteName, octave) {
  const key  = `${noteName}-${octave}`;
  const node = activeNotes.get(key);
  if (!node) return;

  const { osc, gain: envGain } = node;
  const now = audioCtx.currentTime;

  envGain.gain.cancelScheduledValues(now);
  envGain.gain.setValueAtTime(envGain.gain.value, now);

  const releaseEnd = now + Math.max(params.release, 0.001);
  envGain.gain.linearRampToValueAtTime(0, releaseEnd);

  const stopTime = Math.max(releaseEnd + 0.01, audioCtx.currentTime + 0.001);
  try {
    osc.stop(stopTime);
  } catch {
    try { osc.stop(); } catch { /* already stopped */ }
  }

  activeNotes.delete(key);

  const stillActive = [...activeNotes.keys()].some(k => k.startsWith(`${noteName}-`));
  if (!stillActive) setKeyActive(noteName, false);
}

function allNotesOff() {
  for (const [, { osc, gain: envGain }] of activeNotes) {
    if (!audioCtx) break;
    const now = audioCtx.currentTime;
    envGain.gain.cancelScheduledValues(now);
    envGain.gain.setValueAtTime(0, now);
    try { osc.stop(Math.max(now + 0.01, audioCtx.currentTime + 0.001)); } catch { /* ok */ }
  }
  activeNotes.clear();
  heldKeys.clear();
  document.querySelectorAll('.key.active').forEach(el => el.classList.remove('active'));
}

// ─── On-screen keyboard ───────────────────────────────────────────────────────

function buildKeyboard() {
  const container = document.getElementById('keyboard');
  if (!container) return;
  container.innerHTML = '';

  CHROMATIC.forEach(note => {
    const btn = document.createElement('button');
    btn.className    = `key${BLACK_KEYS.has(note) ? ' black-key' : ''}`;
    btn.dataset.note = note;
    btn.textContent  = note;
    btn.setAttribute('aria-label', `Play ${note}`);
    btn.setAttribute('type', 'button');

    if (isTouchDevice) {
      // ── Touch path (iOS Safari, Android) ─────────────────────────────
      //
      // THE KEY PATTERN for iOS Safari:
      //
      //   touchstart (synchronous, trusted-gesture context):
      //     step 1 — ensureAudioContextSync()
      //              Creates the AudioContext if needed and calls resume()
      //              SYNCHRONOUSLY on the same call-stack frame as the
      //              touchstart event. iOS Safari checks for this.
      //     step 2 — audioCtx.resume().then(() => noteOnSync(...))
      //              Chains noteOnSync onto the resume Promise so audio
      //              nodes are only created once the context is running.
      //              If the context was already running, .then() fires
      //              on the next microtask — still fast enough for audio.
      //
      // We do NOT use pointerdown/pointerup on iOS because pointerup can
      // silently fail to fire, leaving notes stuck on indefinitely.
      //
      btn.addEventListener('touchstart', e => {
        e.preventDefault(); // prevent scroll and the 300 ms synthesized click

        // Step 1: create ctx and call resume() synchronously in this
        // trusted-gesture handler. This is the call iOS Safari checks.
        if (!ensureAudioContextSync()) return;

        // Step 2: schedule noteOnSync to run after resume() resolves.
        // audioCtx is guaranteed to exist here (ensureAudioContextSync
        // just created/confirmed it). We chain onto the live resume()
        // Promise so noteOnSync only runs on a running context.
        audioCtx.resume().then(() => {
          noteOnSync(note, currentOctave, 0.8);
        }).catch(err => {
          console.warn('[instruments] resume failed on touchstart:', err);
        });

      }, { passive: false });

      btn.addEventListener('touchend', e => {
        e.preventDefault();
        noteOff(note, currentOctave);
      }, { passive: false });

      btn.addEventListener('touchcancel', e => {
        e.preventDefault();
        noteOff(note, currentOctave);
      }, { passive: false });

    } else {
      // ── Pointer path (mouse, stylus, desktop) ─────────────────────────
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        noteOn(note, currentOctave, 0.8); // async — safe on desktop
      });
      btn.addEventListener('pointerup', () => {
        noteOff(note, currentOctave);
      });
      btn.addEventListener('pointerleave', () => {
        noteOff(note, currentOctave);
      });
    }

    container.appendChild(btn);
  });
}

function setKeyActive(noteName, active) {
  const btn = document.querySelector(`.key[data-note="${noteName}"]`);
  if (!btn) return;
  btn.classList.toggle('active', active);
}

// ─── Computer keyboard input ──────────────────────────────────────────────────

function handleKeyDown(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.repeat) return;

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    changeOctave(1);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    changeOctave(-1);
    return;
  }

  const note = KB_MAP[e.key.toLowerCase()];
  if (!note || heldKeys.has(e.key.toLowerCase())) return;

  heldKeys.add(e.key.toLowerCase());
  noteOn(note, currentOctave, 0.8); // async — keyboard events are trusted gestures on desktop
}

function handleKeyUp(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

  const note = KB_MAP[e.key.toLowerCase()];
  if (!note) return;

  heldKeys.delete(e.key.toLowerCase());
  noteOff(note, currentOctave);
}

// ─── Octave control ───────────────────────────────────────────────────────────

function changeOctave(delta) {
  const next = currentOctave + delta;
  if (next < 0 || next > 8) return;
  allNotesOff();
  currentOctave = next;
  const display = document.getElementById('octave-value');
  if (display) display.textContent = currentOctave;
}

// ─── MIDI ─────────────────────────────────────────────────────────────────────

function midiNoteToNameOctave(midiNote) {
  const octave   = Math.floor(midiNote / 12) - 1;
  const noteName = CHROMATIC[midiNote % 12];
  return { noteName, octave };
}

function onMidiMessage(event) {
  const [status, note, velocity] = event.data;
  const command = status & 0xf0;

  flashMidiIndicator();

  if (command === 0x90 && velocity > 0) {
    const { noteName, octave } = midiNoteToNameOctave(note);
    noteOn(noteName, octave, velocity / 127);
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    const { noteName, octave } = midiNoteToNameOctave(note);
    noteOff(noteName, octave);
  }
}

function flashMidiIndicator() {
  const indicator = document.getElementById('midi-indicator');
  if (!indicator) return;
  indicator.classList.remove('active');
  void indicator.offsetWidth;
  indicator.classList.add('active');
}

function setMidiStatus(text, state = '') {
  const banner = document.getElementById('midi-status');
  const label  = document.getElementById('midi-text');
  if (!banner || !label) return;
  banner.className  = `midi-status${state ? ` ${state}` : ''}`;
  label.textContent = text;
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiStatus('MIDI not supported in this browser — keyboard & touch still work', 'unsupported');
    return;
  }

  try {
    const midiAccess = await navigator.requestMIDIAccess({ sysex: false });

    function connectInputs() {
      let count = 0;
      midiAccess.inputs.forEach(input => {
        input.onmidimessage = onMidiMessage;
        count++;
      });

      if (count > 0) {
        const names = [];
        midiAccess.inputs.forEach(i => names.push(i.name));
        setMidiStatus(`Connected: ${names.join(', ')}`, 'connected');
      } else {
        setMidiStatus('No MIDI device connected');
      }
    }

    connectInputs();
    midiAccess.onstatechange = () => connectInputs();

  } catch (err) {
    setMidiStatus(`MIDI unavailable: ${err.message}`, 'error');
  }
}

// ─── UI controls ──────────────────────────────────────────────────────────────

function formatTime(seconds) {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(2)}s`;
}

function initControls() {
  const waveformEl = document.getElementById('waveform');
  waveformEl?.addEventListener('change', () => {
    params.waveform = waveformEl.value;
    activeNotes.forEach(({ osc }) => { osc.type = params.waveform; });
  });

  const sliders = [
    { id: 'attack',  valueId: 'attack-value',  param: 'attack',  format: v => formatTime(v) },
    { id: 'decay',   valueId: 'decay-value',   param: 'decay',   format: v => formatTime(v) },
    { id: 'sustain', valueId: 'sustain-value', param: 'sustain', format: v => `${Math.round(v * 100)}%` },
    { id: 'release', valueId: 'release-value', param: 'release', format: v => formatTime(v) },
    { id: 'volume',  valueId: 'volume-value',  param: 'volume',  format: v => `${Math.round(v * 100)}%` },
  ];

  sliders.forEach(({ id, valueId, param, format }) => {
    const input   = document.getElementById(id);
    const display = document.getElementById(valueId);
    if (!input) return;

    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      params[param] = v;
      if (display) display.textContent = format(v);
      if (param === 'volume' && masterGain && audioCtx) {
        masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.01);
      }
    });

    if (display) display.textContent = format(parseFloat(input.value));
  });

  document.getElementById('octave-down')?.addEventListener('click', () => changeOctave(-1));
  document.getElementById('octave-up')?.addEventListener('click',   () => changeOctave(1));
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

window.addEventListener('blur', () => {
  if (activeNotes.size > 0) allNotesOff();
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

buildKeyboard();
initControls();
initMidi();

document.addEventListener('keydown', handleKeyDown);
document.addEventListener('keyup',   handleKeyUp);
