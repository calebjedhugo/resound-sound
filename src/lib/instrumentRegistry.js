import Piano from '../instruments/Piano';
import audioContextManager from './AudioContextManager';

/**
 * Eager-initialization for sampled instruments (SPEC-init.md). Constructing a
 * sampled instrument creates the singleton AudioContext; `warm()`'s
 * OfflineAudioContext pre-render needs no user gesture, so this is safe to
 * call at page load. Live output still needs the context running — see
 * `audioContextManager.resumeOnFirstGesture()`, called below.
 *
 * Only `piano` exists today; this map is where a future sampled instrument
 * would slot in — the config shape (`initInstruments({ <type>: {...} })`) is
 * already per-type.
 */
const SAMPLED_INSTRUMENT_TYPES = { piano: Piano };

// Module-level registry: id -> instance, shared by initInstruments/getInstrument.
// Plain `new Piano(id)` never touches this — only initInstruments registers.
const registry = new Map();

function sameLayers(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Create (or reuse) one configured instrument and warm its pitches.
 * @param {Function} Ctor - instrument class, e.g. Piano
 * @param {string} typeName - config key, used only for the conflict warning
 * @param {Object} cfg - { id, pitches, ...constructorOptions }
 */
async function initOne(Ctor, typeName, cfg = {}) {
  const { id, pitches = [], ...options } = cfg;
  if (!id) return undefined;

  let instance = registry.get(id);
  if (!instance) {
    instance = new Ctor(id, options);
    registry.set(id, instance);
  } else if (options.layers && !sameLayers(options.layers, instance.velocityLayers)) {
    // eslint-disable-next-line no-console
    console.warn(
      `initInstruments: '${id}' (${typeName}) is already registered with different `
      + 'layers — keeping the layers from the first call.',
    );
  }

  // Constructing the instrument creates the singleton AudioContext. If it's
  // suspended (page-load, no gesture yet), arm the one-time resume listeners.
  audioContextManager.resumeOnFirstGesture();

  if (pitches.length) await instance.warm(pitches);
  return instance;
}

/**
 * Eagerly construct + warm sampled instruments, safe to call at page load
 * outside a user gesture.
 *
 * @param {Object} [config] - per-type config, e.g.
 *   { piano: { id: 'my-piano', layers: [...], maxCacheEntries, pitches: [...] } }
 * @returns {Promise<Object>} resolves with { [type]: instance } once warming
 *   completes; callers may ignore the promise for fire-and-forget.
 */
export async function initInstruments(config = {}) {
  const entries = Object.entries(config).filter(
    ([type, cfg]) => SAMPLED_INSTRUMENT_TYPES[type] && cfg,
  );
  if (entries.length === 0) return {};

  const result = {};
  await Promise.all(entries.map(async ([type, cfg]) => {
    result[type] = await initOne(SAMPLED_INSTRUMENT_TYPES[type], type, cfg);
  }));
  return result;
}

/**
 * Look up a previously `initInstruments()`'d instance by id.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getInstrument(id) {
  return registry.get(id);
}
