/**
 * instruments.js — Web Audio + Web MIDI synthesizer
 *
 * Features:
 *  - Polyphonic ADSR synth via Web Audio API
 *  - Computer keyboard input (Z-M white keys, S D G H J black keys)
 *  - On-screen clickable/touchable keyboard
 *  - Web MIDI API input (auto-connects all available inputs)
 *  - Octave shifting (↑/↓ arrows or on-screen buttons)
 *  - Live ADSR / waveform / volume controls
 */

// ─── Note table ───────────────────────────────────────────────────────────────

/**
 * Base frequencies for octave 4 (middle octave).
 * getFrequency() scales these to any octave.
 */
const NOTE_FREQ_OCT4 = {
  C:  261.63,
  'C#': 277.18,
  D:  293.66,
  'D#': 311.13,
  E:  329.63,
  F:  349.23,
  'F#': 369.99,
  G:  391.99,
  'G#': 415.30,
  A:  440.00,
  'A#': 466.16,
  B:  493.88,
};

/** Chromatic scale order used for rendering the keyboard. */
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/** Notes that are "black keys" (sharps). */
const BLACK_KEYS = new Set(['C#','D#','F#','G#','A#']);

// ─── Computer-keyboard → note mapping ────────────────────────────────────────
//
// Layout mirrors a piano keyboard across two rows:
//
//   S   D       G   H   J
//  C# D#      F#  G#  A#
// Z  X  C  V  B  N  M
// C  D  E  F  G  A  B
//
const KB_MAP = {
  // White keys (bottom row)
  z: 'C',
  x: 'D',
  c: 'E',
  v: 'F',
  b: 'G',
  n: 'A',
  m: 'B',
  // Black keys (top row, interleaved)
  s: 'C#',
  d: 'D#',
  g: 'F#',
  h: 'G#',
  j: 'A#',
};

// ─── State ────────────────────────────────────────────────────────────────────

/** Web Audio context — created lazily on first user gesture. */
let audioCtx = null;

/** Master gain node (volume). Created with audioCtx. */
let masterGain = null;

/**
 * Map of currently-sounding notes.
 * Key: string like "C#-4" (note + octave).
 * Value: { osc: OscillatorNode, gain: GainNode }
 */
const activeNotes = new Map();

/** Keys currently pressed via computer keyboard (prevents key-repeat). */
const heldKeys = new Set();

/** Current octave (4 = middle C octave). */
let currentOctave = 4;

/** Synth parameters — kept in sync with the UI controls. */
const params = {
  waveform: 'sine',
  attack:   0.01,
  decay:    0.10,
  sustain:  0.70,
  release:  0.50,
  volume:   0.30,
};

// ─── Audio context ────────────────────────────────────────────────────────────

function ensureAudioContext() {
  if (audioCtx) {
    // Resume if suspended (autoplay policy)
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = params.volume;
  masterGain.connect(audioCtx.destination);
}

// ─── Synth engine ─────────────────────────────────────────────────────────────

/**
 * Return the frequency (Hz) for a note name at a given octave.
 * Uses equal temperament: freq = baseFreq × 2^(octave - 4)
 */
function getFrequency(noteName, octave) {
  return NOTE_FREQ_OCT4[noteName] * Math.pow(2, octave - 4);
}

/**
 * Start a note (note-on).
 * @param {string} noteName  e.g. "C#"
 * @param {number} octave
 * @param {number} velocity  0–1 (MIDI velocity mapped to 0–1)
 */
function noteOn(noteName, octave, velocity = 1.0) {
  ensureAudioContext();

  const key = `${noteName}-${octave}`;
  if (activeNotes.has(key)) return; // already playing

  const freq = getFrequency(noteName, octave);
  const now  = audioCtx.currentTime;

  // Oscillator
  const osc = audioCtx.createOscillator();
  osc.type            = params.waveform;
  osc.frequency.value = freq;

  // Per-note gain (envelope)
  const envGain = audioCtx.createGain();
  envGain.gain.setValueAtTime(0, now);

  // Attack
  envGain.gain.linearRampToValueAtTime(velocity, now + params.attack);
  // Decay → Sustain
  envGain.gain.linearRampToValueAtTime(
    params.sustain * velocity,
    now + params.attack + params.decay
  );

  osc.connect(envGain);
  envGain.connect(masterGain);
  osc.start(now);

  activeNotes.set(key, { osc, gain: envGain });

  // Highlight on-screen key
  setKeyActive(noteName, true);
}

/**
 * Release a note (note-off).
 * @param {string} noteName
 * @param {number} octave
 */
function noteOff(noteName, octave) {
  const key = `${noteName}-${octave}`;
  const node = activeNotes.get(key);
  if (!node) return;

  const { osc, gain: envGain } = node;
  const now = audioCtx.currentTime;

  // Release ramp
  envGain.gain.cancelScheduledValues(now);
  envGain.gain.setValueAtTime(envGain.gain.value, now);
  envGain.gain.linearRampToValueAtTime(0, now + params.release);

  // Stop oscillator after release
  osc.stop(now + params.release + 0.01);

  activeNotes.delete(key);

  // Remove highlight if no other octave is playing the same note name
  const stillActive = [...activeNotes.keys()].some(k => k.startsWith(`${noteName}-`));
  if (!stillActive) setKeyActive(noteName, false);
}

/** Release all currently-sounding notes immediately (e.g. on blur). */
function allNotesOff() {
  for (const [key, { osc, gain: envGain }] of activeNotes) {
    const now = audioCtx ? audioCtx.currentTime : 0;
    envGain.gain.cancelScheduledValues(now);
    envGain.gain.setValueAtTime(0, now);
    osc.stop(now + 0.01);
  }
  activeNotes.clear();
  heldKeys.clear();

  // Clear all visual highlights
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

    // Mouse / touch events
    btn.addEventListener('pointerdown', e => {
      e.preventDefault(); // prevent focus stealing / scroll
      noteOn(note, currentOctave, 0.8);
    });

    btn.addEventListener('pointerup',    () => noteOff(note, currentOctave));
    btn.addEventListener('pointerleave', () => noteOff(note, currentOctave));

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
  // Ignore when focus is inside a form control
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.repeat) return;

  // Octave shift
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

  // Release any held notes before shifting so they don't hang
  allNotesOff();

  currentOctave = next;
  const display = document.getElementById('octave-value');
  if (display) display.textContent = currentOctave;
}

