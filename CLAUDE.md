# resound-sound — CLAUDE.md

Published Web Audio package extracted from `resound-fe/src/audio/`. See `README.md` for usage and `CHANGELOG.md` for history.

## Outstanding TODOs

- [ ] **Add `NPM_TOKEN` secret to GitHub repo before the next release.** Without it, `.github/workflows/release.yml` will fail at the `npm publish` step. Generate at npmjs.com → Access Tokens → Classic → **Automation** type (regular tokens require an OTP at publish time, which CI can't provide). Then add at github.com/calebjedhugo/resound-sound → Settings → Secrets and variables → Actions → `NPM_TOKEN`.

## Architecture

- `src/instruments/` — `Instrument` base + concrete classes (`Synth`, `Piano`, `Fountain`, `Random`, `Clap`). Each subclass implements `startNote(pitch, duration)`.
- `src/lib/` — `AudioContextManager` (singleton), `Envelope`, `MusicalClock`, `duration`, `noteFrequencies`.
- `src/index.js` — public exports. **The Vite middleware in `src/editor/vite.config.js` patches this file when you create new instruments via the editor UI**, so don't get clever with the export-block formatting.
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

- **`"type": "module"` is set**, so `babel.config.cjs` and `webpack.config.cjs` use the `.cjs` extension. Don't rename them back to `.js`.
- **`AudioContextManager` is a module-level singleton.** A consumer with two copies of `resound-sound` in its node_modules tree gets two AudioContexts and timing weirdness. After linking, run `npm ls resound-sound` in the consumer to confirm exactly one.
- **`Instrument.pause()` does not interrupt an in-flight `setTimeout` sleep.** The next scheduled note plays before the loop honors `shouldStop`. The Piano pause test pins `currentIndex=2` after pausing mid-note-0 of a 3-note phrase. Established behavior — don't "fix" it.
- **`Instrument.play()` with `data: []` crashes** at `playSchedule[playSchedule.length - 1].duration`. Known bug, out of scope for v0.1.x.
- **Vite 4 specifically.** Vite 5 needs Node 18+; user is on Node 16. Match resound-fe.
- **Consumers need `transformIgnorePatterns: ['/node_modules/(?!(resound-sound)/)']`** in their jest config — the published bundle is ESM and babel-jest skips `node_modules` by default.

## Consumer

`resound-fe` (`~/Development/personal dev work.nosync/resound-fe/`) imports from this package. Six files: `core/{PlaybackManager,ClapManager,GameState}.js`, `entities/{Creature,Fountain}.js`, `createEventListeners.js`. Full suite is 1150 / 66 — keep it green when bumping the package.
