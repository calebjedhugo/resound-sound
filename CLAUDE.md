# resound-sound — CLAUDE.md

Published Web Audio package extracted from `resound-fe/src/audio/`. See `README.md` for usage and `CHANGELOG.md` for history.

## Release prerequisites

Publishing is **manual and local** — it needs `npm login` with publish rights on `resound-sound`. There is no release workflow; `.github/workflows/ci.yml` is the only workflow and it just runs tests + build. (An earlier `release.yml` published on `v*` tag push using an `NPM_TOKEN` Actions secret; it is gone, so that secret is inert.) See **Release (manual)** below.

## Architecture

- `src/instruments/` — `Instrument` base + concrete classes (`Synth`, `Piano`, `Fountain`, `Random`, `Clap`). Each subclass implements `startNote(pitch, duration, velocity?)`.
  - `Piano` — additive concert-grand synth (~15–46 oscillators/note; velocity-sensitive; continuous per-pitch tuning), tuned against real grand samples. Plays back from cheap pre-rendered `AudioBuffer`s (ONE `BufferSourceNode`/note, ~40× cheaper) when available; falls back to the live additive synth otherwise.
    - **Default = lazy auto-cache:** first strike of a pitch renders live, then its buffer renders in the background (`OfflineAudioContext`, reusing `scheduleNote()`) into velocity layers (default 4) + loudness trim, so later strikes are cheap. Auto-disables where `OfflineAudioContext` is unavailable (e.g. jsdom test envs) → stays live, so consumers/tests don't break.
    - **`await piano.warm([pitches])`** pre-renders at load — REQUIRED for mobile/dense polyphony to avoid first-hit live spikes.
    - **`new Piano(id, { autoSample: false })`** = pure live (continuous velocity, max fidelity). Also `{ layers, maxCacheBytes (LRU byte budget, default 32MB), maxCacheEntries }`.
  - `Random` — ONE oscillator per note playing a cached per-pitch `PeriodicWave` (the built-in wave with its lowpass folded in + the harmonics) plus a few-ms onset buffer (the biquad's start-up transient), through one volume gain shared by the instance's notes. **It must sound exactly like the old oscillator → biquad + harmonic-oscillators graph**: any change to it gets re-nulled against that graph in a real browser (residual ≤ -60 dB; see CHANGELOG). Chrome holds ~0.6 MB of wavetable per (instance, pitch); `warm(pitches)` builds voices ahead (~1 ms each).
- `src/lib/` — `AudioContextManager` (singleton), `Envelope`, `MusicalClock`, `duration`, `noteFrequencies`.
  - `noteFrequencies.js` — a measured table for C/2–B/5; anything outside it is computed in equal temperament. Accepts `'C/4'` and `'C4'`. Only genuinely unparseable input falls back to A4 with a warning.
  - `instrumentRegistry.js` — `initInstruments()` / `getInstrument()` / `instrumentReady()`: eager page-load construction + warm of sampled instruments, registered by id (`SPEC-init.md`). `getInstrument` is synchronous and says nothing about warming; `instrumentReady(id)` is the awaitable one, for code that didn't start the init (a play button tapped mid-warm).
  - `timeline.js` + `Sequencer.js` — schema-native multi-voice playback (`src/SPEC-schema-playback.md`). `buildTimeline()` is the ONE place the shared note schema is interpreted for audio (dotted, tie merging, chords); `Sequencer` runs those events on a 25ms beat-cursor clock with live seek/tempo/mute/loop. When every routed instrument supports it (`schedulesAhead` + a context clock — Piano does), notes are scheduled up to `lookaheadMs` (default 100) ahead with an exact audio-clock `when`, so onsets don't inherit timer jitter; stubs/jsdom (no clock) keep the exact legacy fire-on-cross path, which is why the test mocks never see a `when`. **Consumers must never re-implement this in app code** — the same untransformed arrays feed resound-notation's `render()` and this.
- `src/index.js` — public exports. **NEVER reformat the export block** — the Vite middleware in `src/editor/vite.config.js` parses it with a regex when the editor creates new instruments.
- `src/editor/` — Vite playground for designing sounds. Plain JS, no React. Excluded from npm tarball.

## Workflows

```bash
npm test            # Jest, 141 integration tests — keep these green, they are the safety net
npm run build       # webpack ESM bundle + tsc declarations to dist/
npm start           # webpack-watch + tsc-watch + editor on http://localhost:5174
```

### Release (manual)

Publishing is manual — there is **no** CI auto-publish. (`ci.yml` still runs tests + build on every push/PR; a `prepublishOnly` script builds `dist/` on publish so you can't ship a stale bundle.)

```bash
npm version minor        # or patch — bumps package.json, commits, creates v* tag
git push --follow-tags   # push the release commit + tag to GitHub
npm publish --access public   # prepublishOnly runs `npm run build` first
```

Requires `npm login` with publish rights on `resound-sound`. Update `CHANGELOG.md` before bumping.

### New instrument via editor

1. `npm start`, open `localhost:5174`, design a Synth preset.
2. Type a `PascalCase` name, hit **Save as new instrument**.
3. Middleware writes `src/instruments/<Name>.js` (extends Synth) and inserts the export line.
4. Commit, then release.

Editor only knows the synth topology. Noise-based instruments (Clap-style) still need hand-coded class files.

## Gotchas

- **NEVER rename `babel.config.cjs` or `webpack.config.cjs` to `.js`** — `package.json` sets `"type": "module"`, so config files must stay `.cjs`.
- **NEVER "fix" the `Instrument.pause()` quirk.** It does not interrupt an in-flight `setTimeout` sleep, so the next scheduled note plays before the loop honors `shouldStop`. The Piano pause test pins `currentIndex=2` after pausing mid-note-0 of a 3-note phrase. Established behavior — locked in by the test.
- **IMPORTANT: `AudioContextManager` and the `instrumentRegistry` are module-level singletons.** Two copies of `resound-sound` in a consumer's `node_modules` tree gives two AudioContexts (timing weirdness) and two registries (`getInstrument` returns `undefined` for an id the other copy registered). After linking, verify with `npm ls resound-sound` in the consumer.
- **IMPORTANT: Consumers using jest need `transformIgnorePatterns: ['/node_modules/(?!(resound-sound)/)']`** — the published bundle is ESM and babel-jest skips `node_modules` by default.
- **Vite 4, not 5.** Vite 5 requires Node 18+; user is on Node 16. Matches resound-fe.
- **`stop()` does not interrupt an in-flight `setTimeout` sleep either** — same mechanism as the pause quirk, so one more note straggles out. Unlike pause, the state it leaves behind IS a full stop: `playbackState.isStopping` tells the unwinding loop not to re-park the cleared state as a pause.

## Consumer

`resound-fe` (`~/Development/personal dev work.nosync/resound-fe/`) imports from this package. Six files: `core/{PlaybackManager,ClapManager,GameState}.js`, `entities/{Creature,Fountain}.js`, `createEventListeners.js`. Full suite is 993 tests / 52 suites (2026-10-17) — keep it green when bumping the package. Verified 2026-08-03 against this repo's `main` via a temporary `file:` link: green, but it needed two mock methods the 0.2.0 Piano uses (`createWaveShaper`, `setPeriodicWave`) that resound-fe's own `helpers/mocks.js` predates. Expect a consumer's Web Audio mock to be the first thing an instrument change breaks (`Random` uses `createPeriodicWave`, `createBuffer`, `createBufferSource`; a mock biquad without `getFrequencyResponse` just gets an unfiltered wave).

`singHarmony2` (`~/Development/personal dev work.nosync/singHarmony2/`) drove `initInstruments` and `Sequencer`, and consumes this package as a local `file:` link pending the next publish. Its `src/player.js` is a thin adapter over `Sequencer`; it tests that adapter (`player.test.js`) and runs every song through `buildTimeline` (`songs.render.test.js`), but the audio itself is verified in the browser.
