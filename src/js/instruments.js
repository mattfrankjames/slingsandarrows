/**
 * instruments.js - Web Audio + Web MIDI synthesizer
 *
 * iOS Safari AudioContext — the real fix
 * --------------------------------------
 * iOS Safari requires AudioContext() + resume() to be called synchronously
 * inside a trusted user-gesture handler.  Any context created outside that
 * frame starts 'suspended' and can never be resumed.
 *
 * The ONLY reliable pattern (used by Tone.js, Howler.js, etc.) is:
 *
 *   1. Show a full-screen "Tap to enable audio" overlay on page load.
 *   2. On its click/touchstart, call new AudioContext() + resume()
 *      synchronously — iOS grants the hardware unlock here.
 *   3. Await resume() — context is now 'running'.
 *   4. Set audioReady = true, hide the overlay.
 *   5. All subsequent noteOn() calls work freely because the context
 *      is already running; no gesture token is needed for osc.start().
 *
 * There is exactly ONE new AudioContext() call in this file — inside
 * initAudioContext(), which is only ever invoked from the overlay button
 * handler.  ensureAudioContext() only *resumes* an existing context and
 * returns false immediately if the overlay hasn't been tapped yet.
 */

// ─── Note / keyboard tables ───────────────────────────────────────────────────

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

const KB_MAP = {
  z: 'C',  x: 'D',  c: 'E',  v: 'F',  b: 'G',  n: 'A',  m: 'B',
  s: 'C#', d: 'D#', g: 'F#', h: 'G#', j: 'A#',
};

// ─── Audio state ──────────────────────────────────────────────────────────────

let audioCtx   = null;   // created once, inside the overlay gesture handler
let masterGain = null;
let audioReady = false;  // true only after context reaches 'running'

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

// ─── AudioContext bootstrap ───────────────────────────────────────────────────

/**
 * initAudioContext()
 *
 * Must be called synchronously from within a trusted user-gesture handler
 * (the overlay unlock button).  Creates the AudioContext and calls resume()
 * in the same call-stack frame so iOS Safari grants the hardware unlock.
 *
 * Returns a Promise that resolves to the AudioContext once it is 'running'.
 */
async function initAudioContext() {
  if (audioCtx) return audioCtx;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API not supported in this browser');

  // Create synchronously — iOS checks this happens inside the gesture frame
  audioCtx   = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = params.volume;
  masterGain.connect(audioCtx.destination);

  // iOS requires an explicit resume() even when created inside a gesture
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  console.log('[instruments] AudioContext state after unlock:', audioCtx.state);
  return audioCtx;
}

/**
 * ensureAudioContext()
 *
 * Called from keyboard/pointer handlers AFTER the overlay has been dismissed.
 * Only resumes an already-created context (e.g. if it was auto-suspended after
 * a period of inactivity).  Returns false if the context doesn't exist yet
 * (overlay not tapped) so callers can bail out gracefully.
 */
async function ensureAudioContext() {
  if (!audioCtx) return false;   // overlay not tapped yet — do nothing

  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* ignore */ }
  }

  audioReady = audioCtx.state === 'running';
  return audioReady;
}

// ─── Overlay unlock prompt ────────────────────────────────────────────────────

function showUnlockPrompt() {
  return new Promise(function (resolve) {
    const overlay = document.getElementById('audio-unlock-overlay');
    const btn     = document.getElementById('audio-unlock-btn');
    if (!overlay || !btn) { resolve(); return; }

    overlay.hidden = false;

    async function onUnlock(e) {
      e.preventDefault();
      btn.removeEventListener('touchstart', onUnlock);
      btn.removeEventListener('click',      onUnlock);

      try {
        await initAudioContext();           // creates + resumes synchronously
        audioReady = audioCtx.state === 'running';
      } catch (err) {
        console.warn('[instruments] AudioContext init failed:', err);
      }

      overlay.hidden = true;
      resolve();
    }

    btn.addEventListener('touchstart', onUnlock, { passive: false });
    btn.addEventListener('click',      onUnlock);
  });
}

// ─── Synth engine ─────────────────────────────────────────────────────────────

