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
 * Safari / iOS compatibility notes
 * ──────────────────────────────────
 *  1. Web MIDI API is not supported in Safari. The MIDI section degrades
 *     gracefully: the status banner shows a friendly "not supported" message
 *     and the rest of the synth works normally.
 *
 *  2. iOS Safari requires the AudioContext to be created and resumed inside
 *     a trusted user-gesture handler (tap / click), but resume() is
 *     asynchronous. The previous approach registered a document-level
 *     touchstart listener that called resume() fire-and-forget, then called
 *     noteOn() from pointerdown. By the time noteOn() ran, resume() had not
 *     yet resolved — the context was still 'suspended' — so all oscillators
 *     were started on a suspended context and produced no sound.
 *
 *     Fix: noteOn() is now async and awaits getRunningAudioContext(), which
 *     calls resume() and waits for the context to reach 'running' before
 *     returning. Audio nodes are never created or started on a suspended
 *     context.
 *
 *  3. Safari's AudioContext implementation has several quirks:
 *       a. linearRampToValueAtTime misbehaves if there is no prior automation
 *          event at exactly currentTime. We always call setValueAtTime(0, now)
 *          immediately before any ramp.
 *       b. cancelScheduledValues must be followed by a setValueAtTime at the
 *          same timestamp or Safari may ignore the cancel.
 *       c. OscillatorNode.stop(t) throws if t is in the past. We guard with
 *          Math.max(t, audioCtx.currentTime + 0.001).
 *       d. webkitAudioContext is used as a fallback for older Safari.
 *
 *  4. iOS Safari pointer/touch event reliability:
 *       pointerup and pointerleave are unreliable on iOS Safari when a touch
 *       ends outside the element or is interrupted. The previous code used a
 *       pressedViaPointer flag to avoid double-triggering, but if pointerup
 *       was missed the flag stayed true permanently, silently blocking all
 *       subsequent touchend note-offs on that key.
 *
 *       Fix: event handling is split by isTouchDevice. Touch devices use
 *       touchstart/touchend/touchcancel exclusively (always reliable on iOS).
 *       Pointer devices use pointerdown/pointerup/pointerleave. No shared
 *       state flag is needed.
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

// True when the device has touch capability — determines which event path
// is used on the on-screen keyboard keys.
const isTouchDevice = navigator.maxTouchPoints > 0 || ('ontouchstart' in window);

// ─── Audio context ────────────────────────────────────────────────────────────

/**
 * Get (or create) the AudioContext and ensure it is in the 'running' state.
 * Returns a Promise that resolves to the running AudioContext, or null if
 * the Web Audio API is unavailable or resume() fails.
 *
 * WHY ASYNC:
 * iOS Safari requires AudioContext.resume() to be called inside a trusted
 * user-gesture handler (touchstart, pointerdown, click), and resume() is
 * asynchronous — it resolves only after the system has actually un-suspended
 * the audio hardware. Any oscillators or gain nodes created or started before
 * that Promise resolves will be scheduled on a suspended context and will
 * produce no sound on iOS Safari.
 *
 * noteOn() awaits this function before creating any audio nodes, guaranteeing
 * the context is truly running before any audio work is scheduled.
 * touchstart and pointerdown are both trusted gesture handlers, so calling
 * resume() from within them is valid.
 */
async function getRunningAudioContext() {
  // webkitAudioContext fallback covers older Safari (pre-14.1)
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
 * Start a note (note-on).
 *
 * Async so it can await getRunningAudioContext() — the core fix for iOS
 * Safari silence. Audio nodes must not be created or started until the
 * AudioContext is confirmed running (resume() has resolved).
 *
 * Safari fix (3a): We always anchor the gain timeline with
 * setValueAtTime(0, now) before the first linearRampToValueAtTime.
 * Without this anchor Safari's scheduler can produce a click or skip
 * the ramp entirely.
 *
 * @param {string} noteName  e.g. "C#"
 * @param {number} octave
 * @param {number} velocity  0-1 (MIDI velocity mapped to 0-1)
 */
async function noteOn(noteName, octave, velocity = 1.0) {
  // Wait until the AudioContext is genuinely running before touching any
  // audio nodes. This is the core fix for iOS Safari silence.
  const ctx = await getRunningAudioContext();
  if (!ctx) return;

  const key = `${noteName}-${octave}`;
  if (activeNotes.has(key)) return; // already playing

  const freq = getFrequency(noteName, octave);
  const now  = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type            = params.waveform;
  osc.frequency.value = freq;

  const envGain = ctx.createGain();

  // Safari fix (3a): anchor at 0 before ramping up
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
 * Release a note (note-off).
 *
 * Safari fix (3b): After cancelScheduledValues we immediately call
 * setValueAtTime at the same timestamp so Safari's scheduler has a
 * concrete starting point for the release ramp.
 *
 * Safari fix (3c): Guard osc.stop() so it never receives a time in
 * the past, which throws a DOMException in Safari.
 */
function noteOff(noteName, octave) {
  const key  = `${noteName}-${octave}`;
  const node = activeNotes.get(key);
  if (!node) return;

  const { osc, gain: envGain } = node;
  const now = audioCtx.currentTime;

  // Safari fix (3b): cancel then immediately re-anchor the current value
  envGain.gain.cancelScheduledValues(now);
  envGain.gain.setValueAtTime(envGain.gain.value, now);

  const releaseEnd = now + Math.max(params.release, 0.001);
  envGain.gain.linearRampToValueAtTime(0, releaseEnd);

  // Safari fix (3c): never pass a stop time that is already in the past
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
      // ── Touch-device path (iOS Safari, Android) ───────────────────────
      // Use touchstart/touchend/touchcancel as the sole event path.
      //
      // We do NOT use pointerdown/pointerup here because on iOS Safari
      // pointerup can silently fail to fire when a touch ends (e.g. when
      // the finger slides off the element or the touch is interrupted).
      // If pointerup is missed the note hangs forever with no way to
      // release it. touchend and touchcancel are always reliably fired
      // on iOS Safari regardless of where the touch ends.
      btn.addEventListener('touchstart', e => {
        e.preventDefault(); // prevent scroll and the 300 ms click delay
        noteOn(note, currentOctave, 0.8);
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
      // ── Pointer-device path (mouse, stylus, desktop) ──────────────────
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        noteOn(note, currentOctave, 0.8);
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
  noteOn(note, currentOctave, 0.8);
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
