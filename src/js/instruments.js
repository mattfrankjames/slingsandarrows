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
 *
 * Safari / iOS compatibility notes
 * ──────────────────────────────────
 *  1. Web MIDI API is not supported in Safari. The MIDI section degrades
 *     gracefully: the status banner shows a friendly "not supported" message
 *     and the rest of the synth works normally.
 *  2. iOS Safari requires the AudioContext to be both *created* and *resumed*
 *     synchronously inside a trusted user-gesture handler (tap / click).
 *     `initAudioContext()` is registered on the first `click` and `touchstart`
 *     events so the context is ready before any note fires.  `ensureAudioContext`
 *     is kept as a secondary safety net for code paths that call `noteOn`
 *     directly (e.g. MIDI messages after the context already exists).
 *  3. Safari's AudioContext implementation has several quirks:
 *       a. `linearRampToValueAtTime` misbehaves if there is no prior
 *          automation event at exactly `currentTime`. We always call
 *          `setValueAtTime(currentValue, now)` immediately before any ramp.
 *       b. `cancelScheduledValues` must be followed by a `setValueAtTime`
 *          at the same timestamp or Safari may ignore the cancel.
 *       c. `OscillatorNode.stop(t)` throws if t is in the past. We guard
 *          with `Math.max(t, audioCtx.currentTime + 0.001)`.
 *       d. `webkitAudioContext` is used as a fallback for older Safari.
 *  4. Pointer events on iOS Safari can miss `pointerup`/`pointerleave` for
 *     touch inputs. We attach `touchend`/`touchcancel` listeners as well.
 */

// ─── Note table ───────────────────────────────────────────────────────────────

/**
 * Base frequencies for octave 4 (middle octave).
 * getFrequency() scales these to any octave.
 */
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

/**
 * Create (if needed) and resume the AudioContext.
 *
 * iOS Safari rule: the AudioContext must be *created* **and** *resumed* inside
 * a synchronous trusted user-gesture handler (tap / click).  Calling resume()
 * from a promise callback or a setTimeout is not sufficient.
 *
 * This function is therefore registered directly on `click` and `touchstart`
 * at the document level so it fires as early as possible — before any note
 * logic runs.  The `{ once: true }` flag is intentionally NOT used here;
 * instead we guard with an `if (audioCtx.state === 'running') return` check so
 * that the listener is removed as soon as the context is confirmed running,
 * while still re-attempting on subsequent taps if the first gesture somehow
 * left the context suspended (e.g. background tab on iOS).
 */
function initAudioContext() {
  // `webkitAudioContext` fallback covers older Safari (pre-14.1)
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  // Create the context on the very first gesture
  if (!audioCtx) {
    audioCtx = new AudioContextClass();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = params.volume;
    masterGain.connect(audioCtx.destination);
  }

  // Resume if suspended — must happen synchronously inside the gesture handler
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      console.log('[instruments] AudioContext resumed, state:', audioCtx.state);
      // Refresh the MIDI banner now that audio is confirmed running
      // (the banner may have shown "no MIDI device" before audio was ready)
      refreshMidiStatus();
    }).catch(err => {
      console.warn('[instruments] AudioContext resume failed:', err);
    });
  }

  // Once the context is running we no longer need to intercept every gesture
  if (audioCtx.state === 'running') {
    document.removeEventListener('click',      initAudioContext);
    document.removeEventListener('touchstart', initAudioContext);
  }
}

// Register on both event types so the context is unlocked by any first
// interaction — whether the user taps a key, clicks a control, or just
// taps anywhere on the page.
document.addEventListener('click',      initAudioContext, { passive: true });
document.addEventListener('touchstart', initAudioContext, { passive: true });

/**
 * Secondary safety net called from `noteOn` and other audio-triggering paths.
 * By the time a note fires the context should already be running (unlocked by
 * `initAudioContext` above), but we defend against edge cases such as:
 *  - MIDI note arriving before any touch (unlikely but possible on desktop)
 *  - Context suspended again after a background/foreground cycle
 */
