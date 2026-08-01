# resound-sound

Web Audio API instrument library extracted from the [Resound](https://github.com/calebjedhugo/resound-fe) game. Ships a small set of ready-to-play instruments plus a generic `Synth` you can subclass to ship your own sounds.

## Install

```bash
npm install resound-sound
```

## Use

```js
import { Piano } from 'resound-sound';

const piano = new Piano();
piano.play({
  data: [
    { pitch: 'C/4', length: '1/4' },
    { pitch: 'E/4', length: '1/4' },
    { pitch: 'G/4', length: '1/4' },
    [
      { pitch: 'C/4', length: '1/2' },
      { pitch: 'E/4', length: '1/2' },
      { pitch: 'G/4', length: '1/2' },
    ],
  ],
  tempo: 120,
  basis: 4,
});
```

## Public surface

| Export | What it is |
|---|---|
| `Instrument` | Base class. Subclass and implement `startNote(pitch, duration)` to ship a custom timbre. |
| `Synth` | Generic subtractive synth. Configurable `waveform`, `filterType`, `filterCutoff`, `envelope`, `harmonics`, `detune`. |
| `Piano`, `Fountain`, `Random`, `Clap` | Concrete instruments. |
| `audioContextManager` | Module-level singleton. Lazily creates a unified `AudioContext`, unlocks audio on iOS/Safari. |
| `initInstruments`, `getInstrument` | Eager page-load init + registry for sampled instruments — see below. |
| `MusicalClock` | Beat/ms conversions, optional metronome. |
| `applyEnvelope`, `getFrequency`, `getDuration` | Building-block helpers. |

## Make the piano ready before the first tap

Warming a `Piano` (pre-rendering its sample buffers) normally requires an
instance, and constructing one creates the singleton `AudioContext`. Do that
at page load — outside any user gesture — and the context comes up
`suspended`; nothing resumes it until something calls `resume()` on a
gesture, but the `OfflineAudioContext` pre-render that `warm()` does needs no
gesture at all. `initInstruments` splits the two: it constructs and warms
eagerly, and arms a one-time listener that resumes the live context on the
user's first tap.

```js
import { initInstruments, getInstrument } from 'resound-sound';

// At page load — safe outside any user gesture. Fire-and-forget: the
// pre-render runs in the background while the rest of the page loads.
initInstruments({
  piano: {
    id: 'main-piano',
    layers: [0.5, 0.65, 0.8, 0.95],
    pitches: ['C/3', 'D/3', 'E/3', /* ...every pitch this song uses */],
  },
});

// Elsewhere — same instance, already warm (or warming).
const piano = getInstrument('main-piano');
piano.play({ data: [{ pitch: 'C/3', length: '1/4' }], tempo: 120, basis: 4 });
```

Per-song warm: call `initInstruments` again with the same `id` and a new
`pitches` list any time you load a new song — it reuses the existing
instance and only warms the pitches it hasn't seen yet. `layers` and other
constructor options are fixed by the first call for a given `id`.

`getInstrument(id)` returns the registered instance, or `undefined` if
nothing was `initInstruments`'d under that id. Plain `new Piano(id)` never
registers — no behavior change for existing consumers.

## Authoring new sounds

The editor at `src/editor/` is a small Vite playground for designing instruments. Run it from the package root:

```bash
npm install
(cd src/editor && npm install)
npm start
```

The playground opens at `http://localhost:5174/`. Tune the `Synth` envelope, waveform, filter, harmonics, and detune until it sounds right; type a `PascalCase` name and hit **Save as new instrument** — a `src/instruments/<Name>.js` file is templated to disk and exported from `src/index.js`. Commit, `npm version patch`, `npm publish`.

## Develop

```bash
npm test           # Jest, 22 integration tests
npm run build      # Webpack ESM bundle + tsc declarations to dist/
npm start          # Webpack watch + tsc watch + editor dev server
```

## License

ISC
