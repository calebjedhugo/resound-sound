import { getFrequency } from '../lib/noteFrequencies';
import Instrument from './Instrument';

/**
 * Piano — additive synthesis tuned against a real sampled concert grand
 * (the "How to Sing Harmony" Steinway samples). Every parameter was measured
 * from those recordings and validated full-keyboard against them.
 *
 * The cues that separate a real grand from a "cheap synth" piano:
 *
 *  1. STRUCK, not blown. A per-partial "bloom" attack (all partials rise
 *     together) with a brief brightness overshoot on the upper partials — the
 *     real piano's onset is measurably BRIGHTER than its sustain — plus a soft,
 *     low, non-resonant hammer knock. Velocity scales all of it (harder = louder,
 *     brighter, sharper).
 *
 *  2. A real strung body. Register-dependent INHARMONICITY following the piano
 *     Railsback smile (a single continuous curve — small in the tenor, larger in
 *     the bass and treble), a de-honked soundboard formant, and a fixed spectral
 *     tilt matched to the samples (bright bass upper-tail, tapered upper-mid).
 *
 *  3. Living tone. Low partials are struck as slightly-detuned UNISON pairs, and
 *     every voice starts at a random (seeded) phase, so the onset has no coherent
 *     "pip", the unison shimmers instead of flanging, and the spectrum isn't
 *     glassily smooth (seeded per-pitch jitter + notches).
 *
 *  4. Piano decay. Per-partial double decay (a quick prompt drop into a long
 *     ringing tail), upper partials darkening faster than the fundamental. Bass
 *     rings long and keeps its overtones; treble is pure and dies quickly.
 *
 * All register-dependent behaviour is a CONTINUOUS function of pitch, so the
 * timbre glides top-to-bottom with no audible seams between adjacent keys.
 * A soft-knee bus limiter keeps chords/overlap from clipping while preserving
 * the attack transients.
 */

const BASE_PARTIALS = [
  1.0, 0.95, 0.85, 0.48, 0.26, 0.19, 0.14, 0.1,
  0.075, 0.058, 0.045, 0.036, 0.028, 0.022, 0.018, 0.014,
];
for (let n = 17; n <= 40; n += 1) {
  BASE_PARTIALS.push(0.014 * (16 / n) ** 0.85);
}

const FORMANT_HZ = 470;
const FORMANT_WIDTH = 0.72; // de-honked (was 0.62) so it stops over-humping H6-H8
const FORMANT_GAIN = 0.55; // de-honked (was 0.85)
const BRIGHTNESS_HZ = 2450;
const TAIL_TAU = 0.68;
const NORM = 0.3;
const B_CEIL = 2.6e-3; // inharmonicity ceiling (drop to ~2e-3 if the top octave is harsh)
const MAX_PARTIAL_HZ = 7000;
const MIN_PARTIAL_AMP = 0.0012;
const DEFAULT_VELOCITY = 0.7;
const N_PHASE = 16; // distinct start-phase wavetables shared by all voices
const DEFAULT_LAYERS = [0.2, 0.45, 0.7, 0.95]; // velocity layers for warm() playback