function ensureAudioContext() {
  if (!audioCtx) {
    // Context hasn't been created yet — create it now (desktop / non-iOS path)
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    audioCtx = new AudioContextClass();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = params.volume;
    masterGain.connect(audioCtx.destination);
  }

  // Resume if suspended (autoplay policy — common on mobile Safari)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(err => {
      console.warn('[instruments] ensureAudioContext resume failed:', err);
    });
  }
}

/**
 * Re-evaluate and update the MIDI status banner.
 * Called after the AudioContext is confirmed running so the UI reflects
 * the current MIDI connection state without an extra user action.
 */
function refreshMidiStatus() {
  if (!navigator.requestMIDIAccess) {
    setMidiStatus('MIDI not supported in this browser — keyboard & mouse still work', 'unsupported');
  }
  // If MIDI was already initialised (midiAccess stored) the onstatechange
  // handler will keep the banner current; nothing extra needed here.
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
 *
 * Safari fix (2a): We always anchor the gain timeline with
 * `setValueAtTime(0, now)` before the first `linearRampToValueAtTime`.
 * Without this anchor, Safari's scheduler can produce a click or skip
 * the ramp entirely.
 *
 * @param {string} noteName  e.g. "C#"
 * @param {number} octave
 * @param {number} velocity  0–1 (MIDI velocity mapped to 0–1)
 */
function noteOn(noteName, octave, velocity = 1.0) {
  ensureAudioContext();
  if (!audioCtx) return;

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

  // Safari fix (2a): anchor at 0 before ramping up
  envGain.gain.setValueAtTime(0, now);

  // Attack — ramp from 0 to velocity over attack time
  // Use a small epsilon so the ramp has a non-zero duration, which
  // avoids a Safari edge case where a zero-duration ramp is ignored.
  const attackEnd = now + Math.max(params.attack, 0.001);
  envGain.gain.linearRampToValueAtTime(velocity, attackEnd);

  // Decay → Sustain
  const decayEnd = attackEnd + Math.max(params.decay, 0.001);
  envGain.gain.linearRampToValueAtTime(params.sustain * velocity, decayEnd);

  osc.connect(envGain);
  envGain.connect(masterGain);
  osc.start(now);

  activeNotes.set(key, { osc, gain: envGain });

  // Highlight on-screen key
  setKeyActive(noteName, true);
}

/**
 * Release a note (note-off).
 *
 * Safari fix (2b): After `cancelScheduledValues` we immediately call
 * `setValueAtTime` at the same timestamp so Safari's scheduler has a
 * concrete starting point for the release ramp.
 *
 * Safari fix (2c): Guard `osc.stop()` so it never receives a time in
 * the past, which throws a DOMException in Safari.
 *
 * @param {string} noteName
 * @param {number} octave
 */
function noteOff(noteName, octave) {
  const key  = `${noteName}-${octave}`;
  const node = activeNotes.get(key);
  if (!node) return;

  const { osc, gain: envGain } = node;
  const now = audioCtx.currentTime;

  // Safari fix (2b): cancel then immediately re-anchor the current value
  envGain.gain.cancelScheduledValues(now);
  envGain.gain.setValueAtTime(envGain.gain.value, now);

  const releaseEnd = now + Math.max(params.release, 0.001);
  envGain.gain.linearRampToValueAtTime(0, releaseEnd);

  // Safari fix (2c): never pass a stop time that is already in the past
  const stopTime = Math.max(releaseEnd + 0.01, audioCtx.currentTime + 0.001);
  try {
    osc.stop(stopTime);
  } catch {
    // Fallback: stop immediately if the scheduled time is invalid
    try { osc.stop(); } catch { /* already stopped */ }
  }

  activeNotes.delete(key);

  // Remove highlight if no other octave is playing the same note name
  const stillActive = [...activeNotes.keys()].some(k => k.startsWith(`${noteName}-`));
  if (!stillActive) setKeyActive(noteName, false);
}

/** Release all currently-sounding notes immediately (e.g. on blur). */
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

    // Track whether this button's current press was initiated via a pointer
    // event so that the touch fallback doesn't double-trigger on browsers
    // that fire both (e.g. Chrome on Android, some iPad browsers).
    let pressedViaPointer = false;

    // ── Pointer events (mouse + stylus + modern touch) ────────────────────
    btn.addEventListener('pointerdown', e => {
      e.preventDefault(); // prevent focus stealing / scroll
      pressedViaPointer = true;
      noteOn(note, currentOctave, 0.8);
    });
    btn.addEventListener('pointerup', () => {
      pressedViaPointer = false;
      noteOff(note, currentOctave);
    });
    btn.addEventListener('pointerleave', () => {
      pressedViaPointer = false;
      noteOff(note, currentOctave);
    });

    // ── Touch events — Safari iOS fallback ────────────────────────────────
    // iOS Safari fires pointer events but can miss pointerup/pointerleave
    // when a touch ends outside the element. touchend / touchcancel are
    // always reliable on Safari. We skip these if pointerdown already fired
    // to avoid double-triggering on browsers that support both event models.
    btn.addEventListener('touchstart', e => {
      if (pressedViaPointer) return; // already handled by pointerdown
      e.preventDefault();
      noteOn(note, currentOctave, 0.8);
    }, { passive: false });

    btn.addEventListener('touchend', e => {
      if (pressedViaPointer) return;
      e.preventDefault();
      noteOff(note, currentOctave);
    }, { passive: false });

    btn.addEventListener('touchcancel', e => {
      if (pressedViaPointer) return;
      e.preventDefault();
      noteOff(note, currentOctave);
    }, { passive: false });

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

  // R — toggle recording
  if (e.key.toLowerCase() === 'r') {
    e.preventDefault();
    if (mediaRecorder?.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
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
  // Force reflow so the animation restarts cleanly
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
  // Web MIDI is not supported in Safari (as of 2025). Show a friendly
  // informational message rather than an alarming "error" state so that
  // Safari users understand the rest of the synth still works.
  if (!navigator.requestMIDIAccess) {
    setMidiStatus('MIDI not supported in this browser — keyboard & mouse still work', 'unsupported');
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

    // Sync display on input (live feedback while dragging)
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      params[param] = v;

      if (display) display.textContent = format(v);

      // Apply volume change immediately to master gain
      if (param === 'volume' && masterGain && audioCtx) {
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

// ─── Tab navigation ───────────────────────────────────────────────────────────

/**
 * Simple accessible tab switcher.
 *
 * - Tabs use role="tab" / aria-selected / aria-controls.
 * - Panels use role="tabpanel" / aria-labelledby.
 * - Arrow-key navigation between tabs (ARIA authoring practice).
 * - Shows the universal transport bar when a sequencer tab is active.
 */
function initTabs() {
  const tabList  = document.querySelector('[role="tablist"]');
  if (!tabList) return;

  const tabs   = [...tabList.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));

  function activateTab(tab) {
    tabs.forEach((t, i) => {
      const isSelected = t === tab;
      t.setAttribute('aria-selected', String(isSelected));
      if (panels[i]) {
        panels[i].classList.toggle('tab-panel--active', isSelected);
      }
    });

    // Lazily initialise the bass sequencer the first time its tab is shown
    if (tab.id === 'tab-bass') {
      initBassSequencer();
    }
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activateTab(tab));

    // Arrow-key navigation
    tab.addEventListener('keydown', e => {
      let next = null;
      if (e.key === 'ArrowRight') {
        next = tabs[(i + 1) % tabs.length];
      } else if (e.key === 'ArrowLeft') {
        next = tabs[(i - 1 + tabs.length) % tabs.length];
      } else if (e.key === 'Home') {
        next = tabs[0];
      } else if (e.key === 'End') {
        next = tabs[tabs.length - 1];
      }
      if (next) {
        e.preventDefault();
        next.focus();
        activateTab(next);
      }
    });
  });
}

// ─── Universal transport (BPM + Stop All) ────────────────────────────────────

function initUniversalTransport() {
  const bpmInput = document.getElementById('universal-bpm');
  const bpmValue = document.getElementById('universal-bpm-value');
  const stopAllBtn = document.getElementById('stop-all-btn');

  if (bpmInput) {
    bpmInput.addEventListener('input', () => {
      const bpm = parseInt(bpmInput.value, 10);
      if (bpmValue) bpmValue.textContent = bpm;
      // Push to both sequencers
      setDrumBpm(bpm);
      setBassBpm(bpm);
    });
    if (bpmValue) bpmValue.textContent = bpmInput.value;
  }

  if (stopAllBtn) {
    stopAllBtn.addEventListener('click', () => {
      stopDrumMachine();
      stopBassSequencer();
    });
  }
}

// ─── Recording System ─────────────────────────────────────────────────────────
//
// All three instruments (synth, drum machine, bass sequencer) share the single
// AudioContext owned by instruments.js. The drum and bass modules receive this
// context via setSharedAudioContext() at boot time, so every node in every
// module belongs to the same context graph.
//
// This means we only need ONE MediaStreamDestination — we connect the shared
// masterGain (which already receives all instrument output through the mixer
// gain nodes exported by each module) to that destination and record it.
//
// Architecture:
//   synthEnvGain  ──┐
//   drumMasterGain──┤──► sharedMasterGain ──► audioCtx.destination
//   bassMasterGain──┘         │
//                             └──► recordingDest (when recording)
//
// ─────────────────────────────────────────────────────────────────────────────

let mediaRecorder = null;
let recordingChunks = [];
let recordingStartTime = 0;
let recordingTimerInterval = null;

/** Persistent MediaStreamDestination — created once and kept alive. */
let recordingDest = null;

/**
 * In-memory list of completed recordings.
 * Each entry: { blob: Blob, name: string, duration: number }
 */
const recordings = [];

/**
 * Pick the best supported MIME type for MediaRecorder.
 * Safari 14.1+ supports audio/mp4; Chrome/Firefox prefer audio/webm;codecs=opus.
 * Falls back to the empty string (browser default) if neither is supported.
 */
function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return ''; // let the browser decide
}

/**
 * Ensure the shared AudioContext exists, then wire all instrument gain nodes
 * through a single MediaStreamDestination. Safe to call multiple times —
 * subsequent calls are no-ops once recordingDest is created.
 *
 * Returns true if everything is ready, false if the AudioContext isn't up yet.
 */
function ensureRecordingDest() {
  // AudioContext must exist before we can create any nodes
  ensureAudioContext();
  if (!audioCtx || !masterGain) return false;

  if (recordingDest) return true; // already set up

  // Create the destination on the shared context
  recordingDest = audioCtx.createMediaStreamDestination();

  // Connect the shared master gain → recording destination.
  // Because drum and bass modules write into this same masterGain (they call
  // setSharedAudioContext which gives them the same audioCtx and they connect
  // their own gain nodes into this masterGain), all audio flows through here.
  masterGain.connect(recordingDest);

  return true;
}

function startRecording() {
  // Make sure the AudioContext and recording destination are ready
  if (!ensureRecordingDest()) {
    console.warn('[recording] AudioContext not ready — click anywhere on the page first to unlock audio, then try again.');
    return;
  }

  // Create a fresh MediaRecorder each time so we get a clean recording
  const mimeType = getSupportedMimeType();
  try {
    mediaRecorder = new MediaRecorder(
      recordingDest.stream,
      mimeType ? { mimeType } : {}
    );
  } catch (err) {
    console.warn('[recording] MediaRecorder init failed:', err);
    return;
  }

  recordingChunks = [];

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) recordingChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blobType = mediaRecorder.mimeType || 'audio/webm';
    const blob = new Blob(recordingChunks, { type: blobType });
    const duration = (Date.now() - recordingStartTime) / 1000;
    const name = `Recording ${new Date().toLocaleTimeString()}`;
    recordings.push({ blob, name, duration });
    recordingChunks = [];
    renderRecordings();
  };

  recordingStartTime = Date.now();
  mediaRecorder.start();

  // Update button UI
  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) {
    recordBtn.setAttribute('aria-pressed', 'true');
    recordBtn.textContent = '⏹ Stop';
  }

  // Show and start the elapsed-time counter
  const recordTime = document.getElementById('record-time');
  if (recordTime) {
    recordTime.hidden = false;
    recordTime.textContent = '0:00';
  }

  recordingTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - recordingStartTime) / 1000;
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    if (recordTime) {
      recordTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }, 250);
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

  mediaRecorder.stop();
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;

  // Reset button UI
  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) {
    recordBtn.setAttribute('aria-pressed', 'false');
    recordBtn.textContent = '● Record';
  }

  const recordTime = document.getElementById('record-time');
  if (recordTime) {
    recordTime.hidden = true;
    recordTime.textContent = '0:00';
  }
}

