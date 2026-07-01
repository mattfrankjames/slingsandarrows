/**
 * bass-sequencer.js — 16-step bass line sequencer
 *
<<<<<<< HEAD
 * Features:
 *  - 16 steps, each with an independent note selector
 *  - Transport: play / stop, BPM, note length
 *  - Oscillator waveform selector
 *  - Master volume
 *  - ADSR envelope (collapsible)
 *  - Built-in pattern presets (Classic, Walking, Funk)
 *  - Clear button
 *  - Visual step playhead
 *  - Responsive: collapses to 8 columns on narrow screens
=======
 * Architecture
 * ────────────
 * Timing uses the "two clocks" pattern (Chris Wilson):
 *   - A fast `setTimeout` lookahead scheduler runs every ~25 ms and pushes
 *     note events into the Web Audio timeline up to ~100 ms ahead.
 *   - All actual audio scheduling is done with `audioCtx.currentTime` so
 *     timing is sample-accurate regardless of JS jank.
 *
 * Each of the 16 steps stores:
 *   { active: bool, note: string, octave: number }
 *
 * Safari / iOS notes
 * ──────────────────
 *   - AudioContext must be created + resumed inside a user gesture.
 *   - webkitAudioContext fallback used for older Safari.
 *   - Same ADSR scheduling guards as instruments.js (anchor before ramp,
 *     cancel+re-anchor on release, guarded stop time).
>>>>>>> origin/main
 */

// ─── Constants ────────────────────────────────────────────────────────────────

<<<<<<< HEAD
const STEPS = 16;

/** Bass-range notes available in the per-step selector. */
const NOTES = [
  'E1','F1','F#1','G1','G#1','A1','A#1','B1',
  'C2','C#2','D2','D#2','E2','F2','F#2','G2','G#2','A2','A#2','B2',
  'C3','C#3','D3','D#3','E3','F3','F#3','G3',
];

