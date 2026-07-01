/**
 * bass-sequencer.js — 16-step bass line sequencer
 *
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
 */

// ─── Constants ────────────────────────────────────────────────────────────────

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
const LOOKAHEAD_MS         = 100.0;
const SCHEDULE_INTERVAL_MS = 50.0;

/** Absolute AudioContext time for the next step. */
let nextStepTime = 0;

/** Sequencer parameters (kept in sync with UI). */
const params = {
  bpm:      120,
  noteLen:  0.5,   // fraction of one step duration
  waveform: 'sawtooth',
  volume:   0.5,
  attack:   0.005,
  decay:    0.08,
  sustain:  0.5,
  release:  0.15,
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
  masterGain = audioCtx.createGain();
  masterGain.gain.value = params.volume;
  masterGain.connect(audioCtx.destination);
}

/** Schedule a single bass note at a precise AudioContext time. */
function scheduleNote(freq, startTime, stepDur) {
  if (!audioCtx || !masterGain) return;

  const noteDuration = stepDur * params.noteLen;

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
  envGain.gain.linearRampToValueAtTime(0, releaseEnd);

  osc.connect(envGain);
  envGain.connect(masterGain);
  osc.start(startTime);
  osc.stop(releaseEnd + 0.01);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

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
}

// ─── Transport ────────────────────────────────────────────────────────────────

function startSequencer() {
  ensureAudioContext();
  if (!audioCtx) return;

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  isPlaying    = true;
  currentStep  = 0;
  nextStepTime = audioCtx.currentTime + 0.05; // small initial offset

  scheduler();
  updatePlayBtn();
}

function stopSequencer() {
  isPlaying = false;

  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  clearPlayhead();
  updatePlayBtn();
}

function togglePlay() {
  if (isPlaying) {
    stopSequencer();
  } else {
    startSequencer();
  }
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

function buildGrid() {
  const grid = document.getElementById('seq-grid');
  if (!grid) return;

  grid.innerHTML = '';

  for (let i = 0; i < STEPS; i++) {
    const col = document.createElement('div');
    col.className = 'seq-step-col';

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
    sel.className    = 'seq-note-select';
    sel.dataset.step = String(i);
    sel.setAttribute('aria-label', `Note for step ${i + 1}`);

    for (const note of NOTES) {
      const opt       = document.createElement('option');
      opt.value       = note;
      opt.textContent = note;
      if (note === DEFAULT_NOTE) opt.selected = true;
      sel.appendChild(opt);
    }

    sel.addEventListener('change', () => {
      steps[i].note = sel.value;
    });

    col.appendChild(sel);
    grid.appendChild(col);
  }
}

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
}

// ─── Controls ─────────────────────────────────────────────────────────────────

/** Format a time value (seconds) as a human-readable string. */
function formatTime(s) {
  return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`;
}

function initControls() {
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
    const input   = document.getElementById(id);
    const display = document.getElementById(valueId);
    if (!input) return;

    input.addEventListener('input', () => {
      const v       = parseFloat(input.value);
      params[param] = v;
      if (display) display.textContent = format(v);
    });

    if (display) display.textContent = format(parseFloat(input.value));
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

buildGrid();
initControls();
