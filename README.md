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
| `MusicalClock` | Beat/ms conversions, optional metronome. |
| `applyEnvelope`, `getFrequency`, `getDuration` | Building-block helpers. |

## Authoring new sounds

The editor at `src/editor/` is a small Vite playground for designing instruments. Run it from the package root:

```bash
npm install
cd src/editor && npm install
cd - && npm start
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