/**
 * Re-render the recordings list section.
 * Called after every add or delete.
 */
function renderRecordings() {
  const section = document.getElementById('recordings-section');
  const list    = document.getElementById('recordings-list');
  if (!section || !list) return;

  if (recordings.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = '';

  recordings.forEach((recording, index) => {
    const card = document.createElement('div');
    card.className = 'recording-card';

    const mins = Math.floor(recording.duration / 60);
    const secs = Math.floor(recording.duration % 60);
    const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    // Create a fresh object URL for each render pass
    const url    = URL.createObjectURL(recording.blob);
    const sizeKB = (recording.blob.size / 1024).toFixed(1);

    card.innerHTML = `
      <div class="recording-info">
        <div class="recording-name">${recording.name}</div>
        <div class="recording-meta">${durationStr} • ${sizeKB} KB</div>
      </div>
      <audio controls src="${url}" preload="metadata"></audio>
      <div class="recording-controls">
        <button class="recording-btn" data-index="${index}" data-action="download"
          aria-label="Download ${recording.name}">
          ↓ Download
        </button>
        <button class="recording-btn recording-btn--delete" data-index="${index}" data-action="delete"
          aria-label="Delete ${recording.name}">
          ✕ Delete
        </button>
      </div>
    `;

    list.appendChild(card);
  });

  // Attach event listeners after innerHTML is set
  list.querySelectorAll('[data-action="download"]').forEach(btn => {
    btn.addEventListener('click', () => downloadRecording(parseInt(btn.dataset.index, 10)));
  });

  list.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteRecording(parseInt(btn.dataset.index, 10)));
  });
}