function getFrequency(noteName, octave) {
  return NOTE_FREQ_OCT4[noteName] * Math.pow(2, octave - 4);
}

function noteOn(noteName, octave, velocity) {
  if (velocity === undefined) velocity = 1.0;
  if (!audioCtx || !audioReady) return;

  const key = noteName + '-' + octave;
  if (activeNotes.has(key)) return;

  const freq = getFrequency(noteName, octave);
  const now  = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  osc.type            = params.waveform;
  osc.frequency.value = freq;

  const envGain = audioCtx.createGain();
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

function noteOff(noteName, octave) {
  const key  = noteName + '-' + octave;
  const node = activeNotes.get(key);
  if (!node || !audioCtx) return;

  const now = audioCtx.currentTime;
  node.gain.cancelScheduledValues(now);
  node.gain.setValueAtTime(node.gain.value, now);

  const releaseEnd = now + Math.max(params.release, 0.001);
  node.gain.linearRampToValueAtTime(0, releaseEnd);

  const stopTime = Math.max(releaseEnd + 0.01, audioCtx.currentTime + 0.001);
  try { node.osc.stop(stopTime); } catch (e) { try { node.osc.stop(); } catch (e2) { /* ignore */ } }

  activeNotes.delete(key);
  let stillActive = false;
  activeNotes.forEach(function (v, k) { if (k.startsWith(noteName + '-')) stillActive = true; });
  if (!stillActive) setKeyActive(noteName, false);
}

function allNotesOff() {
  activeNotes.forEach(function (node) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(0, now);
    try { node.osc.stop(Math.max(now + 0.01, audioCtx.currentTime + 0.001)); } catch (e) { /* ignore */ }
  });
  activeNotes.clear();
  heldKeys.clear();
  document.querySelectorAll('.key.active').forEach(function (el) { el.classList.remove('active'); });
}

// ─── On-screen keyboard ───────────────────────────────────────────────────────

function buildKeyboard() {
  const container = document.getElementById('keyboard');
  if (!container) return;
  container.innerHTML = '';

  CHROMATIC.forEach(function (note) {
    const btn = document.createElement('button');
    btn.className    = 'key' + (BLACK_KEYS.has(note) ? ' black-key' : '');
    btn.dataset.note = note;
    btn.textContent  = note;
    btn.setAttribute('aria-label', 'Play ' + note);
    btn.setAttribute('type', 'button');

    // Touch — context is already running after the overlay tap
    btn.addEventListener('touchstart', function (e) {
      e.preventDefault();
      noteOn(note, currentOctave, 0.8);
    }, { passive: false });

    btn.addEventListener('touchend', function (e) {
      e.preventDefault();
      noteOff(note, currentOctave);
    }, { passive: false });

    btn.addEventListener('touchcancel', function (e) {
      e.preventDefault();
      noteOff(note, currentOctave);
    }, { passive: false });

    // Pointer (mouse / pen) — ensureAudioContext handles auto-suspend recovery
    btn.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      ensureAudioContext().then(function () { noteOn(note, currentOctave, 0.8); });
    });
    btn.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch') return;
      noteOff(note, currentOctave);
    });
    btn.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'touch') return;
      noteOff(note, currentOctave);
    });

    container.appendChild(btn);
  });
}

/**
 * setKeyActive — toggle the .active class on an on-screen key button.
 * Fixed: was using a broken string concatenation instead of a template literal,
 * so the querySelector always returned null and keys never lit up.
 */
function setKeyActive(noteName, active) {
  const btn = document.querySelector(`.key[data-note="${noteName}"]`);
  if (!btn) return;
  btn.classList.toggle('active', active);
}

// ─── Computer keyboard input ──────────────────────────────────────────────────

function handleKeyDown(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.repeat) return;
  if (e.key === 'ArrowUp')   { e.preventDefault(); changeOctave(1);  return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); changeOctave(-1); return; }
  const note = KB_MAP[e.key.toLowerCase()];
  if (!note || heldKeys.has(e.key.toLowerCase())) return;
  heldKeys.add(e.key.toLowerCase());
  ensureAudioContext().then(function () { noteOn(note, currentOctave, 0.8); });
}