/** Frequencies for every note in NOTES. */
const NOTE_FREQS = (() => {
  // Equal temperament: A4 = 440 Hz
  // MIDI note for E1 = 28
  const A4_MIDI = 69;
  const A4_FREQ = 440;
  const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  function midiFreq(midi) {
    return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  function noteToMidi(name) {
    // e.g. "F#2" → note index + octave
    const match = name.match(/^([A-G]#?)(\d)$/);
    if (!match) return 60;
    const noteIdx = noteNames.indexOf(match[1]);
    const octave  = parseInt(match[2], 10);
    return (octave + 1) * 12 + noteIdx;
  }

  const map = {};
  for (const n of NOTES) {
    map[n] = midiFreq(noteToMidi(n));
  }
  return map;
})();

/** Default note for each new step. */
const DEFAULT_NOTE = 'E2';

/** Preset patterns: arrays of { active, note } for each of the 16 steps. */
const PRESETS = {
  classic: [
    { active: true,  note: 'E2' },
    { active: false, note: 'E2' },
    { active: false, note: 'E2' },
    { active: true,  note: 'E2' },
    { active: false, note: 'E2' },
    { active: false, note: 'E2' },
    { active: true,  note: 'G2' },
    { active: false, note: 'G2' },
    { active: true,  note: 'A2' },
    { active: false, note: 'A2' },
    { active: false, note: 'A2' },
    { active: true,  note: 'A2' },
    { active: false, note: 'A2' },
    { active: true,  note: 'G2' },
    { active: false, note: 'G2' },
    { active: false, note: 'E2' },
  ],
  walking: [
    { active: true, note: 'E2' },
    { active: true, note: 'F#2' },
    { active: true, note: 'G2' },
    { active: true, note: 'A2' },
    { active: true, note: 'B2' },
    { active: true, note: 'A2' },
    { active: true, note: 'G2' },
    { active: true, note: 'F#2' },
    { active: true, note: 'E2' },
    { active: true, note: 'D2' },
    { active: true, note: 'C2' },
    { active: true, note: 'B1' },
    { active: true, note: 'A1' },
    { active: true, note: 'B1' },
    { active: true, note: 'C2' },
    { active: true, note: 'D2' },
  ],
  funk: [
    { active: true,  note: 'E2' },
    { active: false, note: 'E2' },
    { active: true,  note: 'E2' },
    { active: false, note: 'G2' },
    { active: true,  note: 'A2' },
    { active: false, note: 'A2' },
    { active: false, note: 'A2' },
    { active: true,  note: 'G2' },
    { active: true,  note: 'E2' },
    { active: false, note: 'E2' },
    { active: true,  note: 'E2' },
    { active: true,  note: 'D2' },
    { active: false, note: 'D2' },
    { active: true,  note: 'E2' },
    { active: false, note: 'E2' },
    { active: false, note: 'G2' },
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────

/** Web Audio context — created lazily on first play. */
let audioCtx   = null;
let masterGain = null;

/** Whether the sequencer is currently running. */
let isPlaying = false;

/** Index of the step currently being scheduled (0-based). */
let currentStep = 0;

/** Web Audio scheduler — the ID returned by setTimeout. */
let schedulerTimer = null;

/**
 * The "look-ahead" scheduler uses two values:
 *  - LOOKAHEAD_MS: how far ahead (ms) to schedule notes
 *  - SCHEDULE_INTERVAL_MS: how often the scheduler function runs
 *
 * This keeps audio tight even when the JS thread is busy.
 */
const LOOKAHEAD_MS        = 100.0;
const SCHEDULE_INTERVAL_MS = 50.0;

/** Absolute AudioContext time for the next step. */
let nextStepTime = 0;

/** Sequencer parameters (kept in sync with UI). */
const params = {
  bpm:      120,
  noteLen:  0.5,   // fraction of one step duration
  waveform: 'sawtooth',
  volume:   0.5,
=======
const STEPS        = 16;
const LOOKAHEAD_MS = 25.0;   // how often the scheduler fires (ms)
const SCHEDULE_AHEAD_S = 0.1; // how far ahead to schedule audio (seconds)

/** Notes available per step — two octaves of chromatic scale starting at C2. */
const NOTE_FREQ_OCT4 = {
  C:    261.63, 'C#': 277.18, D:  293.66, 'D#': 311.13,
  E:    329.63, F:   349.23, 'F#': 369.99, G:   391.99,
  'G#': 415.30, A:   440.00, 'A#': 466.16, B:   493.88,
};

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/** Selectable notes for steps: C2 → B3 (two octaves, good bass range). */
const STEP_NOTES = [];
for (const oct of [2, 3]) {
  for (const n of CHROMATIC) {
    STEP_NOTES.push({ note: n, octave: oct });
  }
}
// Add a rest option at index 0 (shift everything up by 1 in the UI)
// We represent "rest" as note === null.

/** Default note for a new active step. */
const DEFAULT_NOTE   = 'E';
const DEFAULT_OCTAVE = 2;

// ─── State ────────────────────────────────────────────────────────────────────

let audioCtx   = null;
let masterGain = null;

/** Per-step data: { active, note, octave } */
const steps = Array.from({ length: STEPS }, () => ({
  active: false,
  note:   DEFAULT_NOTE,
  octave: DEFAULT_OCTAVE,
}));

// Sequencer playback state
let isPlaying      = false;
let currentStep    = 0;
let nextStepTime   = 0.0;   // audioCtx time of the next step
let schedulerTimer = null;

// BPM / note length
let bpm         = 120;
let noteLength  = 0.5; // fraction of a step (0 = silent, 1 = full legato)

// Synth params
const params = {
  waveform: 'sawtooth',
>>>>>>> origin/main
  attack:   0.005,
  decay:    0.08,
  sustain:  0.5,
  release:  0.15,
<<<<<<< HEAD
};

/**
 * Per-step data: active flag + note name.
 * Populated by buildGrid().
 */
const steps = Array.from({ length: STEPS }, () => ({
  active: false,
  note:   DEFAULT_NOTE,
}));

// ─── Audio ────────────────────────────────────────────────────────────────────

function ensureAudioContext() {
  if (audioCtx) return;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;

  audioCtx   = new AC();
=======
  volume:   0.5,
};

// ─── Audio context ────────────────────────────────────────────────────────────

function ensureAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return;
  }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;

  audioCtx = new Ctx();

>>>>>>> origin/main
  masterGain = audioCtx.createGain();
  masterGain.gain.value = params.volume;
  masterGain.connect(audioCtx.destination);
}

<<<<<<< HEAD
/** Schedule a single bass note at a precise AudioContext time. */
function scheduleNote(freq, startTime, stepDuration) {
  if (!audioCtx || !masterGain) return;

  const noteDuration = stepDuration * params.noteLen;

  const osc = audioCtx.createOscillator();
  osc.type            = params.waveform;
  osc.frequency.value = freq;

  const envGain = audioCtx.createGain();
  envGain.gain.setValueAtTime(0, startTime);

  // Attack
  const attackEnd = startTime + Math.max(params.attack, 0.001);
  envGain.gain.linearRampToValueAtTime(1.0, attackEnd);

  // Decay → Sustain
  const decayEnd = attackEnd + Math.max(params.decay, 0.001);
  envGain.gain.linearRampToValueAtTime(params.sustain, decayEnd);

  // Release
  const noteEnd    = startTime + noteDuration;
  const releaseEnd = noteEnd + Math.max(params.release, 0.001);
  envGain.gain.setValueAtTime(params.sustain, noteEnd);
=======
// Unlock on first gesture (iOS Safari requirement)
function unlockAudio() {
  ensureAudioContext();
  if (audioCtx && audioCtx.state === 'running') {
    document.removeEventListener('click',      unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
  }
}
document.addEventListener('click',      unlockAudio, { passive: true });
document.addEventListener('touchstart', unlockAudio, { passive: true });

// ─── Synth engine ─────────────────────────────────────────────────────────────

function getFrequency(note, octave) {
  return NOTE_FREQ_OCT4[note] * Math.pow(2, octave - 4);
}

/**
 * Schedule a single bass note at `startTime` for `duration` seconds.
 * Uses the same Safari-safe ADSR pattern as instruments.js.
 */
function scheduleNote(note, octave, startTime, duration) {
  if (!audioCtx || !masterGain) return;

  const freq    = getFrequency(note, octave);
  const osc     = audioCtx.createOscillator();
  const envGain = audioCtx.createGain();

  osc.type            = params.waveform;
  osc.frequency.value = freq;

  // ADSR envelope
  const t0         = startTime;
  const attackEnd  = t0 + Math.max(params.attack, 0.001);
  const decayEnd   = attackEnd + Math.max(params.decay, 0.001);
  const releaseStart = t0 + Math.max(duration - Math.max(params.release, 0.001), attackEnd - t0 + 0.001);
  const releaseEnd   = releaseStart + Math.max(params.release, 0.001);

  envGain.gain.setValueAtTime(0, t0);
  envGain.gain.linearRampToValueAtTime(1.0, attackEnd);
  envGain.gain.linearRampToValueAtTime(params.sustain, decayEnd);
  envGain.gain.setValueAtTime(params.sustain, releaseStart);
>>>>>>> origin/main
  envGain.gain.linearRampToValueAtTime(0, releaseEnd);

  osc.connect(envGain);
  envGain.connect(masterGain);
<<<<<<< HEAD
  osc.start(startTime);
  osc.stop(releaseEnd + 0.01);
=======

  osc.start(t0);
  const stopTime = Math.max(releaseEnd + 0.01, t0 + 0.001);
  try { osc.stop(stopTime); } catch { try { osc.stop(); } catch { /* ok */ } }
>>>>>>> origin/main
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

<<<<<<< HEAD
/** Duration of one 16th-note step in seconds at the current BPM. */
function stepDuration() {
  // 1 beat = 60 / BPM seconds; 1 step = 1 beat / 4 (16th notes)
  return (60 / params.bpm) / 4;
}

/**
 * Look-ahead scheduler — runs every SCHEDULE_INTERVAL_MS ms.
 * Schedules all steps whose start time falls within the look-ahead window.
 */
function scheduler() {
  if (!audioCtx) return;

  const lookAheadSec = LOOKAHEAD_MS / 1000;

  while (nextStepTime < audioCtx.currentTime + lookAheadSec) {
    scheduleStep(currentStep, nextStepTime);

    // Advance
    nextStepTime += stepDuration();
    currentStep   = (currentStep + 1) % STEPS;
  }

  schedulerTimer = setTimeout(scheduler, SCHEDULE_INTERVAL_MS);
}

/** Schedule (or skip) a single step. Also updates the visual playhead. */
function scheduleStep(stepIdx, time) {
  const step = steps[stepIdx];

  if (step.active) {
    const freq = NOTE_FREQS[step.note];
    if (freq) scheduleNote(freq, time, stepDuration());
  }

  // Update visual playhead at the correct time using AudioContext timing
  const delay = Math.max(0, (time - audioCtx.currentTime) * 1000);
  setTimeout(() => updatePlayhead(stepIdx), delay);
=======
/** Duration of one step in seconds given current BPM (16th notes). */
function stepDuration() {
  // One bar = 4 beats; 16 steps per bar → each step = 1 beat / 4
  return (60.0 / bpm) / 4;
}

function scheduleStep(stepIndex, time) {
  const step = steps[stepIndex];
  if (step.active) {
    const dur = stepDuration() * noteLength;
    scheduleNote(step.note, step.octave, time, dur);
  }

  // Schedule the visual playhead update to fire roughly when the step sounds.
  // We use setTimeout with the delta from now to the step time.
  const delta = (time - audioCtx.currentTime) * 1000;
  setTimeout(() => updatePlayhead(stepIndex), Math.max(0, delta));
}

function scheduler() {
  if (!audioCtx) return;

  while (nextStepTime < audioCtx.currentTime + SCHEDULE_AHEAD_S) {
    scheduleStep(currentStep, nextStepTime);
    nextStepTime += stepDuration();
    currentStep   = (currentStep + 1) % STEPS;
  }
>>>>>>> origin/main
}

// ─── Transport ────────────────────────────────────────────────────────────────

function startSequencer() {
  ensureAudioContext();
  if (!audioCtx) return;

<<<<<<< HEAD
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  isPlaying   = true;
  currentStep = 0;
  nextStepTime = audioCtx.currentTime + 0.05; // small initial offset

  scheduler();
  updatePlayBtn();
=======
  isPlaying    = true;
  currentStep  = 0;
  nextStepTime = audioCtx.currentTime + 0.05; // small lead-in

  schedulerTimer = setInterval(scheduler, LOOKAHEAD_MS);
  updateTransportUI();
>>>>>>> origin/main
}

function stopSequencer() {
  isPlaying = false;
<<<<<<< HEAD

  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  clearPlayhead();
  updatePlayBtn();
}

function togglePlay() {
=======
  clearInterval(schedulerTimer);
  schedulerTimer = null;

  // Clear visual playhead
  clearPlayhead();
  updateTransportUI();
}

function togglePlayback() {
>>>>>>> origin/main
  if (isPlaying) {
    stopSequencer();
  } else {
    startSequencer();
  }
}

<<<<<<< HEAD
// ─── Grid ─────────────────────────────────────────────────────────────────────

function buildGrid() {
  const grid = document.getElementById('seq-grid');
  if (!grid) return;

=======
// ─── Visual playhead ──────────────────────────────────────────────────────────

let lastHighlightedStep = -1;

function updatePlayhead(stepIndex) {
  // Remove highlight from previous step
  if (lastHighlightedStep >= 0) {
    const prev = document.querySelector(`.seq-step[data-step="${lastHighlightedStep}"]`);
    prev?.classList.remove('seq-step--playing');
  }
  const current = document.querySelector(`.seq-step[data-step="${stepIndex}"]`);
  current?.classList.add('seq-step--playing');
  lastHighlightedStep = stepIndex;
}

function clearPlayhead() {
  document.querySelectorAll('.seq-step--playing').forEach(el =>
    el.classList.remove('seq-step--playing')
  );
  lastHighlightedStep = -1;
}

function updateTransportUI() {
  const btn = document.getElementById('seq-play-btn');
  if (!btn) return;
  btn.textContent = isPlaying ? '⏹ Stop' : '▶ Play';
  btn.setAttribute('aria-pressed', String(isPlaying));
}

// ─── Step grid UI ─────────────────────────────────────────────────────────────

/**
 * Render a note label like "E2" or "C#3".
 */
function noteLabel(note, octave) {
  return `${note}${octave}`;
}

/**
 * Build the 16-step grid in the DOM.
 * Each step is a column containing:
 *   - A note selector (dropdown)
 *   - A toggle button (active / inactive)
 */
function buildGrid() {
  const grid = document.getElementById('seq-grid');
  if (!grid) return;
>>>>>>> origin/main
  grid.innerHTML = '';

  for (let i = 0; i < STEPS; i++) {
    const col = document.createElement('div');
    col.className = 'seq-step-col';

<<<<<<< HEAD
    // Beat marker (1-indexed, shown at steps 0, 4, 8, 12)
    const beatMark = document.createElement('span');
    beatMark.className = i % 4 === 0
      ? 'seq-beat-mark'
      : 'seq-beat-mark seq-beat-mark--spacer';
    beatMark.textContent = i % 4 === 0 ? String(i / 4 + 1) : ' ';
    col.appendChild(beatMark);

    // Step toggle button
    const btn = document.createElement('button');
    btn.type          = 'button';
    btn.className     = 'seq-step';
    btn.dataset.step  = String(i);
    btn.setAttribute('aria-label', `Step ${i + 1}`);
    btn.setAttribute('aria-pressed', 'false');

    const num = document.createElement('span');
    num.className   = 'seq-step-num';
    num.textContent = String(i + 1);
    btn.appendChild(num);

    btn.addEventListener('click', () => toggleStep(i));
    col.appendChild(btn);

    // Note selector
    const sel = document.createElement('select');
    sel.className = 'seq-note-select';
    sel.dataset.step = String(i);
    sel.setAttribute('aria-label', `Note for step ${i + 1}`);

    for (const note of NOTES) {
      const opt   = document.createElement('option');
      opt.value   = note;
      opt.textContent = note;
      if (note === DEFAULT_NOTE) opt.selected = true;
      sel.appendChild(opt);
    }

    sel.addEventListener('change', () => {
      steps[i].note = sel.value;
    });

    col.appendChild(sel);
=======
    // Beat marker (every 4 steps = 1 beat)
    const beatNum = Math.floor(i / 4) + 1;
    const isFirstInBeat = i % 4 === 0;

    // Note selector
    const select = document.createElement('select');
    select.className = 'seq-note-select';
    select.id        = `seq-note-${i}`;
    select.setAttribute('aria-label', `Step ${i + 1} note`);

    // Build options: rest + all notes
    const restOpt = document.createElement('option');
    restOpt.value       = 'rest';
    restOpt.textContent = '—';
    select.appendChild(restOpt);

    for (const { note, octave } of STEP_NOTES) {
      const opt = document.createElement('option');
      opt.value       = `${note}|${octave}`;
      opt.textContent = noteLabel(note, octave);
      if (note === steps[i].note && octave === steps[i].octave) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      const val = select.value;
      if (val === 'rest') {
        steps[i].active = false;
        btn.classList.remove('seq-step--active');
      } else {
        const [note, octave] = val.split('|');
        steps[i].note   = note;
        steps[i].octave = parseInt(octave, 10);
      }
    });

    // Toggle button
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = `seq-step${steps[i].active ? ' seq-step--active' : ''}`;
    btn.dataset.step = String(i);
    btn.setAttribute('aria-label', `Step ${i + 1}`);
    btn.setAttribute('aria-pressed', String(steps[i].active));

    // Step number label inside button
    const label = document.createElement('span');
    label.className   = 'seq-step-num';
    label.textContent = String(i + 1);
    label.setAttribute('aria-hidden', 'true');
    btn.appendChild(label);

    // Beat accent line above first step of each beat
    if (isFirstInBeat) {
      const beatMark = document.createElement('span');
      beatMark.className   = 'seq-beat-mark';
      beatMark.textContent = beatNum;
      beatMark.setAttribute('aria-hidden', 'true');
      col.appendChild(beatMark);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'seq-beat-mark seq-beat-mark--spacer';
      spacer.setAttribute('aria-hidden', 'true');
      col.appendChild(spacer);
    }

    btn.addEventListener('click', () => {
      steps[i].active = !steps[i].active;
      btn.classList.toggle('seq-step--active', steps[i].active);
      btn.setAttribute('aria-pressed', String(steps[i].active));

      // Sync note selector: if activating and rest was selected, pick default
      if (steps[i].active && select.value === 'rest') {
        const defaultVal = `${DEFAULT_NOTE}|${DEFAULT_OCTAVE}`;
        select.value = defaultVal;
        steps[i].note   = DEFAULT_NOTE;
        steps[i].octave = DEFAULT_OCTAVE;
      }
    });

    col.appendChild(btn);
    col.appendChild(select);
>>>>>>> origin/main
    grid.appendChild(col);
  }
}

<<<<<<< HEAD
function toggleStep(idx) {
  steps[idx].active = !steps[idx].active;

  const btn = document.querySelector(`.seq-step[data-step="${idx}"]`);
  if (!btn) return;

  btn.classList.toggle('seq-step--active', steps[idx].active);
  btn.setAttribute('aria-pressed', String(steps[idx].active));
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;

  preset.forEach((p, i) => {
    steps[i].active = p.active;
    steps[i].note   = p.note;

    const btn = document.querySelector(`.seq-step[data-step="${i}"]`);
    if (btn) {
      btn.classList.toggle('seq-step--active', p.active);
      btn.setAttribute('aria-pressed', String(p.active));
    }

    const sel = document.querySelector(`.seq-note-select[data-step="${i}"]`);
    if (sel) sel.value = p.note;
  });
}

function clearGrid() {
  for (let i = 0; i < STEPS; i++) {
    steps[i].active = false;
    steps[i].note   = DEFAULT_NOTE;

    const btn = document.querySelector(`.seq-step[data-step="${i}"]`);
    if (btn) {
      btn.classList.remove('seq-step--active');
      btn.setAttribute('aria-pressed', 'false');
    }

    const sel = document.querySelector(`.seq-note-select[data-step="${i}"]`);
    if (sel) sel.value = DEFAULT_NOTE;
  }
}

// ─── Playhead ─────────────────────────────────────────────────────────────────

let lastPlayheadStep = -1;

function updatePlayhead(stepIdx) {
  if (!isPlaying) return;

  // Remove previous highlight
  if (lastPlayheadStep >= 0) {
    const prev = document.querySelector(`.seq-step[data-step="${lastPlayheadStep}"]`);
    prev?.classList.remove('seq-step--playing');
  }

  const cur = document.querySelector(`.seq-step[data-step="${stepIdx}"]`);
  cur?.classList.add('seq-step--playing');

  lastPlayheadStep = stepIdx;
}

function clearPlayhead() {
  if (lastPlayheadStep >= 0) {
    const prev = document.querySelector(`.seq-step[data-step="${lastPlayheadStep}"]`);
    prev?.classList.remove('seq-step--playing');
    lastPlayheadStep = -1;
  }
}

// ─── Play button ──────────────────────────────────────────────────────────────

function updatePlayBtn() {
  const btn = document.getElementById('seq-play-btn');
  if (!btn) return;

  btn.setAttribute('aria-pressed', String(isPlaying));
  btn.textContent = isPlaying ? '■ Stop' : '▶ Play';
=======
// ─── Preset patterns ──────────────────────────────────────────────────────────

const PRESETS = {
  clear: () => {
    steps.forEach(s => { s.active = false; });
  },
  classic: () => {
    // Classic root-fifth bass pattern in E2
    const pattern = [
      { n: 'E', o: 2 }, null,           { n: 'E', o: 2 }, null,
      { n: 'E', o: 2 }, null,           { n: 'B', o: 2 }, null,
      { n: 'E', o: 2 }, null,           { n: 'E', o: 2 }, { n: 'G', o: 2 },
      { n: 'A', o: 2 }, { n: 'A', o: 2 }, null,           null,
    ];
    steps.forEach((s, i) => {
      s.active = pattern[i] !== null;
      if (pattern[i]) { s.note = pattern[i].n; s.octave = pattern[i].o; }
    });
  },
  walking: () => {
    // Walking bass feel — mostly 8th notes
    const pattern = [
      { n: 'C',  o: 2 }, { n: 'E',  o: 2 }, { n: 'G',  o: 2 }, { n: 'B',  o: 2 },
      { n: 'A',  o: 2 }, { n: 'G',  o: 2 }, { n: 'F',  o: 2 }, { n: 'E',  o: 2 },
      { n: 'D',  o: 2 }, { n: 'F',  o: 2 }, { n: 'A',  o: 2 }, { n: 'C',  o: 3 },
      { n: 'B',  o: 2 }, { n: 'G',  o: 2 }, { n: 'E',  o: 2 }, { n: 'D',  o: 2 },
    ];
    steps.forEach((s, i) => {
      s.active = true;
      s.note   = pattern[i].n;
      s.octave = pattern[i].o;
    });
  },
  funk: () => {
    // Syncopated funk groove
    const pattern = [
      { n: 'E', o: 2 }, null,           { n: 'G', o: 2 }, null,
      { n: 'A', o: 2 }, { n: 'A', o: 2 }, null,           { n: 'E', o: 2 },
      null,             { n: 'E', o: 2 }, { n: 'G', o: 2 }, null,
      { n: 'A', o: 2 }, null,           { n: 'D', o: 3 }, null,
    ];
    steps.forEach((s, i) => {
      s.active = pattern[i] !== null;
      if (pattern[i]) { s.note = pattern[i].n; s.octave = pattern[i].o; }
    });
  },
};

function applyPreset(name) {
  if (!PRESETS[name]) return;
  PRESETS[name]();
  rebuildGrid();
}

function rebuildGrid() {
  buildGrid();
>>>>>>> origin/main
}

// ─── Controls ─────────────────────────────────────────────────────────────────

<<<<<<< HEAD
/** Format a time value (seconds) as a human-readable string. */
=======
>>>>>>> origin/main
function formatTime(s) {
  return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`;
}

function initControls() {
<<<<<<< HEAD
  // Play / stop
  document.getElementById('seq-play-btn')
    ?.addEventListener('click', togglePlay);

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.preset;
      if (name) applyPreset(name);
    });
  });

  // Clear
  document.getElementById('seq-clear-btn')
    ?.addEventListener('click', clearGrid);

  // BPM
  const bpmInput = document.getElementById('seq-bpm');
  const bpmValue = document.getElementById('seq-bpm-value');
  bpmInput?.addEventListener('input', () => {
    params.bpm = parseInt(bpmInput.value, 10);
    if (bpmValue) bpmValue.textContent = params.bpm;
  });
  if (bpmValue && bpmInput) bpmValue.textContent = bpmInput.value;

  // Note length
  const noteLenInput = document.getElementById('seq-note-len');
  const noteLenValue = document.getElementById('seq-note-len-value');
  noteLenInput?.addEventListener('input', () => {
    params.noteLen = parseFloat(noteLenInput.value);
    if (noteLenValue) noteLenValue.textContent = `${Math.round(params.noteLen * 100)}%`;
  });
  if (noteLenValue && noteLenInput) {
    noteLenValue.textContent = `${Math.round(parseFloat(noteLenInput.value) * 100)}%`;
  }

  // Waveform
  const waveformSel = document.getElementById('seq-waveform');
  waveformSel?.addEventListener('change', () => {
    params.waveform = waveformSel.value;
  });

  // Volume
  const volInput = document.getElementById('seq-volume');
  const volValue = document.getElementById('seq-volume-value');
  volInput?.addEventListener('input', () => {
    params.volume = parseFloat(volInput.value);
    if (volValue) volValue.textContent = `${Math.round(params.volume * 100)}%`;
    if (masterGain && audioCtx) {
      masterGain.gain.setTargetAtTime(params.volume, audioCtx.currentTime, 0.01);
    }
  });
  if (volValue && volInput) {
    volValue.textContent = `${Math.round(parseFloat(volInput.value) * 100)}%`;
  }

  // ADSR sliders
  const adsrSliders = [
    { id: 'seq-attack',  valueId: 'seq-attack-value',  param: 'attack',  format: formatTime },
    { id: 'seq-decay',   valueId: 'seq-decay-value',   param: 'decay',   format: formatTime },
    { id: 'seq-sustain', valueId: 'seq-sustain-value', param: 'sustain', format: v => `${Math.round(v * 100)}%` },
    { id: 'seq-release', valueId: 'seq-release-value', param: 'release', format: formatTime },
  ];

  adsrSliders.forEach(({ id, valueId, param, format }) => {
=======
  // Play / Stop
  document.getElementById('seq-play-btn')
    ?.addEventListener('click', togglePlayback);

  // BPM slider
  const bpmSlider  = document.getElementById('seq-bpm');
  const bpmDisplay = document.getElementById('seq-bpm-value');
  bpmSlider?.addEventListener('input', () => {
    bpm = parseInt(bpmSlider.value, 10);
    if (bpmDisplay) bpmDisplay.textContent = bpm;
  });
  if (bpmDisplay) bpmDisplay.textContent = bpm;

  // Note length slider
  const lenSlider  = document.getElementById('seq-note-len');
  const lenDisplay = document.getElementById('seq-note-len-value');
  lenSlider?.addEventListener('input', () => {
    noteLength = parseFloat(lenSlider.value);
    if (lenDisplay) lenDisplay.textContent = `${Math.round(noteLength * 100)}%`;
  });
  if (lenDisplay) lenDisplay.textContent = `${Math.round(noteLength * 100)}%`;

  // Waveform
  const waveEl = document.getElementById('seq-waveform');
  waveEl?.addEventListener('change', () => { params.waveform = waveEl.value; });

  // ADSR + volume
  const sliders = [
    { id: 'seq-attack',  valueId: 'seq-attack-value',  param: 'attack',  fmt: formatTime },
    { id: 'seq-decay',   valueId: 'seq-decay-value',   param: 'decay',   fmt: formatTime },
    { id: 'seq-sustain', valueId: 'seq-sustain-value', param: 'sustain', fmt: v => `${Math.round(v * 100)}%` },
    { id: 'seq-release', valueId: 'seq-release-value', param: 'release', fmt: formatTime },
    { id: 'seq-volume',  valueId: 'seq-volume-value',  param: 'volume',  fmt: v => `${Math.round(v * 100)}%` },
  ];

  sliders.forEach(({ id, valueId, param, fmt }) => {
>>>>>>> origin/main
    const input   = document.getElementById(id);
    const display = document.getElementById(valueId);
    if (!input) return;

    input.addEventListener('input', () => {
<<<<<<< HEAD
      const v    = parseFloat(input.value);
      params[param] = v;
      if (display) display.textContent = format(v);
    });

    if (display) display.textContent = format(parseFloat(input.value));
  });
=======
      const v = parseFloat(input.value);
      params[param] = v;
      if (display) display.textContent = fmt(v);
      if (param === 'volume' && masterGain && audioCtx) {
        masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.01);
      }
    });
    if (display) display.textContent = fmt(parseFloat(input.value));
  });

  // Preset buttons
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // Clear button
  document.getElementById('seq-clear-btn')
    ?.addEventListener('click', () => applyPreset('clear'));
>>>>>>> origin/main
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

buildGrid();
initControls();
<<<<<<< HEAD
=======
updateTransportUI();
>>>>>>> origin/main
