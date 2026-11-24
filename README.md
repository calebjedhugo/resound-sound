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
| `Instrument` | Base class. Subclass and implement `startNote(pitch, duration, velocity?)` to ship a custom timbre (connect its output to `audioContextManager.getOutput()`, never to `context.destination`, so mute reaches it). `dispose()` retires an instance for good (stops it; nothing plays again; `Random` frees its wavetables). |
| `Synth` | Generic subtractive synth. Configurable `waveform`, `filterType`, `filterCutoff`, `envelope`, `harmonics`, `detune`. |
| `Piano`, `Fountain`, `Random`, `Clap` | Concrete instruments. |
| `Theremin` | A high-quality theremin with electric crackle (Resound's creature voice): gliding legato lines, delayed vibrato, sparse band-passed sparks. Plays dots and ties as written. See below. |
| `audioContextManager` | Module-level singleton. Lazily creates a unified `AudioContext`, unlocks audio on iOS/Safari. Owns the master output every live sound goes through: `getOutput()`, `setMuted(bool)`, `isMuted()` — see below. |
| `initInstruments`, `getInstrument`, `instrumentReady` | Eager page-load init + registry for sampled instruments — see below. |
| `Sequencer` | Multi-voice playback of the shared note schema, with live pause/seek/tempo/mute/loop — see below. |
| `buildTimeline`, `noteBeats`, `elementBeats`, `soundingBeats` | The schema→events pass the `Sequencer` runs, exposed for analysis; `soundingBeats` is its per-element view (how long each note sounds, ties merged) for players that walk a phrase one element at a time. |
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

### Waiting for an init that is already running

Initialization is asynchronous, so there is a window — page load until the
last buffer renders — where the instrument is registered but not yet warm.
`getInstrument` hands it over anyway, and the promise belongs to whoever
called `initInstruments`. `instrumentReady(id)` is how everyone else waits:

```js
import { instrumentReady } from 'resound-sound';

playButton.addEventListener('click', async () => {
  playButton.classList.add('loading');   // only shows if there is a wait
  const piano = await instrumentReady('main-piano');
  playButton.classList.remove('loading');
  sequencer.instrument = piano;
  sequencer.play();
});
```

It resolves immediately when nothing is pending, spans every overlapping init
for that id (the page-load range warm AND the per-song warm), and resolves
rather than rejecting when warming failed — an unwarmed sampled instrument
still plays, it just renders live, so the loader has to clear either way.
Without it, a tap during warm-up has no choice but to build a second
instrument and pay for the whole pre-render again.

## A theremin (`Theremin`)

```js
import { Theremin } from 'resound-sound';

const voice = new Theremin('lead');                     // the default voice
const dry = new Theremin('dry', { crackle: false });    // no sparks at all
const own = new Theremin('own', { warmth: 1.2, vibratoRate: 5.2, vibratoDepth: 9,
  attack: 0.022, glide: 0.008, spark: 0.8 });

voice.play({ data: song, tempo: 96, basis: 4 });       // notes, rests, chords
```

Each part of a song plays on one continuous oscillator, so notes join the way
a theremin's do: a legato note glides to its pitch (time constant `glide`,
~9 ms) with a short dip that re-articulates it (deeper on a repeated pitch), a
note after silence scoops up 20 cents, and vibrato swells in after 160 ms. A
chord takes a line per member. Crackle is sparse band-passed noise: a crack on
each attack and ~3.5 a second while a note holds (`spark` scales the rate; 0
or `crackle: false` for none).

| option | default | |
|---|---|---|
| `warmth` | 1 | the 2nd-7th harmonics and the faint buzz, x (0-2; on a 0.05 grid so instances share wavetables) |
| `vibratoRate` | 5.5 | Hz (0-12), jittered ±4% per note |
| `vibratoDepth` | 11 | cents (0-50), jittered ±15% per note |
| `attack` | 0.026 | seconds from silence to the peak (0.004-0.5) |
| `glide` | 0.009 | portamento time constant, seconds (0.001-0.1) |
| `spark` | 1 | crackle rate, x (0-4) |
| `crackle` | true | false builds no crackle nodes at all |
| `context`, `output` | live, master | e.g. an `OfflineAudioContext` and its `destination` |
| `random`, `crackleRandom` | `Math.random` | seedable jitter and crackle |

