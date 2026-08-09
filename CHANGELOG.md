# Changelog

All notable changes to this package follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `Sequencer` audio-clock lookahead ("A Tale of Two Clocks"): when every routed instrument opts in (`schedulesAhead = true` plus a context clock — `Piano` does), notes are handed to the instrument up to `lookaheadMs` (default 100) ahead of their beat with an exact audio-clock `when`, so onsets no longer inherit main-thread timer jitter (the 25ms tick, GC pauses, consumer DOM work) and short timer stalls can't smear attacks. The beat cursor, `onTick`, seek, tempo, mute and A-B loop semantics are unchanged; seeks and mid-play loop edits cancel the abandoned lookahead window (`Instrument.cancelScheduled()`) so no stale future notes leak through. Instruments that don't opt in — and any environment without an audio clock (jsdom, test stubs) — keep the exact fire-on-cross behavior and 3-arg `startNote` call shape. `lookaheadMs: 0` disables.
- `Instrument.cancelScheduled()` — stops tracked notes whose scheduled onset hasn't been reached, leaving ringing notes untouched. `startNote(pitch, duration, velocity, when)` grows the optional `when` (audio-clock seconds); `Piano` honors it on both the sampled and live paths.

### Fixed
- `getFrequency` now understands double accidentals (`Bbb3`, `F##2`, schema or shorthand form) instead of falling back to A4 — a Db-major augmented sixth plays at pitch.

### Added
- `Sequencer` — schema-native multi-voice playback (`src/SPEC-schema-playback.md`). Consumes the same untransformed voice/note arrays resound-notation renders (dotted values, tie chains merged into one sounding note, chords) over one shared beat clock in notated-beat units (the `data-beat` timeline), and adds the live controls `Instrument.play()` has never had: in-place `pause`/`play`, `seek(beat)`, `setTempo(bpm)`, per-voice `mute`/`unmute`/`setMuted`, `setLoop(a, b)` A-B looping, `onTick(beat)` / `onEnd`, `tempoMap` rit/accel multipliers, a velocity policy (constant or per-note callback, given the unmuted-voice count), and per-voice instrument routing. `Instrument.play()` and every existing export are untouched.
- `buildTimeline(song)`, `noteBeats(note, basis)`, `elementBeats(element, basis)` — the pure schema→events pass behind `Sequencer`, exported for analysis and testing.
- `initInstruments(config)` / `getInstrument(id)` — eager page-load initialization for sampled instruments (currently `piano`). Constructs each configured instrument, registers it by id in a module-level registry, and `warm()`s the given pitches, so the ~1s pre-render can happen at page load instead of behind the first play tap. Idempotent: a second call with the same `id` reuses the instance and warms any newly-listed pitches; conflicting `layers` on a later call are ignored (original wins) with a `console.warn`. Plain `new Piano(id)` still does not register — no behavior change for existing consumers.
- `instrumentReady(id)` — resolves with the registered instrument once the initialization in flight for that id settles, and immediately when none is. `initInstruments` is async, so between page load and the end of warming an instrument is registered but still rendering; `getInstrument(id)` hands it over regardless and the promise belongs to whoever called `initInstruments`. This is how code that did NOT start the init waits for it — a play button tapped mid-init awaits this, shows a loader, and then plays the SAME warmed instance instead of racing the init with a second one. Overlapping inits for one id are covered (the promise spans all of them), and it resolves even when warming failed, since an unwarmed sampled instrument still plays live and a caller's loader must clear either way. `initInstruments` itself is unchanged: it still resolves on its own pitches.
- `audioContextManager.resumeOnFirstGesture()` — if the singleton `AudioContext` is `suspended` (as it is when constructed outside a user gesture, e.g. by eager `initInstruments`), installs one-time `pointerdown` / `keydown` / `touchend` listeners on `document` that call `context.resume()` and remove themselves. No-op if already `running`; safe to call repeatedly (never installs more than one set of listeners). Called automatically by `initInstruments`.

### Fixed
- `getFrequency()` no longer collapses every pitch outside its measured C/2–B/5 table to A4 (440 Hz). Pitches above or below the table — a descant over B/5, a pedal under C/2 — are now computed in equal temperament, so they sound at their own pitch instead of all sounding the same wrong one. In-table pitches still return the measured value, unchanged, and both `'C/4'` and `'C4'` spellings resolve identically. Only genuinely unparseable input still warns and falls back to A4 (and bad input no longer throws — including a pitch spelled like an `Object.prototype` member, e.g. `"constructor"`, which the raw table lookup used to return a function for).
- `Instrument.play({ data: [] })` no longer throws. An empty phrase resolves immediately with playback state reset, instead of a `TypeError` reading the duration off a non-existent last entry.
- `Instrument.stop()` mid-phrase no longer leaves the instrument in a bogus *paused* state. The play loop still had to unwind from its in-flight sleep, and when it did it overwrote `stop()`'s reset with `isPaused: true` and a saved index — against a `currentData` that `stop()` had already nulled, so the next `resume()` threw. `stop()` now marks the interrupt as a stop (`playbackState.isStopping`) and the loop honors it; `resume()` after a stop is a clean no-op.
- `Sequencer.setLoop(a, b)` set *behind* the playhead — the ordinary "play that bit again" gesture — used to strand the sequencer: the wrap condition could never be met, so the cursor ran on past the end of the song forever, sounding nothing and never reaching `onEnd`. The tick now snaps a cursor sitting past `loopEnd` back to `loopStart`, the same way `play()` already did. A cursor *before* the loop is untouched — it still plays the lead-in and enters the loop at `loopEnd`.
- The tuplet/grace-note warning said it was "skipping" those elements; it never did. A tuplet or grace note carrying a `length` sounds at face value, and the message now says so.
- `initInstruments` now warns instead of failing silently on an unusable config: a type it does not know (a typo) or an entry with no `id`. Both cases previously did nothing at all, leaving the consumer with an instrument that never warmed and a `getInstrument(id)` that returned `undefined` forever.

