/**
 * drum-machine.js — 16-step drum machine sequencer
 *
 * Features:
 *  - 16 steps for 4 drum voices: kick, snare, hi-hat, tom
 *  - Synthesized drum sounds via Web Audio API (no samples needed)
 *  - Transport: play / stop, BPM control
 *  - Master volume
 *  - Built-in presets (Basic, Funk)
 *  - Clear button
 *  - Visual step playhead
 *  - Look-ahead scheduler for tight timing (same approach as bass-sequencer.js)
 *
 * Safari / iOS compatibility:
 *  - AudioContext created lazily on first play button press
 *  - webkitAudioContext fallback
 *  - exponentialRampToValueAtTime targets clamped to > 0 (Safari throws on 0)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const STEPS = 16;

const DRUMS = ['kick', 'snare', 'hihat', 'tom'];

const DRUM_LABELS = {
  kick:  'Kick',
  snare: 'Snare',
  hihat: 'Hi-Hat',
  tom:   'Tom',
};

/**
 * Look-ahead scheduler constants — mirrors bass-sequencer.js for consistency.
 */
const LOOKAHEAD_MS         = 100.0;
const SCHEDULE_INTERVAL_MS = 50.0;

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Web Audio context — injected by instruments.js via setSharedAudioContext()
 * so all instruments share one context and can be recorded together.
 * Falls back to a locally-created context if called standalone.
 */
let audioCtx   = null;

/**
 * Per-module gain node that sits between drum voices and the shared drumGain.
 * Drum voices → drumGain → sharedMasterGain → destination (+ recordingDest)
 */
let drumGain = null;

/** Whether the sequencer is currently running. */
let isPlaying = false;

/** Index of the next step to be scheduled (0-based). */
let currentStep = 0;

/** setTimeout ID for the look-ahead scheduler. */
let schedulerTimer = null;

/** Absolute AudioContext time for the next step. */
let nextStepTime = 0;

/** Sequencer parameters — kept in sync with UI controls. */
const params = {
  bpm:          120,
  volume:       0.6,
  kickPitch:    150,   // Hz — starting frequency of kick sweep
  kickDecay:    0.45,  // seconds
  snareDecay:   0.22,  // seconds
  hihatDecay:   0.08,  // seconds
  tomDecay:     0.18,  // seconds
};

/**
 * Pattern: 16 steps × 4 drums.
 * pattern[stepIndex][drumName] = boolean
 */
let pattern = buildEmptyPattern();

function buildEmptyPattern() {
  return Array.from({ length: STEPS }, () => ({
    kick:  false,
    snare: false,
    hihat: false,
    tom:   false,
  }));
}

// ─── Presets ──────────────────────────────────────────────────────────────────

const PRESETS = {
  basic: [
    { kick: true,  snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: true,  hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: true,  snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: false },
    { kick: true,  snare: false, hihat: false, tom: false },
    { kick: false, snare: true,  hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
  ],
  funk: [
    { kick: true,  snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: true  },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: true,  hihat: true,  tom: false },
    { kick: true,  snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: true,  snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: true  },
    { kick: false, snare: false, hihat: false, tom: false },
    { kick: false, snare: true,  hihat: true,  tom: false },
    { kick: true,  snare: false, hihat: false, tom: false },
    { kick: false, snare: false, hihat: true,  tom: false },
    { kick: false, snare: false, hihat: false, tom: false },
  ],
};

// ─── Audio context ────────────────────────────────────────────────────────────

/**
 * Called by instruments.js at boot time to inject the shared AudioContext
 * and the shared drumGain node. All drum voices connect into drumGain,
 * which connects into sharedMasterGain — so drum audio flows through the
 * same graph as the synth and bass, and is captured by the single recording
 * destination that instruments.js attaches to sharedMasterGain.
 *
 * @param {AudioContext} ctx
 * @param {GainNode} sharedMasterGain
 */
export function setSharedAudioContext(ctx, sharedMasterGain) {
  audioCtx = ctx;
  drumGain = ctx.createGain();
  drumGain.gain.value = params.volume;
  drumGain.connect(sharedMasterGain);
}

function ensureAudioContext() {
  // If the shared context was injected, we're already good
  if (audioCtx && drumGain) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }

  // Fallback: create a standalone context (e.g. if used without instruments.js)
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;

  audioCtx  = new AC();
  drumGain  = audioCtx.createGain();
  drumGain.gain.value = params.volume;
  drumGain.connect(audioCtx.destination);
}

// ─── Drum synthesis ───────────────────────────────────────────────────────────

/**
 * Synthesise a kick drum: sine oscillator with a fast frequency sweep
 * from kickPitch down to near-silence, shaped by an exponential gain envelope.
 */
