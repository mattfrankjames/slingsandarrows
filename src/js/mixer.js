/**
 * mixer.js — Multi-track audio level control for the Studio page
 *
 * Features:
 *  - Per-track volume fader (0–100%, with dB display)
 *  - Per-track pan knob (L–R, -100 to +100)
 *  - Mute and Solo buttons per track
 *  - Real-time VU meter per track (peak + RMS via AnalyserNode)
 *  - Master bus volume fader
 *  - Master VU meter
 *  - All nodes wired into the shared AudioContext from instruments.js
 *
 * Architecture
 * ────────────
 *  Each instrument module exposes a per-module GainNode (drumGain, bassGain,
 *  synthMasterGain) that already sits between the voices and the shared
 *  masterGain.  The mixer inserts a new layer of nodes *between* the per-
 *  module gain and the shared masterGain:
 *
 *    instrument voices
 *         │
 *    [module gain]   ← owned by drum-machine / bass-sequencer / instruments
 *         │
 *    [track fader]   ← GainNode, value = fader level (0–1)
 *         │
 *    [panner]        ← StereoPannerNode, value = pan (-1 … +1)
 *         │
 *    [mute gain]     ← GainNode, value = 0 (muted) or 1 (unmuted)
 *         │
 *    [analyser]      ← AnalyserNode, feeds VU meter
 *         │
 *    [sharedMasterGain]
 *         │
 *    [masterAnalyser] ← feeds master VU meter
 *         │
 *    audioCtx.destination (+ recordingDest)
 *
 * Because the module gains are already connected to sharedMasterGain by
 * instruments.js, we *disconnect* them from sharedMasterGain and re-connect
 * them through the mixer chain.  This is safe because disconnect() without
 * arguments removes all existing connections from that node.
 *
 * The mixer is initialised lazily when its tab is first activated, after
 * instruments.js has already set up the shared context.
 */

// ─── Track definitions ────────────────────────────────────────────────────────

/**
 * Each track descriptor binds a human-readable label to the GainNode that
 * the corresponding instrument module exposes.  The `getGain` function is
 * called at init time (after the shared context is ready) to retrieve the
 * live GainNode.
 *
 * @type {Array<{id: string, label: string, color: string, defaultVolume: number}>}
 */
const TRACK_DEFS = [
  { id: 'synth', label: 'Synth',          color: '#a8d8f5', defaultVolume: 0.80 },
  { id: 'drums', label: 'Drum Machine',   color: '#a8f5a8', defaultVolume: 0.80 },
  { id: 'bass',  label: 'Bass Sequencer', color: '#f5d0a8', defaultVolume: 0.80 },
];

// ─── State ────────────────────────────────────────────────────────────────────

/** Shared AudioContext injected by instruments.js */
let audioCtx = null;

/** The shared masterGain node from instruments.js */
let sharedMasterGain = null;

/**
 * Per-track mixer nodes and state.
 * Populated by initMixerGraph().
 *
 * @type {Map<string, {
 *   trackFader: GainNode,
 *   panner: StereoPannerNode,
 *   muteGain: GainNode,
 *   analyser: AnalyserNode,
 *   volume: number,
 *   pan: number,
 *   muted: boolean,
 *   soloed: boolean,
 * }>}
 */
const tracks = new Map();

/** Master analyser node (sits after sharedMasterGain). */
let masterAnalyser = null;

/** Whether any track is currently soloed. */
let anySoloed = false;

/** rAF handle for the VU meter animation loop. */
let vuRafHandle = null;

/** Whether the mixer graph has been wired up. */
let graphReady = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by instruments.js to hand the mixer the shared AudioContext and
 * the shared masterGain, plus a map of per-module gain nodes.
 *
 * @param {AudioContext} ctx
 * @param {GainNode} masterGain
 * @param {{ synth: GainNode, drums: GainNode, bass: GainNode }} moduleGains
 */
export function initMixer(ctx, masterGain, moduleGains) {
  audioCtx         = ctx;
  sharedMasterGain = masterGain;

  buildMixerGraph(moduleGains);
  buildMixerUI();
  startVuLoop();

  graphReady = true;
}

// ─── Audio graph ──────────────────────────────────────────────────────────────

/**
 * Insert the mixer node chain between each module gain and sharedMasterGain.
 *
 * @param {{ synth: GainNode, drums: GainNode, bass: GainNode }} moduleGains
 */
