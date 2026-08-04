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

// id -> promise covering every initialization currently in flight for that id.
// Construction is synchronous, warming is not, so an instance can be in the
// registry and still be minutes of pre-rendering away from cheap playback;
// `instrumentReady(id)` is how a caller that didn't start the init waits for
// it. Entries are removed once the last one settles, and never reject.
const pending = new Map();

function sameLayers(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Create (or reuse) one configured instrument and warm its pitches.
 * @param {Function} Ctor - instrument class, e.g. Piano
 * @param {string} typeName - config key, used only in warning messages
 * @param {Object} cfg - { id, pitches, ...constructorOptions }
 */
async function initOne(Ctor, typeName, cfg = {}) {
  const { id, pitches = [], ...options } = cfg;
  if (!id) {
    // Without an id there is nothing to register under, so the whole call would
    // do nothing at all — and `getInstrument` would return undefined forever.
    // eslint-disable-next-line no-console
    console.warn(`initInstruments: '${typeName}' config has no 'id'; skipping it.`);
    return undefined;
  }

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

  if (!pitches.length) return instance;

  // Warm right away — Piano.warm() already dedupes renders in flight, so
  // overlapping calls cost nothing. THIS call still resolves on its own
  // pitches, but the promise published for waiters also covers any earlier
  // init still running, so nobody is told the instrument is ready while half
  // of it is still rendering.
  const own = instance.warm(pitches);
  const combined = Promise.all([pending.get(id), own]).then(() => {}, () => {});
  pending.set(id, combined);
  combined.then(() => { if (pending.get(id) === combined) pending.delete(id); });

  await own;
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
  const entries = Object.entries(config).filter(([type, cfg]) => {
    if (!SAMPLED_INSTRUMENT_TYPES[type]) {
      // A typo'd or not-yet-supported type would otherwise be dropped in
      // silence, leaving the consumer with an instrument that never warms.
      // eslint-disable-next-line no-console
      console.warn(
        `initInstruments: no sampled instrument type '${type}' `
        + `(known: ${Object.keys(SAMPLED_INSTRUMENT_TYPES).join(', ')}); skipping it.`,
      );
      return false;
    }
    return Boolean(cfg);
  });
  if (entries.length === 0) return {};

  const result = {};
  await Promise.all(entries.map(async ([type, cfg]) => {
    result[type] = await initOne(SAMPLED_INSTRUMENT_TYPES[type], type, cfg);
  }));
  return result;
}

/**
 * Look up a previously `initInstruments()`'d instance by id. Synchronous, and
 * says nothing about warming — see `instrumentReady`.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getInstrument(id) {
  return registry.get(id);
}

/**
 * Wait for the initialization in flight for `id` — the one `initInstruments`
 * started, from anywhere in the app — and resolve with the instrument.
 *
 * This is what a play button awaits: tapped mid-init it can show a loader and
 * then use the SAME warmed instance, instead of racing the init with a second
 * one. Resolves immediately when nothing is pending, and resolves (never
 * rejects) if the warming failed — an unwarmed sampled instrument still plays,
 * it just renders live, so a caller's loader must clear either way.
 *
 * @param {string} id
 * @returns {Promise<Object|undefined>} the registered instance, if any
 */
export async function instrumentReady(id) {
  await pending.get(id); // undefined resolves on the spot
  return registry.get(id);
}