function downloadRecording(index) {
  const recording = recordings[index];
  if (!recording) return;

  const url  = URL.createObjectURL(recording.blob);
  const ext  = recording.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const filename = `${recording.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${ext}`;

  const a = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke after a short delay to allow the download to start
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deleteRecording(index) {
  recordings.splice(index, 1);
  renderRecordings();
}

/** Wire up the record button toggle. */
function attachRecordButton() {
  const recordBtn = document.getElementById('record-btn');
  if (!recordBtn) return;

  recordBtn.addEventListener('click', () => {
    if (mediaRecorder?.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

import { initDrumMachine, setDrumBpm, stopDrumMachine, setSharedAudioContext as setDrumContext } from './drum-machine.js';
import { initBassSequencer, setBassBpm, stopBassSequencer, setSharedAudioContext as setBassContext } from './bass-sequencer.js';

buildKeyboard();
initControls();
initMidi();
initTabs();
initUniversalTransport();

// Ensure the synth AudioContext is created before injecting it into the
// sub-modules so all instruments share one context and one masterGain.
// initAudioContext() is registered on click/touchstart, so we call
// ensureAudioContext() here to create the context on desktop (no gesture
// needed) and then inject it. On iOS the context is created on first gesture
// via initAudioContext; we inject it at that point via the existing listeners.
ensureAudioContext();
if (audioCtx && masterGain) {
  setDrumContext(audioCtx, masterGain);
  setBassContext(audioCtx, masterGain);
}

// Also inject after the first user gesture resolves the AudioContext on iOS
const _origInitAudioContext = initAudioContext;
document.addEventListener('click', () => {
  if (audioCtx && masterGain) {
    setDrumContext(audioCtx, masterGain);
    setBassContext(audioCtx, masterGain);
  }
}, { once: true, passive: true });

initDrumMachine();
attachRecordButton();

document.addEventListener('keydown', handleKeyDown);
document.addEventListener('keyup',   handleKeyUp);