function buildMixerGraph(moduleGains) {
  TRACK_DEFS.forEach(def => {
    const moduleGain = moduleGains[def.id];
    if (!moduleGain) return;

    // Disconnect the module gain from wherever it was previously connected
    // (instruments.js connected it directly to sharedMasterGain).
    try { moduleGain.disconnect(); } catch { /* already disconnected */ }

    // ── Track fader (volume) ──
    const trackFader = audioCtx.createGain();
    trackFader.gain.value = def.defaultVolume;

    // ── Stereo panner ──
    let panner;
    if (typeof audioCtx.createStereoPanner === 'function') {
      panner = audioCtx.createStereoPanner();
      panner.pan.value = 0;
    } else {
      // Fallback: plain gain node (no panning) for very old browsers
      panner = audioCtx.createGain();
      panner.gain.value = 1;
      panner._isFallback = true;
    }

    // ── Mute gain ──
    const muteGain = audioCtx.createGain();
    muteGain.gain.value = 1; // unmuted

    // ── Analyser (feeds VU meter) ──
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;

    // Wire: moduleGain → trackFader → panner → muteGain → analyser → masterGain
    moduleGain.connect(trackFader);
    trackFader.connect(panner);
    panner.connect(muteGain);
    muteGain.connect(analyser);
    analyser.connect(sharedMasterGain);

    tracks.set(def.id, {
      moduleGain,
      trackFader,
      panner,
      muteGain,
      analyser,
      volume:  def.defaultVolume,
      pan:     0,
      muted:   false,
      soloed:  false,
    });
  });

  // Master analyser — sits after sharedMasterGain, before destination
  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = 256;
  masterAnalyser.smoothingTimeConstant = 0.6;

  // sharedMasterGain already connects to destination; we tap in parallel
  sharedMasterGain.connect(masterAnalyser);
  // masterAnalyser output goes to destination as well so we can hear it
  // (connecting to destination twice is fine — Web Audio sums the signals,
  //  but since we're only tapping for analysis we connect to a silent gain)
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  masterAnalyser.connect(silentGain);
  silentGain.connect(audioCtx.destination);
}

// ─── UI builder ───────────────────────────────────────────────────────────────

function buildMixerUI() {
  const container = document.getElementById('mixer-tracks');
  if (!container) return;

  container.innerHTML = '';

  TRACK_DEFS.forEach(def => {
    const track = tracks.get(def.id);
    if (!track) return;

    const card = document.createElement('div');
    card.className      = 'mixer-track';
    card.dataset.trackId = def.id;

    // Colour accent strip at the top
    card.style.setProperty('--track-color', def.color);

    card.innerHTML = `
      <div class="mixer-track-header">
        <span class="mixer-track-name">${def.label}</span>
        <div class="mixer-track-btns">
          <button class="mixer-btn mixer-mute-btn" data-track="${def.id}"
            aria-pressed="false" aria-label="Mute ${def.label}" type="button">M</button>
          <button class="mixer-btn mixer-solo-btn" data-track="${def.id}"
            aria-pressed="false" aria-label="Solo ${def.label}" type="button">S</button>
        </div>
      </div>

      <div class="mixer-vu-wrap" aria-hidden="true">
        <canvas class="mixer-vu-canvas" id="vu-${def.id}" width="28" height="120"></canvas>
      </div>

      <div class="mixer-fader-wrap">
        <label class="mixer-label" for="fader-${def.id}">Vol</label>
        <input type="range" class="mixer-fader" id="fader-${def.id}"
          data-track="${def.id}"
          min="0" max="1" step="0.01"
          value="${def.defaultVolume}"
          aria-label="${def.label} volume"
          aria-valuetext="${Math.round(def.defaultVolume * 100)}%">
        <span class="mixer-fader-value" id="fader-val-${def.id}">${Math.round(def.defaultVolume * 100)}%</span>
      </div>

      <div class="mixer-pan-wrap">
        <label class="mixer-label" for="pan-${def.id}">Pan</label>
        <input type="range" class="mixer-pan" id="pan-${def.id}"
          data-track="${def.id}"
          min="-1" max="1" step="0.01"
          value="0"
          aria-label="${def.label} pan"
          aria-valuetext="Center">
        <span class="mixer-pan-value" id="pan-val-${def.id}">C</span>
      </div>
    `;

    container.appendChild(card);
  });

  // Master channel
  const masterCard = document.createElement('div');
  masterCard.className = 'mixer-track mixer-master';
  masterCard.innerHTML = `
    <div class="mixer-track-header">
      <span class="mixer-track-name">Master</span>
    </div>

    <div class="mixer-vu-wrap" aria-hidden="true">
      <canvas class="mixer-vu-canvas" id="vu-master" width="28" height="120"></canvas>
    </div>

    <div class="mixer-fader-wrap">
      <label class="mixer-label" for="fader-master">Vol</label>
      <input type="range" class="mixer-fader" id="fader-master"
        min="0" max="1" step="0.01"
        value="0.8"
        aria-label="Master volume"
        aria-valuetext="80%">
      <span class="mixer-fader-value" id="fader-val-master">80%</span>
    </div>
  `;
  container.appendChild(masterCard);

  attachMixerEvents();
}