// ─── MIDI ─────────────────────────────────────────────────────────────────────

/** MIDI note number → { noteName, octave } */
function midiNoteToNameOctave(midiNote) {
  const octave   = Math.floor(midiNote / 12) - 1;
  const noteName = CHROMATIC[midiNote % 12];
  return { noteName, octave };
}

function onMidiMessage(event) {
  const [status, note, velocity] = event.data;
  const command = status & 0xf0;

  // Flash MIDI indicator
  flashMidiIndicator();

  if (command === 0x90 && velocity > 0) {
    // Note On
    const { noteName, octave } = midiNoteToNameOctave(note);
    noteOn(noteName, octave, velocity / 127);
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    // Note Off (0x80) or Note On with velocity 0 (running status)
    const { noteName, octave } = midiNoteToNameOctave(note);
    noteOff(noteName, octave);
  }
  // Other MIDI messages (CC, pitch bend, etc.) are ignored for now
}

function flashMidiIndicator() {
  const indicator = document.getElementById('midi-indicator');
  if (!indicator) return;
  indicator.classList.remove('active');
  // Force reflow so the animation restarts
  void indicator.offsetWidth;
  indicator.classList.add('active');
}

function setMidiStatus(text, state = '') {
  const banner = document.getElementById('midi-status');
  const label  = document.getElementById('midi-text');
  if (!banner || !label) return;

  banner.className = `midi-status${state ? ` ${state}` : ''}`;
  label.textContent = text;
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiStatus('Web MIDI not supported in this browser', 'error');
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

    // Re-scan when devices are added / removed
    midiAccess.onstatechange = () => connectInputs();

  } catch (err) {
    // User denied permission or MIDI access failed
    setMidiStatus(`MIDI unavailable: ${err.message}`, 'error');
  }
}

// ─── UI controls ──────────────────────────────────────────────────────────────

/** Format a seconds value as a human-readable time string. */
function formatTime(seconds) {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(2)}s`;
}

function initControls() {
  // Waveform select
  const waveformEl = document.getElementById('waveform');
  waveformEl?.addEventListener('change', () => {
    params.waveform = waveformEl.value;
    // Update any currently-playing oscillators
    activeNotes.forEach(({ osc }) => { osc.type = params.waveform; });
  });

  // ADSR + Volume sliders
  const sliders = [
    {
      id: 'attack',
      valueId: 'attack-value',
      param: 'attack',
      format: v => formatTime(v),
    },
    {
      id: 'decay',
      valueId: 'decay-value',
      param: 'decay',
      format: v => formatTime(v),
    },
    {
      id: 'sustain',
      valueId: 'sustain-value',
      param: 'sustain',
      format: v => `${Math.round(v * 100)}%`,
    },
    {
      id: 'release',
      valueId: 'release-value',
      param: 'release',
      format: v => formatTime(v),
    },
    {
      id: 'volume',
      valueId: 'volume-value',
      param: 'volume',
      format: v => `${Math.round(v * 100)}%`,
    },
  ];

  sliders.forEach(({ id, valueId, param, format }) => {
    const input   = document.getElementById(id);
    const display = document.getElementById(valueId);
    if (!input) return;

    // Sync display on input (live feedback while dragging)
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      params[param] = v;

      if (display) display.textContent = format(v);

      // Apply volume change immediately to master gain
      if (param === 'volume' && masterGain) {
        masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.01);
      }
    });

    // Initialise display text from the default slider value
    if (display) display.textContent = format(parseFloat(input.value));
  });

  // Octave buttons
  document.getElementById('octave-down')?.addEventListener('click', () => changeOctave(-1));
  document.getElementById('octave-up')?.addEventListener('click',   () => changeOctave(1));
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/** Release notes when the window loses focus so keys don't "stick". */
window.addEventListener('blur', () => {
  if (activeNotes.size > 0) allNotesOff();
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

buildKeyboard();
initControls();
initMidi();

document.addEventListener('keydown', handleKeyDown);
document.addEventListener('keyup',   handleKeyUp);
