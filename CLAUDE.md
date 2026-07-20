# resound-sound — CLAUDE.md

Published Web Audio package extracted from `resound-fe/src/audio/`. See `README.md` for usage and `CHANGELOG.md` for history.

## Release prerequisites

`NPM_TOKEN` (npm **Automation** token) is configured as a GitHub Actions secret — `.github/workflows/release.yml` uses it to `npm publish` on `v*` tag push. If publishing ever fails on auth, rotate the token at npmjs.com → Access Tokens → Classic → Automation, then update the `NPM_TOKEN` secret at github.com/calebjedhugo/resound-sound → Settings → Secrets and variables → Actions.

## Architecture

- `src/instruments/` — `Instrument` base + concrete classes (`Synth`, `Piano`, `Fountain`, `Random`, `Clap`). Each subclass implements `startNote(pitch, duration, velocity?)`.
  - `Piano` — additive concert-grand synth (~15–46 oscillators/note; velocity-sensitive; continuous per-pitch tuning), tuned against real grand samples. Plays back from cheap pre-rendered `AudioBuffer`s (ONE `BufferSourceNode`/note, ~40× cheaper) when available; falls back to the live additive synth otherwise.
    - **Default = lazy auto-cache:** first strike of a pitch renders live, then its buffer renders in the background (`OfflineAudioContext`, reusing `scheduleNote()`) into velocity layers (default 4) + loudness trim, so later strikes are cheap. Auto-disables where `OfflineAudioContext` is unavailable (e.g. jsdom test envs) → stays live, so consumers/tests don't break.
    - **`await piano.warm([pitches])`** pre-renders at load — REQUIRED for mobile/dense polyphony to avoid first-hit live spikes.
    - **`new Piano(id, { autoSample: false })`** = pure live (continuous velocity, max fidelity). Also `{ layers, maxCacheEntries }`.
- `src/lib/` — `AudioContextManager` (singleton), `Envelope`, `MusicalClock`, `duration`, `noteFrequencies`.
- `src/index.js` — public exports. **NEVER reformat the export block** — the Vite middleware in `src/editor/vite.config.js` parses it with a regex when the editor creates new instruments.
- `src/editor/` — Vite playground for designing sounds. Plain JS, no React. Excluded from npm tarball.

## Workflows

```bash
npm test            # Jest, 22 integration tests — keep these green, they are the safety net
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
- **IMPORTANT: `AudioContextManager` is a module-level singleton.** Two copies of `resound-sound` in a consumer's `node_modules` tree gives two AudioContexts and timing weirdness. After linking, verify with `npm ls resound-sound` in the consumer.
- **IMPORTANT: Consumers using jest need `transformIgnorePatterns: ['/node_modules/(?!(resound-sound)/)']`** — the published bundle is ESM and babel-jest skips `node_modules` by default.
- **Vite 4, not 5.** Vite 5 requires Node 18+; user is on Node 16. Matches resound-fe.
- **`Instrument.play()` with `data: []` crashes** at `playSchedule[playSchedule.length - 1].duration`. Known bug, out of scope for v0.1.x.

## Consumer

`resound-fe` (`~/Development/personal dev work.nosync/resound-fe/`) imports from this package. Six files: `core/{PlaybackManager,ClapManager,GameState}.js`, `entities/{Creature,Fountain}.js`, `createEventListeners.js`. Full suite is 1150 / 66 — keep it green when bumping the package.