function attachMixerEvents() {
  // Volume faders
  document.querySelectorAll('.mixer-fader[data-track]').forEach(input => {
    input.addEventListener('input', () => {
      const trackId = input.dataset.track;
      const v = parseFloat(input.value);
      setTrackVolume(trackId, v);
    });
  });

  // Master fader (no data-track)
  const masterFader = document.getElementById('fader-master');
  const masterVal   = document.getElementById('fader-val-master');
  masterFader?.addEventListener('input', () => {
    const v = parseFloat(masterFader.value);
    if (masterVal) masterVal.textContent = `${Math.round(v * 100)}%`;
    if (sharedMasterGain && audioCtx) {
      sharedMasterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.01);
    }
    masterFader.setAttribute('aria-valuetext', `${Math.round(v * 100)}%`);
  });

  // Pan knobs
  document.querySelectorAll('.mixer-pan[data-track]').forEach(input => {
    input.addEventListener('input', () => {
      const trackId = input.dataset.track;
      const v = parseFloat(input.value);
      setTrackPan(trackId, v);
    });
  });

  // Mute buttons
  document.querySelectorAll('.mixer-mute-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const trackId = btn.dataset.track;
      toggleMute(trackId);
    });
  });

  // Solo buttons
  document.querySelectorAll('.mixer-solo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const trackId = btn.dataset.track;
      toggleSolo(trackId);
    });
  });
}

// ─── Track controls ───────────────────────────────────────────────────────────

function setTrackVolume(trackId, value) {
  const track = tracks.get(trackId);
  if (!track) return;

  track.volume = value;

  if (audioCtx && track.trackFader) {
    track.trackFader.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
  }

  const display = document.getElementById(`fader-val-${trackId}`);
  if (display) display.textContent = `${Math.round(value * 100)}%`;

  const input = document.getElementById(`fader-${trackId}`);
  if (input) input.setAttribute('aria-valuetext', `${Math.round(value * 100)}%`);
}

function setTrackPan(trackId, value) {
  const track = tracks.get(trackId);
  if (!track || !track.panner) return;

  track.pan = value;

  if (!track.panner._isFallback && audioCtx) {
    track.panner.pan.setTargetAtTime(value, audioCtx.currentTime, 0.01);
  }

  const display = document.getElementById(`pan-val-${trackId}`);
  if (display) {
    if (Math.abs(value) < 0.02) {
      display.textContent = 'C';
    } else {
      const side = value < 0 ? 'L' : 'R';
      display.textContent = `${side}${Math.round(Math.abs(value) * 100)}`;
    }
  }

  const input = document.getElementById(`pan-${trackId}`);
  if (input) {
    const label = Math.abs(value) < 0.02 ? 'Center'
      : value < 0 ? `Left ${Math.round(Math.abs(value) * 100)}`
      : `Right ${Math.round(value * 100)}`;
    input.setAttribute('aria-valuetext', label);
  }
}

function toggleMute(trackId) {
  const track = tracks.get(trackId);
  if (!track) return;

  track.muted = !track.muted;
  applyMuteState(trackId, track);

  const btn = document.querySelector(`.mixer-mute-btn[data-track="${trackId}"]`);
  if (btn) {
    btn.setAttribute('aria-pressed', String(track.muted));
    btn.classList.toggle('mixer-btn--active', track.muted);
  }
}

function toggleSolo(trackId) {
  const track = tracks.get(trackId);
  if (!track) return;

  track.soloed = !track.soloed;

  // Update the global solo flag
  anySoloed = [...tracks.values()].some(t => t.soloed);

  // Re-evaluate mute state for every track
  tracks.forEach((t, id) => applyMuteState(id, t));

  const btn = document.querySelector(`.mixer-solo-btn[data-track="${trackId}"]`);
  if (btn) {
    btn.setAttribute('aria-pressed', String(track.soloed));
    btn.classList.toggle('mixer-btn--active', track.soloed);
  }
}