`getVoice()` / `setVoice(partial)` read and change the six voice values
(`Theremin.DEFAULT_VOICE`, `Theremin.VOICE_LIMITS`). `play()` reads dots
(`dotted: true` x1.5, `dotted: 2` a double dot x1.75) and holds tied notes as
one sound, each chord member on its own; its note events carry `durationBeats`
(how long the note sounds) and `dotted` / `tie`, and a tie start's
`tiedDuration` (ms). `warm()` builds the wavetable ahead and `prepare(song,
tempo)` the lines a song will start (unstarted, unconnected), so the moment a
note starts only schedules; `dispose()` an instance you are done with.

## Mute everything

```js
import { audioContextManager } from 'resound-sound';

audioContextManager.setMuted(true);   // fades out in 20 ms (no click)
audioContextManager.isMuted();        // true
audioContextManager.setMuted(false);  // fades back in
```

Every instrument (and the metronome, and the iOS unlock blip) connects to one
master `GainNode`, `audioContextManager.getOutput()`, which feeds the live
context's `destination`; muting fades only that gain. The context keeps
running, so `currentTime`, the `Sequencer`'s lookahead and anything scheduled
on the audio clock carry on while muted: unmuting picks up mid-phrase, in
time. Call it whenever you like: before any context exists it just takes
effect when the output is made (a persisted setting can be applied at boot),
and while the context is still waiting for a gesture the gain is set at once.
Offline renders (`Piano`'s warm-up buffers) draw into their own
`OfflineAudioContext` and are never muted. A custom instrument connects to
`getOutput()` too. (Not to be confused with the `Sequencer`'s per-voice
`toggleMute()`.)

The master output then goes through a **limiter** before the speakers: a
`DynamicsCompressor` at -3 dBFS, hard knee, ratio 20, 2 ms attack, 150 ms
release, with Web Audio's automatic makeup gain taken back off. Below the
threshold it changes nothing (a single theremin voice renders through it to a
-96 dB residual, delayed by the compressor's fixed 6 ms look-ahead); several
voices summing past full scale are held under it instead of clipping (three
theremin voices in a triad: peak 1.73 -> 0.84).

## Play a whole score (`Sequencer`)

`Instrument.play()` plays one voice, start to finish, with no live control.
`Sequencer` plays a whole multi-voice score off one beat clock — and it reads
the note arrays as they are, the same objects you hand to
[resound-notation](https://github.com/calebjedhugo/resound-notation)'s
`render()`. Dotted values, tie chains and chords are interpreted here, so an
app never needs its own translation layer. Extra keys (`lyric`,
`timeSignature`, `pickupBeats`, …) are ignored.

```js
import { Sequencer, getInstrument } from 'resound-sound';

const seq = new Sequencer({
  instrument: getInstrument('main-piano'),
  // dynamic scales with how many voices are singing
  velocity: ({ activeVoices }) => [0.95, 0.8, 0.65, 0.5][activeVoices - 1],
});

seq.load(song);        // { voices: [{ id, notes }], tempo, tempoMap, basis }
await seq.warm();      // pre-render every pitch the song uses
seq.onTick = (beat) => cursor.moveTo(beat);   // notated beats — data-beat units
seq.onEnd = () => ui.setPlaying(false);
seq.play();
```

Everything below takes effect on the next 25ms tick, mid-phrase:

```js
seq.pause(); seq.play();          // resume where it stopped
seq.seek(32);                     // beats
seq.setTempo(76);                 // BPM of the `basis` note
seq.toggleMute('alto');           // per-voice; returns the new sounding state
seq.setLoop(16, 32); seq.clearLoop();
```

`tempoMap: [{ beat, multiplier }]` applies rits and accels; `basis` (default 4)
decides what a beat is, exactly as in `getDuration()`. See
[src/SPEC-schema-playback.md](src/SPEC-schema-playback.md) for the full
contract, including tie and chord semantics.

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
npm test           # Jest, 188 integration tests
npm run build      # Webpack ESM bundle + tsc declarations to dist/
npm start          # Webpack watch + tsc watch + editor dev server
```

## License

ISC