function playKick(time) {
  if (!audioCtx || !drumGain) return;

  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.connect(gain);
  gain.connect(drumGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(params.kickPitch, time);
  osc.frequency.exponentialRampToValueAtTime(0.001, time + params.kickDecay);

  gain.gain.setValueAtTime(params.volume * 0.9, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + params.kickDecay);

  osc.start(time);
  osc.stop(time + params.kickDecay + 0.01);
}

/**
 * Synthesise a snare drum: filtered white noise burst.
 * High-pass filter at 3 kHz gives the crisp "snap" of a snare.
 */
function playSnare(time) {
  if (!audioCtx || !drumGain) return;

  const bufferLen  = Math.ceil(audioCtx.sampleRate * params.snareDecay);
  const noiseBuffer = audioCtx.createBuffer(1, bufferLen, audioCtx.sampleRate);
  const data        = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferLen; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise  = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type            = 'highpass';
  filter.frequency.value = 3000;
  filter.Q.value         = 0.5;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(params.volume * 0.75, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + params.snareDecay);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(drumGain);

  noise.start(time);
  noise.stop(time + params.snareDecay + 0.01);
}

/**
 * Synthesise a closed hi-hat: short burst of very high-pass filtered noise.
 */
function playHihat(time) {
  if (!audioCtx || !drumGain) return;

  const bufferLen   = Math.ceil(audioCtx.sampleRate * params.hihatDecay);
  const noiseBuffer = audioCtx.createBuffer(1, bufferLen, audioCtx.sampleRate);
  const data        = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferLen; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise  = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type            = 'highpass';
  filter.frequency.value = 10000;
  filter.Q.value         = 0.8;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(params.volume * 0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + params.hihatDecay);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(drumGain);

  noise.start(time);
  noise.stop(time + params.hihatDecay + 0.01);
}

/**
 * Synthesise a floor tom: sine oscillator with a moderate pitch sweep,
 * lower in pitch and longer in decay than the kick.
 */
function playTom(time) {
  if (!audioCtx || !drumGain) return;

  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.connect(gain);
  gain.connect(drumGain);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, time);
  osc.frequency.exponentialRampToValueAtTime(80, time + params.tomDecay);

  gain.gain.setValueAtTime(params.volume * 0.7, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + params.tomDecay);

  osc.start(time);
  osc.stop(time + params.tomDecay + 0.01);
}

const PLAY_FNS = { kick: playKick, snare: playSnare, hihat: playHihat, tom: playTom };

// ─── Scheduler ────────────────────────────────────────────────────────────────

/** Duration of one 16th-note step in seconds at the current BPM. */
function stepDuration() {
  return (60 / params.bpm) / 4;
}

/** Schedule audio + visual for a single step. */
function scheduleStep(stepIdx, time) {
  const step = pattern[stepIdx];

  DRUMS.forEach(drum => {
    if (step[drum]) PLAY_FNS[drum](time);
  });

  // Visual playhead — delayed to match audio timing
  const delayMs = Math.max(0, (time - audioCtx.currentTime) * 1000);
  setTimeout(() => updatePlayhead(stepIdx), delayMs);
}

/** Look-ahead scheduler — fires every SCHEDULE_INTERVAL_MS. */
function scheduler() {
  if (!audioCtx) return;

  const lookAheadSec = LOOKAHEAD_MS / 1000;

  while (nextStepTime < audioCtx.currentTime + lookAheadSec) {
    scheduleStep(currentStep, nextStepTime);
    nextStepTime += stepDuration();
    currentStep   = (currentStep + 1) % STEPS;
  }

  schedulerTimer = setTimeout(scheduler, SCHEDULE_INTERVAL_MS);
}

// ─── Transport ────────────────────────────────────────────────────────────────

