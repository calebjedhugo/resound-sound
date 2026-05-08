# resound-sound — CLAUDE.md

Published Web Audio package extracted from `resound-fe/src/audio/`. See `README.md` for usage and `CHANGELOG.md` for history.

## Outstanding TODOs

**IMPORTANT:** Add `NPM_TOKEN` secret to the GitHub repo before the next release — without it `.github/workflows/release.yml` fails at `npm publish`.

1. npmjs.com → Access Tokens → Classic → **Automation** type. (Regular tokens require an OTP at publish time, which CI can't provide.)
2. github.com/calebjedhugo/resound-sound → Settings → Secrets and variables → Actions → New secret named `NPM_TOKEN`.

## Architecture

- `src/instruments/` — `Instrument` base + concrete classes (`Synth`, `Piano`, `Fountain`, `Random`, `Clap`). Each subclass implements `startNote(pitch, duration)`.
- `src/lib/` — `AudioContextManager` (singleton), `Envelope`, `MusicalClock`, `duration`, `noteFrequencies`.
- `src/index.js` — public exports. **NEVER reformat the export block** — the Vite middleware in `src/editor/vite.config.js` parses it with a regex when the editor creates new instruments.
- `src/editor/` — Vite playground for designing sounds. Plain JS, no React. Excluded from npm tarball.

## Workflows

```bash
npm test            # Jest, 22 integration tests — keep these green, they are the safety net
npm run build       # webpack ESM bundle + tsc declarations to dist/
npm start           # webpack-watch + tsc-watch + editor on http://localhost:5174
```

### Release

```bash
npm version patch   # bumps package.json + creates commit + creates v* tag
git push --follow-tags
```

Tag push triggers `.github/workflows/release.yml`: tests, build, verifies tag matches `package.json` version, then `npm publish`.

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