### Changed
- `Piano`'s sample cache is now byte-bounded and truly LRU: buffers render offline at ~20 kHz (the synth never exceeds 7 kHz, so playback is identical after the source node's automatic resampling, at ~2.2× less render CPU and memory), the cache evicts least-recently-used buffers past a byte budget (`maxCacheBytes`, default 32MB), and a cache hit refreshes recency. `maxCacheEntries` is still honored as an additional entry-count cap, but its old default of 512 (which a real warm set never reached) is gone — the byte budget is the working bound.
- `Piano.warm()` now renders through a bounded pool (`warmConcurrency`, default 4) instead of launching every `(pitch, layer)` render at once. A full-range warm used to create ~200 concurrent `OfflineAudioContext`s — a memory spike that killed the tab on small phones (iPhone SE) and, it turns out, was *slower* even on desktop (contention: ~14s for 192 buffers vs ~2s pooled). `warm(pitches, { front: true })` queues those pitches ahead of anything already waiting — a play tap's own song jumps a whole-catalog warm. Renders already in flight and cached buffers are deduped exactly as before, and `warm()`'s resolve/reject contract is unchanged.
- `Synth`, `Fountain` and `Clap` constructors dropped their vestigial second `recordingCallback` parameter. It was forwarded to a base constructor that never accepted it, so it has never done anything — note callbacks are and were set through the `noteCallback` property. Passing a second argument was already ignored, so nothing changes for callers; the editor's new-instrument template no longer emits it either.

## [0.2.0] — 2026-07-19

### Changed
- **`Piano` completely re-synthesized** as an additive concert-grand model tuned against real sampled-grand recordings, replacing the previous triangle + sine-harmonics timbre. Continuous, seam-free per-pitch tuning (Railsback inharmonicity, soundboard formant, register-dependent brightness and decay), per-partial double decay with upper-partial darkening, unison detuned string pairs, per-voice random start phase, an onset-brightness "hammer" attack, and a soft-knee bus limiter.
- `Piano` now plays back from cheap pre-rendered `AudioBuffer`s by default (lazy auto-cache): the first strike of a pitch renders live, then its buffer renders in the background and every later strike plays as a single `BufferSourceNode` (~40× cheaper for dense/mobile polyphony). Falls back to live synthesis where `OfflineAudioContext` is unavailable.

### Added
- Velocity-sensitive playback: `startNote(pitch, duration, velocity?)` plus an optional `velocity` (0–1) field on notes, threaded through `Instrument`. Velocity scales loudness, brightness, and (in the bass) attack.
- `Piano.warm(pitches)` to pre-render pitches at load — recommended for mobile / dense polyphony to avoid first-hit render spikes.
- `Piano` constructor options `{ autoSample, layers, maxCacheEntries }`; `{ autoSample: false }` forces pure live (continuous-velocity, max-fidelity) playback.

### Removed
- `Piano`'s `envelope` / `harmonics` / `detune` tunable properties (superseded by the additive model).

## [0.1.0] — 2026-05-08

Initial publish, extracted from the Resound game's `src/audio/` module.

### Added
- `Instrument` base class with `play` / `pause` / `resume` / `stop`, ADSR-driven note scheduling, chord support, per-note offsets, and a real-time `noteCallback` for recording/listening pipelines.
- `Synth` — generic subtractive synth (configurable waveform, biquad filter, ADSR, harmonics, detuned oscillators). Design surface for new sounds.
- `Piano` — detuned triangle oscillators with sine harmonics through a 3 kHz lowpass for warmth.
- `Fountain` — bell-like sine harmonic series with shimmer detune through a 200 Hz highpass.
- `Random` — randomized timbre per instance: random waveform, filter cutoff, ADSR, and harmonic stack.
- `Clap` — filtered white noise through bandpass + highpass for percussive clap synthesis.
- `audioContextManager` — module-level singleton that lazily creates a unified `AudioContext` and unlocks audio on iOS/Safari with a silent buffer source.
- `MusicalClock` — beat/ms conversions, optional metronome.
- Helpers: `applyEnvelope`, `getFrequency`, `getDuration`.

### Tooling
- ESM bundle via webpack (`dist/index.js`), TypeScript declarations from JSDoc via `tsc --emitDeclarationOnly` (`dist/index.d.ts`).
- Jest test suite — 22 integration tests covering instrument behaviour and pause/resume semantics.
- Plain-JS + Vite editor at `src/editor/` with live ADSR/harmonics/detune sliders, computer-keyboard input, waveform display, and an in-editor "Save as new instrument" flow that templates new `Synth` subclasses to `src/instruments/`.

[Unreleased]: https://github.com/calebjedhugo/resound-sound/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/calebjedhugo/resound-sound/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/calebjedhugo/resound-sound/releases/tag/v0.1.0