function startSequencer() {
  ensureAudioContext();
  if (!audioCtx) return;

  if (audioCtx.state === 'suspended') audioCtx.resume();

  isPlaying    = true;
  currentStep  = 0;
  nextStepTime = audioCtx.currentTime + 0.05;

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

// ─── Pattern helpers ──────────────────────────────────────────────────────────

function toggleStep(stepIdx, drum) {
  pattern[stepIdx][drum] = !pattern[stepIdx][drum];

  const btn = document.querySelector(
    `#drum-grid .drum-step[data-step="${stepIdx}"][data-drum="${drum}"]`
  );
  if (!btn) return;
  btn.classList.toggle('drum-step--active', pattern[stepIdx][drum]);
  btn.setAttribute('aria-pressed', String(pattern[stepIdx][drum]));
}

function clearPattern() {
  pattern = buildEmptyPattern();

  document.querySelectorAll('#drum-grid .drum-step').forEach(btn => {
    btn.classList.remove('drum-step--active');
    btn.setAttribute('aria-pressed', 'false');
  });
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;

  pattern = preset.map(step => ({ ...step }));

  DRUMS.forEach(drum => {
    for (let i = 0; i < STEPS; i++) {
      const btn = document.querySelector(
        `#drum-grid .drum-step[data-step="${i}"][data-drum="${drum}"]`
      );
      if (!btn) continue;
      btn.classList.toggle('drum-step--active', pattern[i][drum]);
      btn.setAttribute('aria-pressed', String(pattern[i][drum]));
    }
  });
}

// ─── Playhead ─────────────────────────────────────────────────────────────────

let lastPlayheadStep = -1;

function updatePlayhead(stepIdx) {
  if (!isPlaying) return;

  if (lastPlayheadStep >= 0) {
    document.querySelectorAll(
      `#drum-grid .drum-step[data-step="${lastPlayheadStep}"]`
    ).forEach(btn => btn.classList.remove('drum-step--playing'));
  }

  document.querySelectorAll(
    `#drum-grid .drum-step[data-step="${stepIdx}"]`
  ).forEach(btn => btn.classList.add('drum-step--playing'));

  lastPlayheadStep = stepIdx;
}

function clearPlayhead() {
  if (lastPlayheadStep >= 0) {
    document.querySelectorAll(
      `#drum-grid .drum-step[data-step="${lastPlayheadStep}"]`
    ).forEach(btn => btn.classList.remove('drum-step--playing'));
    lastPlayheadStep = -1;
  }
}

// ─── Play button ──────────────────────────────────────────────────────────────

function updatePlayBtn() {
  const btn = document.getElementById('drum-play-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(isPlaying));
  btn.textContent = isPlaying ? '■ Stop' : '▶ Play';
}

// ─── Grid builder ─────────────────────────────────────────────────────────────

function buildGrid() {
  const grid = document.getElementById('drum-grid');
  if (!grid) return;

  grid.innerHTML = '';

  DRUMS.forEach(drum => {
    const row = document.createElement('div');
    row.className = 'drum-row';

    // Row label
    const label = document.createElement('span');
    label.className   = 'drum-label';
    label.textContent = DRUM_LABELS[drum];
    row.appendChild(label);

    // Step buttons
    for (let i = 0; i < STEPS; i++) {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'drum-step';
      btn.dataset.step = String(i);
      btn.dataset.drum = drum;
      btn.setAttribute('aria-label', `${DRUM_LABELS[drum]} step ${i + 1}`);
      btn.setAttribute('aria-pressed', 'false');

      // Beat number hint inside first step of each beat
      if (i % 4 === 0) {
        const mark = document.createElement('span');
        mark.className   = 'drum-beat-mark';
        mark.textContent = String(i / 4 + 1);
        mark.setAttribute('aria-hidden', 'true');
        btn.appendChild(mark);
      }

      btn.addEventListener('click', () => toggleStep(i, drum));
      row.appendChild(btn);
    }

    grid.appendChild(row);
  });
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function initControls() {
  // Play / stop
  document.getElementById('drum-play-btn')
    ?.addEventListener('click', togglePlay);

  // Clear
  document.getElementById('drum-clear-btn')
    ?.addEventListener('click', clearPattern);

  // Presets
  document.querySelectorAll('[data-drum-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.drumPreset));
  });

  // Volume
  const volInput = document.getElementById('drum-volume');
  const volValue = document.getElementById('drum-volume-value');
  volInput?.addEventListener('input', () => {
    params.volume = parseFloat(volInput.value);
    if (volValue) volValue.textContent = `${Math.round(params.volume * 100)}%`;
    if (drumGain && audioCtx) {
      drumGain.gain.setTargetAtTime(params.volume, audioCtx.currentTime, 0.01);
    }
  });
  if (volValue && volInput) {
    volValue.textContent = `${Math.round(parseFloat(volInput.value) * 100)}%`;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Allow instruments.js to push a new BPM value into this module. */
export function setDrumBpm(bpm) {
  params.bpm = bpm;
}

/** Allow instruments.js to stop this sequencer externally. */
export function stopDrumMachine() {
  if (isPlaying) stopSequencer();
}

/**
 * Return the module-level GainNode so the mixer can insert itself
 * between this gain and the shared masterGain.
 * Returns null if the context hasn't been set up yet.
 */
export function getDrumGain() {
  return drumGain;
}



// ─── Bootstrap ────────────────────────────────────────────────────────────────

export function initDrumMachine() {
  buildGrid();
  initControls();
}