function handleKeyUp(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const note = KB_MAP[e.key.toLowerCase()];
  if (!note) return;
  heldKeys.delete(e.key.toLowerCase());
  noteOff(note, currentOctave);
}

function changeOctave(delta) {
  const next = currentOctave + delta;
  if (next < 0 || next > 8) return;
  allNotesOff();
  currentOctave = next;
  const display = document.getElementById('octave-value');
  if (display) display.textContent = currentOctave;
}

// ─── Web MIDI ─────────────────────────────────────────────────────────────────

function midiNoteToNameOctave(midiNote) {
  return { noteName: CHROMATIC[midiNote % 12], octave: Math.floor(midiNote / 12) - 1 };
}

function onMidiMessage(event) {
  const [status, note, velocity] = event.data;
  const command = status & 0xf0;
  flashMidiIndicator();
  if (command === 0x90 && velocity > 0) {
    const n = midiNoteToNameOctave(note);
    noteOn(n.noteName, n.octave, velocity / 127);
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    const n = midiNoteToNameOctave(note);
    noteOff(n.noteName, n.octave);
  }
}

function flashMidiIndicator() {
  const ind = document.getElementById('midi-indicator');
  if (!ind) return;
  ind.classList.remove('active');
  void ind.offsetWidth;
  ind.classList.add('active');
}

function setMidiStatus(text, state) {
  const banner = document.getElementById('midi-status');
  const label  = document.getElementById('midi-text');
  if (!banner || !label) return;
  banner.className  = 'midi-status' + (state ? ' ' + state : '');
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
      midiAccess.inputs.forEach(function (input) { input.onmidimessage = onMidiMessage; count++; });
      if (count > 0) {
        const names = [];
        midiAccess.inputs.forEach(function (i) { names.push(i.name); });
        setMidiStatus('Connected: ' + names.join(', '), 'connected');
      } else {
        setMidiStatus('No MIDI device connected');
      }
    }
    connectInputs();
    midiAccess.onstatechange = connectInputs;
  } catch (err) {
    setMidiStatus('MIDI unavailable: ' + err.message, 'error');
  }
}

// ─── Synth controls (ADSR sliders, waveform, volume) ─────────────────────────

function formatTime(s) { return s < 1 ? Math.round(s * 1000) + 'ms' : s.toFixed(2) + 's'; }

function initControls() {
  const waveformEl = document.getElementById('waveform');
  if (waveformEl) {
    waveformEl.addEventListener('change', function () {
      params.waveform = waveformEl.value;
      activeNotes.forEach(function (n) { n.osc.type = params.waveform; });
    });
  }

  [
    { id: 'attack',  vid: 'attack-value',  p: 'attack',  fmt: formatTime },
    { id: 'decay',   vid: 'decay-value',   p: 'decay',   fmt: formatTime },
    { id: 'sustain', vid: 'sustain-value', p: 'sustain', fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { id: 'release', vid: 'release-value', p: 'release', fmt: formatTime },
    { id: 'volume',  vid: 'volume-value',  p: 'volume',  fmt: function (v) { return Math.round(v * 100) + '%'; } },
  ].forEach(function (s) {
    const input   = document.getElementById(s.id);
    const display = document.getElementById(s.vid);
    if (!input) return;
    input.addEventListener('input', function () {
      const v = parseFloat(input.value);
      params[s.p] = v;
      if (display) display.textContent = s.fmt(v);
      if (s.p === 'volume' && masterGain && audioCtx) {
        masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.01);
      }
    });
    if (display) display.textContent = s.fmt(parseFloat(input.value));
  });

  const od = document.getElementById('octave-down');
  const ou = document.getElementById('octave-up');
  if (od) od.addEventListener('click', function () { changeOctave(-1); });
  if (ou) ou.addEventListener('click', function () { changeOctave(1); });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

window.addEventListener('blur', function () { if (activeNotes.size > 0) allNotesOff(); });

buildKeyboard();
initControls();
initMidi();
document.addEventListener('keydown', handleKeyDown);
document.addEventListener('keyup',   handleKeyUp);

// Show the unlock overlay last — nothing plays until the user taps it.
showUnlockPrompt();
