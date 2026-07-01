/**
 * bass-sequencer.js — 16-step bass line sequencer
 *
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
 */

// ─── Constants ────────────────────────────────────────────────────────────────

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
  attack:   0.005,
  decay:    0.08,
  sustain:  0.5,
  release:  0.15,
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

  masterGain = audioCtx.createGain();
  masterGain.gain.value = params.volume;
  masterGain.connect(audioCtx.destination);
}

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
  envGain.gain.linearRampToValueAtTime(0, releaseEnd);

  osc.connect(envGain);
  envGain.connect(masterGain);

  osc.start(t0);
  const stopTime = Math.max(releaseEnd + 0.01, t0 + 0.001);
  try { osc.stop(stopTime); } catch { try { osc.stop(); } catch { /* ok */ } }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

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
}

// ─── Transport ────────────────────────────────────────────────────────────────

function startSequencer() {
  ensureAudioContext();
  if (!audioCtx) return;

  isPlaying    = true;
  currentStep  = 0;
  nextStepTime = audioCtx.currentTime + 0.05; // small lead-in

  schedulerTimer = setInterval(scheduler, LOOKAHEAD_MS);
  updateTransportUI();
}

function stopSequencer() {
  isPlaying = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;

  // Clear visual playhead
  clearPlayhead();
  updateTransportUI();
}

function togglePlayback() {
  if (isPlaying) {
    stopSequencer();
  } else {
    startSequencer();
  }
}

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
  grid.innerHTML = '';

  for (let i = 0; i < STEPS; i++) {
    const col = document.createElement('div');
    col.className = 'seq-step-col';

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
    grid.appendChild(col);
  }
}

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
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function formatTime(s) {
  return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`;
}

function initControls() {
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
    const input   = document.getElementById(id);
    const display = document.getElementById(valueId);
    if (!input) return;

    input.addEventListener('input', () => {
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
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

buildGrid();
initControls();
updateTransportUI();