/**
 * Apply the effective mute state for a track, taking solo into account.
 * A track is silent when:
 *   - it is individually muted, OR
 *   - some other track is soloed and this track is not
 */
function applyMuteState(trackId, track) {
  const effectivelySilent = track.muted || (anySoloed && !track.soloed);
  const targetGain = effectivelySilent ? 0 : 1;

  if (audioCtx && track.muteGain) {
    track.muteGain.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.02);
  }

  // Grey-out the track card when silent
  const card = document.querySelector(`.mixer-track[data-track-id="${trackId}"]`);
  card?.classList.toggle('mixer-track--silent', effectivelySilent);
}

// ─── VU meters ────────────────────────────────────────────────────────────────

/**
 * Read the time-domain data from an AnalyserNode and compute:
 *  - peak: max absolute sample value (0–1)
 *  - rms:  root-mean-square of the buffer (0–1)
 */
function getLevel(analyser) {
  if (!analyser) return { peak: 0, rms: 0 };

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  let sumSq = 0;
  let peak  = 0;
  for (let i = 0; i < buf.length; i++) {
    const abs = Math.abs(buf[i]);
    if (abs > peak) peak = abs;
    sumSq += abs * abs;
  }

  return {
    peak,
    rms: Math.sqrt(sumSq / buf.length),
  };
}

/**
 * Draw a simple two-channel VU bar on a canvas element.
 *
 * The bar is split into three colour zones:
 *  - Green  (0 – 70%): safe
 *  - Yellow (70 – 90%): moderate
 *  - Red    (90 – 100%): clipping risk
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} level  0–1 normalised level
 * @param {string} trackColor  CSS colour for the track accent (used for green zone)
 */
function drawVU(canvas, level, trackColor = '#a8f5a8') {
  if (!canvas) return;

  const ctx    = canvas.getContext('2d');
  const w      = canvas.width;
  const h      = canvas.height;
  const filled = Math.round(level * h);

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, w, h);

  if (filled <= 0) return;

  // Determine colour zones
  const greenH  = Math.round(h * 0.70);
  const yellowH = Math.round(h * 0.90);

  // Draw from the bottom up
  const barY = h - filled;

  if (barY < greenH) {
    // Red zone (top)
    ctx.fillStyle = '#f5a8a8';
    ctx.fillRect(0, barY, w, Math.min(filled, h - yellowH));
  }

  if (barY < yellowH) {
    // Yellow zone
    const yStart = Math.max(barY, h - yellowH);
    const yEnd   = h - greenH;
    if (yEnd > yStart) {
      ctx.fillStyle = '#f5e6a8';
      ctx.fillRect(0, yStart, w, yEnd - yStart);
    }
  }

  // Green zone (bottom)
  const gStart = Math.max(barY, h - greenH);
  if (gStart < h) {
    ctx.fillStyle = trackColor;
    ctx.fillRect(0, gStart, w, h - gStart);
  }

  // Segment lines (tick marks every ~10px)
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < h; y += 10) {
    ctx.fillRect(0, y, w, 1);
  }
}

/** Peak hold values per track for the VU meter (decay slowly). */
const peakHold = new Map();

function startVuLoop() {
  if (vuRafHandle) return; // already running

  function loop() {
    TRACK_DEFS.forEach(def => {
      const track  = tracks.get(def.id);
      const canvas = document.getElementById(`vu-${def.id}`);
      if (!track || !canvas) return;

      const { rms } = getLevel(track.analyser);

      // Peak hold with slow decay
      const prev = peakHold.get(def.id) || 0;
      const held = Math.max(rms, prev * 0.97); // decay by 3% per frame
      peakHold.set(def.id, held);

      drawVU(canvas, held, def.color);
    });

    // Master VU
    const masterCanvas = document.getElementById('vu-master');
    if (masterCanvas && masterAnalyser) {
      const { rms } = getLevel(masterAnalyser);
      const prev = peakHold.get('master') || 0;
      const held = Math.max(rms, prev * 0.97);
      peakHold.set('master', held);
      drawVU(masterCanvas, held, '#e0c8f5');
    }

    vuRafHandle = requestAnimationFrame(loop);
  }

  vuRafHandle = requestAnimationFrame(loop);
}

export function stopVuLoop() {
  if (vuRafHandle) {
    cancelAnimationFrame(vuRafHandle);
    vuRafHandle = null;
  }
}