const clampNum = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clampNum((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Loudness of a strike at velocity `v` (0-1). buildVoices() normalizes the live
 * voices to this, and playSampledNote() divides the layer's value back out to
 * recover continuous loudness from a layered buffer — the two MUST agree, so
 * they read the curve from here rather than each spelling it out.
 */
const velocityGain = (v) => 0.5 + 0.7 * v;

/** The OfflineAudioContext constructor, or null where the env has none. */
function offlineAudioContextCtor() {
  if (typeof OfflineAudioContext !== 'undefined') return OfflineAudioContext;
  if (typeof window !== 'undefined' && window.OfflineAudioContext) {
    return window.OfflineAudioContext;
  }
  return null;
}

// Offline renders' phase banks, one per sample rate, shared by every render.
// A bank is 16 PeriodicWaves (~14 ms of main thread in Chrome: more than the
// rest of a render's graph) whose tables depend only on the sample rate, and
// a render plays the same from a bank built on another context (Chrome
// 2026-10-17: within 1.8e-7, as close as two renders with their own banks).
const offlinePhaseBanks = new Map(); // sampleRate -> PeriodicWave[]

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Piano extends Instrument {
  constructor(id = 'piano', options = {}) {
    super(id);
    const opts = options || {};

    // startNote honors a future `when` onset — the Sequencer checks this flag
    // before scheduling notes ahead on the audio clock.
    this.schedulesAhead = true;

    this.release = 0.06; // damper time at note end (s)
    this.filterCutoff = BRIGHTNESS_HZ; // soundboard brightness (editor "cutoff")
    this.hammerLevel = 0.105;

    // Sampled-playback cache. Each warmed (pitch, velocity-layer) note plays back
    // as a single BufferSourceNode (~40x cheaper than the live additive synth).
    this.velocityLayers = opts.layers && opts.layers.length ? opts.layers.slice() : DEFAULT_LAYERS;
    // The cache is byte-bounded (mono Float32 samples: length * 4 bytes each),
    // evicting least-recently-used until under budget. `maxCacheEntries` is
    // still honored as an additional entry-count cap for back-compat.
    this.maxCacheBytes = opts.maxCacheBytes || 32 * 1024 * 1024;
    this.maxCacheEntries = opts.maxCacheEntries || Infinity;
    this.cacheBytes = 0;
    this.sampleBuffers = new Map(); // `${midi}:${layer}` -> AudioBuffer (LRU: oldest first)
    this.pendingRenders = new Map(); // `${midi}:${layer}` -> Promise<AudioBuffer>
    // warm() renders through a small pool instead of all at once: a full-range
    // warm is hundreds of OfflineAudioContexts, and launching them together
    // spikes memory hard enough to kill the tab on small phones.
    this.warmConcurrency = opts.warmConcurrency || 4;
    this._warmQueue = []; // jobs waiting for a pool slot
    this._warmJobs = new Map(); // `${midi}:${layer}` -> queued job (dedupe)
    this._warmActive = 0;
    // Default: lazy auto-cache — the first strike of a pitch renders live, then
    // its buffer is rendered in the background and every later strike is cheap.
    // Pass { autoSample: false } for pure live (continuous velocity, max fidelity).
    // Disabled automatically where OfflineAudioContext is unavailable so nothing
    // breaks (e.g. test environments) — there Piano just stays live.
    // For guaranteed-cheap, no-first-hit-spike playback (mobile), warm() at load.
    this.autoSample = opts.autoSample !== false && Piano.offlineAvailable();

    this.initBus();
  }

  /**
   * Shared per-instrument nodes: a soft-knee bus limiter (transparent below 0.7,
   * gently catching peaks above so it doesn't squash the attack), a flat
   * hammer-noise buffer, and a bank of single-harmonic wavetables at different
   * start phases (so each voice can start at a random phase — Web Audio
   * oscillators otherwise always start at phase 0).
   */
  initBus() {
    const ctx = this.context;

    this.limiter = ctx.createWaveShaper();
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      const x = (i / (N - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= 0.7 ? a : 0.7 + 0.27 * Math.tanh((a - 0.7) / 0.27);
      curve[i] = Math.sign(x) * y;
    }
    this.limiter.curve = curve;
    this.limiter.oversample = '2x';
    this.limiter.connect(ctx.destination);

    this.noiseBuffer = this.makeNoiseBuffer(ctx);
    this.phaseBank = this.makePhaseBank(ctx);
  }

  /** Flat brown-noise buffer (each strike shapes its own decay). Per-context. */
  // eslint-disable-next-line class-methods-use-this
  makeNoiseBuffer(ctx) {
    const len = Math.max(1, Math.floor(0.03 * ctx.sampleRate));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = brown * 3.5;
    }
    return buffer;
  }

  /** Bank of single-harmonic wavetables at N_PHASE start phases. Per-context. */
  // eslint-disable-next-line class-methods-use-this
  makePhaseBank(ctx) {
    const bank = [];
    for (let j = 0; j < N_PHASE; j += 1) {
      const phi = (2 * Math.PI * j) / N_PHASE;
      const real = new Float32Array([0, Math.cos(phi)]);
      const imag = new Float32Array([0, Math.sin(phi)]);
      bank.push(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
    }
    return bank;
  }

  // eslint-disable-next-line class-methods-use-this
  midiFromFreq(f0) {
    return Math.round(69 + 12 * Math.log2(f0 / 440));
  }

  static offlineAvailable() {
    return offlineAudioContextCtor() !== null;
  }

  /**
   * Build the oscillator voices for a fundamental frequency and strike velocity.
   * Each voice is one sine: { freq, peak, knee, tau2, boost, phase }. Low partials
   * are struck as detuned unison pairs. Deterministic per pitch (seeded PRNG).
   * All register behaviour is a smooth function of f0 — no threshold seams.
   */
  buildVoices(f0, velocity = DEFAULT_VELOCITY) {
    const v = clampNum(velocity, 0, 1);
    const L = Math.log2(f0);
    const fc = this.filterCutoff;
    const rng = mulberry32(this.midiFromFreq(f0));

    const bassAmt = clampNum((160 - f0) / 70, 0, 1);
    const bassLift = clampNum((150 - f0) / 95, 0, 1);
    // Continuous Railsback inharmonicity (log-quadratic fit; minimum near 160 Hz).
    const B = clampNum(10 ** (9.507 - 3.616 * L + 0.247 * L * L), 8e-5, B_CEIL);
    const hf = 1.15 * clampNum((f0 - 290) / 380, 0, 0.45); // treble taper
    const scale = clampNum((261.63 / f0) ** 0.55, 0.4, 2.4);
    const fundSupp = f0 < 120 ? -10 * Math.log2(120 / f0) : 0;
    const Kuni = Math.round(clampNum(11.97 - 0.995 * L, 3, 6));
    const detC = clampNum(1.6 + 1.15 * (L - Math.log2(123)), 1.4, 3.2);
    const detLo = detC - 0.5;
    const detHi = detC + 0.5;
    const velTilt = 0.1 * (v - 0.7); // harder = brighter
    const bodyBoost = 3.5 * clampNum((v - 0.3) / 0.7, 0, 1) * bassAmt; // hard-strike bass body

    const formant = (f) => {
      const oct = Math.log2(f / FORMANT_HZ);
      return 1 + FORMANT_GAIN * Math.exp(-(oct * oct) / (2 * FORMANT_WIDTH * FORMANT_WIDTH));
    };

    // Pass 1: qualifying partials and their steady amplitude.
    const parts = [];
    for (let i = 0; i < BASE_PARTIALS.length; i += 1) {
      const k = i + 1;
      const freq = k * f0 * Math.sqrt(1 + B * k * k);
      if (freq > MAX_PARTIAL_HZ) break;
      const brightness = 1 / Math.sqrt(1 + (freq / fc) ** 6);
      let amp = BASE_PARTIALS[i] * brightness * formant(freq) * Math.exp(-hf * (k - 1));
      // Rising bass upper-tail shelf: broadband bright instead of one formant hump.
      if (k >= 5) amp *= (1 + 1.0 * bassLift) * 10 ** (Math.min(8, 0.3 * bassLift * Math.max(0, k - 6)) / 20);
      if (k === 1) amp *= 10 ** (fundSupp / 20);
      amp *= 10 ** ((velTilt * (k - 1)) / 20);
      if (k <= 4) amp *= 10 ** (bodyBoost / 20);
      if (amp < MIN_PARTIAL_AMP) continue;
      parts.push({ k, freq, amp });
    }
    const N = parts.length;

    // Seeded irregularity (order of rng() calls is load-bearing — mirrors the sim).
    parts.forEach((p) => {
      const dB = (rng() * 2 - 1) * (p.k > 3 ? 2.5 : 1.0);
      p.amp *= 10 ** (dB / 20);
    });
    if (N >= 12) {
      const nNull = 1 + Math.floor(rng() * 2);
      for (let j = 0; j < nNull; j += 1) {
        const idx = 5 + Math.floor(rng() * (N - 5));
        parts[idx].amp *= 10 ** (-(6 + rng() * 5) / 20);
      }
    }

    const kFall = 0.05 + 0.13 * smoothstep(0, 1, clampNum((f0 - 110) / 320, 0, 1));
    const promptDb = 1.5 + lerp(0.5, 2.0, v) * bassAmt + 0.5 * smoothstep(400, 600, f0);

    const voices = [];
    parts.forEach(({ k, freq, amp }) => {
      const tau2 = (TAIL_TAU * scale) / (1 + kFall * (k - 1));
      const knee = amp * 10 ** (-promptDb / 20);
      const boost = 10 ** (Math.min(9, 0.5 * (k - 1)) / 20); // onset brightness overshoot
      if (k <= Kuni) {
        const da = detLo + rng() * (detHi - detLo);
        const db = detLo + rng() * (detHi - detLo);
        voices.push({ freq: freq * 2 ** (da / 1200), peak: amp * 0.55, knee: knee * 0.55, tau2, boost, phase: rng() * 2 * Math.PI });
        voices.push({ freq: freq * 2 ** (-db / 1200), peak: amp * 0.45, knee: knee * 0.45, tau2, boost, phase: rng() * 2 * Math.PI });
      } else {
        voices.push({ freq, peak: amp, knee, tau2, boost, phase: rng() * 2 * Math.PI });
      }
    });

    // Normalize on the steady (body) level; louder for harder strikes.
    const ss = Math.sqrt(voices.reduce((s, vc) => s + vc.peak * vc.peak, 0));
    const g = (NORM * velocityGain(v)) / Math.max(0.8, ss);
    voices.forEach((vc) => { vc.peak *= g; vc.knee *= g; });
    return voices;
  }

  /**
   * Felt-hammer knock: flat noise through a non-resonant lowpass, shaped by a
   * per-strike decay. Continuous across the keyboard and velocity-sensitive
   * everywhere (mid/treble now respond too); brighter/punchier for hard strikes.
   */
  addHammer(ctx, dest, noiseBuffer, f0, t0, velocity) {
    const v = clampNum(velocity, 0, 1);
    const bassAmt = clampNum((160 - f0) / 70, 0, 1);
    const hamMul = clampNum(1.0 + (0.2 + 3.4 * v) * bassAmt + (1.0 * v - 0.3) * (1 - bassAmt), 0.8, 4.6);
    const fcMul = lerp(2.0 + 1.2 * v, 2.5 + 2.0 * v, bassAmt);
    const hamFc = clampNum(fcMul * f0, 300, 3000);
    const hamDur = f0 < 160 ? lerp(0.016, 0.024, v) : 0.016;
    const level = (this.hammerLevel + 0.05 * clampNum((150 - f0) / 100, 0, 1)) * hamMul * (0.5 + 0.7 * v);

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = hamFc;
    filter.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(level, 1e-4), t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(level * 0.02, 1e-5), t0 + hamDur);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    source.start(t0);
    source.stop(t0 + hamDur + 0.005);
  }

  /**
   * Build the full note graph (partial oscillators + hammer) into `dest` on the
   * given context. Reused by the live path (this.context) and by SampledPiano's
   * offline pre-render, so both produce identical audio. Returns the created
   * oscillators so the caller can track them.
   */
  scheduleNote(ctx, dest, phaseBank, noiseBuffer, f0, velocity, durSec, t0) {
    const v = clampNum(velocity, 0, 1);
    const attackMax = lerp(lerp(30, 9, v), 35, clampNum((f0 - 120) / 80, 0, 1));
    const promptWin = lerp(0.045, 0.022, clampNum((f0 - 120) / 700, 0, 1));
    const release = clampNum(this.release, 0, durSec * 0.4);
    const avail = durSec - release;
    const attack = Math.min(clampNum(2300 / f0, 4, attackMax) / 1000, avail * 0.5);
    const attackEnd = t0 + attack;
    const decayEnd = t0 + avail;
    const promptEnd = attackEnd + Math.max(Math.min(promptWin, (decayEnd - attackEnd) * 0.5), 0.001);
    const noteEnd = t0 + durSec;

    const oscillators = [];
    this.buildVoices(f0, v).forEach(({ freq, peak, knee, tau2, boost, phase }) => {
      const oscillator = ctx.createOscillator();
      oscillator.frequency.setValueAtTime(freq, t0);
      const idx = ((Math.round((phase / (2 * Math.PI)) * N_PHASE) % N_PHASE) + N_PHASE) % N_PHASE;
      oscillator.setPeriodicWave(phaseBank[idx]);

      const partialGain = ctx.createGain();
      const g = partialGain.gain;
      const attackPeak = peak * boost; // brief onset brightness overshoot

      g.setValueAtTime(0.0001, t0);
      g.linearRampToValueAtTime(attackPeak, attackEnd); // bloom (to boosted peak)
      g.exponentialRampToValueAtTime(Math.max(knee, 1e-4), promptEnd); // prompt drop to steady
      const tailEnd = Math.max(knee * Math.exp(-(decayEnd - promptEnd) / tau2), 1e-5);
      g.exponentialRampToValueAtTime(tailEnd, decayEnd); // long ringing tail
      g.linearRampToValueAtTime(0.0001, noteEnd); // damper

      oscillator.connect(partialGain);
      partialGain.connect(dest);
      oscillator.start(t0);
      oscillator.stop(noteEnd);
      oscillators.push(oscillator);
    });

    this.addHammer(ctx, dest, noiseBuffer, f0, t0, v);
    return oscillators;
  }

  /**
   * Start a note. If the pitch/velocity has been warm()'d, it plays back from a
   * pre-rendered buffer (one BufferSourceNode — cheap). Otherwise it renders live
   * (the full additive synth). velocity (0-1, default mf) scales loudness,
   * brightness, and attack.
   */
  startNote(pitch, duration, velocity = DEFAULT_VELOCITY, when) {
    const f0 = getFrequency(pitch);
    const v = clampNum(velocity, 0, 1);
    const li = this.nearestLayerIndex(v);
    const midi = this.midiFromFreq(f0);
    const buffer = this._cacheGet(this.cacheKey(midi, li));
    if (buffer) {
      this.playSampledNote(buffer, li, v, duration, when);
      return;
    }
    // Un-warmed: render live now, and (by default) render this buffer in the
    // background so the next strike of this pitch/layer is cheap. The render
    // goes through the warm pool (front of queue), NOT straight to
    // ensureBuffer: an un-warmed chord run would otherwise spawn one
    // OfflineAudioContext per note with no bound, mid-playback.
    this.playLiveNote(f0, v, duration, when);
    if (this.autoSample) this._queueRender(midi, li, f0);
  }

  /** The audio-clock onset for a note: `when` if it's still in the future,
   *  otherwise now — a late-arriving schedule plays immediately, never in
   *  the past (Web Audio would clamp anyway; this keeps the math honest). */
  _onsetTime(when) {
    const now = this.context.currentTime;
    return when !== undefined ? Math.max(when, now) : now;
  }

  /**
   * Queue one speculative (pitch, layer) render at the front of the warm pool.
   * Dedupes against cached buffers, renders in flight, and queued warm jobs.
   */
  _queueRender(midi, li, f0) {
    const key = this.cacheKey(midi, li);
    if (this.sampleBuffers.has(key) || this.pendingRenders.has(key)) return;
    let job = this._warmJobs.get(key);
    if (!job) {
      job = { key, midi, li, f0 };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      job.promise.catch(() => {}); // speculative — nobody awaits it
      this._warmJobs.set(key, job);
      this._warmQueue.unshift(job);
    } else {
      // Already queued (e.g. by a background warm): promote it to the front.
      const i = this._warmQueue.indexOf(job);
      if (i > 0) {
        this._warmQueue.splice(i, 1);
        this._warmQueue.unshift(job);
      }
    }
    this._pumpWarmQueue();
  }

  /** Full additive synth: one decaying oscillator per voice + hammer. */
  playLiveNote(f0, velocity, duration, when) {
    const t0 = this._onsetTime(when);
    const lead = (t0 - this.context.currentTime) * 1000;
    const durSec = Math.max(0.02, duration / 1000);

    const volumeGain = this.context.createGain();
    volumeGain.gain.value = this.volumeMultiplier;
    volumeGain.connect(this.limiter);

    const oscillators = this.scheduleNote(
      this.context, volumeGain, this.phaseBank, this.noiseBuffer, f0, velocity, durSec, t0,
    );
    oscillators.forEach((osc) => this.trackOscillator(osc, volumeGain, duration + lead, t0));
  }

  /** Cheap playback: a single BufferSourceNode from a warm() buffer. */
  playSampledNote(buffer, layerIndex, velocity, duration, when) {
    const t0 = this._onsetTime(when);
    const lead = (t0 - this.context.currentTime) * 1000;
    const durSec = Math.max(0.02, duration / 1000);

    // Continuous loudness despite layered timbre: trim to the exact velocity.
    const layerGain = velocityGain(this.velocityLayers[layerIndex]);
    const base = this.volumeMultiplier * (velocityGain(velocity) / layerGain);

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(base, t0);
    gain.connect(this.limiter);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(t0);

    // Damper at the actual note end (buffer holds the full ring; this cuts it).
    const release = clampNum(this.release, 0.02, 0.2);
    const noteEnd = t0 + durSec;
    gain.gain.setValueAtTime(base, noteEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd + release);
    source.stop(noteEnd + release + 0.01);

    this.trackOscillator(source, gain, duration + lead, t0);
  }

  // --- Optional sampled-playback cache (opt-in via warm()) --------------------

  /** Buffer length in seconds — bass rings longer than treble. */
  // eslint-disable-next-line class-methods-use-this
  bufferSeconds(f0) {
    return clampNum(0.9 + 220 / f0, 1.3, 4.8);
  }

  nearestLayerIndex(v) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.velocityLayers.length; i += 1) {
      const d = Math.abs(this.velocityLayers[i] - v);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  // eslint-disable-next-line class-methods-use-this
  cacheKey(midi, layerIndex) {
    return `${midi}:${layerIndex}`;
  }

  /** Bytes a cached buffer occupies (mono Float32 samples). */
  // eslint-disable-next-line class-methods-use-this
  _bufferBytes(buffer) {
    return buffer.length * 4;
  }

  /** Cache lookup that refreshes recency (Map order = LRU, oldest first). */
  _cacheGet(key) {
    const buffer = this.sampleBuffers.get(key);
    if (buffer === undefined) return undefined;
    this.sampleBuffers.delete(key);
    this.sampleBuffers.set(key, buffer);
    return buffer;
  }

  /** Insert a buffer, then evict least-recently-used until under budget. */
  _cacheSet(key, buffer) {
    const old = this.sampleBuffers.get(key);
    if (old) this.cacheBytes -= this._bufferBytes(old);
    this.sampleBuffers.delete(key);
    this.sampleBuffers.set(key, buffer);
    this.cacheBytes += this._bufferBytes(buffer);
    // Never evict the entry just inserted (size > 1): a single buffer larger
    // than the whole budget must still be cached or nothing ever plays cheap.
    while (this.sampleBuffers.size > 1
      && (this.cacheBytes > this.maxCacheBytes
        || this.sampleBuffers.size > this.maxCacheEntries)) {
      const oldest = this.sampleBuffers.keys().next().value;
      this.cacheBytes -= this._bufferBytes(this.sampleBuffers.get(oldest));
      this.sampleBuffers.delete(oldest);
    }
  }

  /** Render one (pitch, velocity-layer) note to an AudioBuffer, offline. */
  renderBuffer(f0, layerVel) {
    // Synthesis tops out at MAX_PARTIAL_HZ (7 kHz; hammer lowpass caps at
    // 3 kHz), so rendering at the live context's 44.1/48 kHz wastes CPU and
    // cache memory on spectrum that is never there. Render at ~20 kHz instead
    // (Nyquist above 10 kHz — comfortably clear of the synthesis ceiling);
    // AudioBufferSourceNode resamples to the live rate at playback for free.
    const sr = Math.min(this.context.sampleRate, 20050);
    const seconds = this.bufferSeconds(f0);
    const OfflineCtor = offlineAudioContextCtor();
    if (!OfflineCtor) return Promise.reject(new Error('OfflineAudioContext unavailable'));

    const ctx = new OfflineCtor(1, Math.max(1, Math.ceil(seconds * sr)), sr);
    if (!offlinePhaseBanks.has(sr)) {
      // Built on a context of its own that never renders
      offlinePhaseBanks.set(sr, this.makePhaseBank(new OfflineCtor(1, 1, sr)));
    }
    const phaseBank = offlinePhaseBanks.get(sr);
    const noiseBuffer = this.makeNoiseBuffer(ctx);
    this.scheduleNote(ctx, ctx.destination, phaseBank, noiseBuffer, f0, layerVel, seconds, 0);
    return ctx.startRendering();
  }

  /** Ensure a buffer exists (or is rendering); returns a promise for it. */
  ensureBuffer(midi, layerIndex, f0) {
    const key = this.cacheKey(midi, layerIndex);
    if (this.sampleBuffers.has(key)) return Promise.resolve(this.sampleBuffers.get(key));
    if (this.pendingRenders.has(key)) return this.pendingRenders.get(key);

    const promise = this.renderBuffer(f0, this.velocityLayers[layerIndex])
      .then((buffer) => {
        this.pendingRenders.delete(key);
        this._cacheSet(key, buffer);
        return buffer;
      })
      .catch((err) => { this.pendingRenders.delete(key); throw err; });
    this.pendingRenders.set(key, promise);
    return promise;
  }

  /**
   * Pre-render a set of pitches (all velocity layers) so their playback is cheap.
   * Renders go through the instance's pool (`warmConcurrency` at a time), so a
   * full-range warm stays a background hum instead of a memory spike. Passing
   * `front: true` puts these pitches ahead of anything already queued — the
   * play-tap path, which should not wait behind a whole-catalog warm.
   * @param {string[]} pitches - e.g. ['C/2', 'C#/2', ...]
   * @param {{front?: boolean}} [opts]
   */
  async warm(pitches, { front = false } = {}) {
    const jobs = [];
    const enqueue = [];
    const promote = [];
    pitches.forEach((pitch) => {
      const f0 = getFrequency(pitch);
      const midi = this.midiFromFreq(f0);
      for (let li = 0; li < this.velocityLayers.length; li += 1) {
        const key = this.cacheKey(midi, li);
        if (this.sampleBuffers.has(key)) continue;
        if (this.pendingRenders.has(key)) {
          jobs.push(this.pendingRenders.get(key));
          continue;
        }
        let job = this._warmJobs.get(key);
        if (!job) {
          job = { key, midi, li, f0 };
          job.promise = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
          });
          this._warmJobs.set(key, job);
          enqueue.push(job);
        } else if (front) {
          promote.push(job);
        }
        jobs.push(job.promise);
      }
    });
    if (front) {
      for (const job of promote) {
        const i = this._warmQueue.indexOf(job);
        if (i >= 0) this._warmQueue.splice(i, 1);
      }
      this._warmQueue.unshift(...enqueue, ...promote);
    } else {
      this._warmQueue.push(...enqueue);
    }
    this._pumpWarmQueue();
    await Promise.all(jobs);
  }

  /** Start queued warm renders until the pool is full. */
  _pumpWarmQueue() {
    while (this._warmActive < this.warmConcurrency && this._warmQueue.length) {
      const job = this._warmQueue.shift();
      this._warmJobs.delete(job.key);
      this._warmActive += 1;
      const done = () => {
        this._warmActive -= 1;
        this._pumpWarmQueue();
      };
      this.ensureBuffer(job.midi, job.li, job.f0)
        .then(job.resolve, job.reject)
        .then(done);
    }
  }
}

export default Piano;
