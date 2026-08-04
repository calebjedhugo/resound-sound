# SPEC: Schema-native multi-voice playback

Status: **implemented** — `src/lib/timeline.js` + `src/lib/Sequencer.js`, covered
by `timeline.test.js` and `Sequencer.test.js`, exported from `src/index.js`.
Consumer: singHarmony2, whose `src/player.js` used to walk the song JSON itself
(tie merging, dotted math, its own multi-voice beat clock calling
`piano.startNote`) and is now a thin adapter over `Sequencer`. That app-side
interpretation is the thing this spec deleted.

> **Related:** [SPEC-ties.md](./SPEC-ties.md) (tie semantics — implemented here
> for the schema path) · [SPEC-init.md](../SPEC-init.md) (eager warm-up)

## The problem

`Instrument.play({ data, tempo, basis })` plays ONE voice, start to finish,
with no live control: no seek, no tempo change mid-phrase, no per-voice mute,
no loop, no position callback. Anything richer forces the consumer to read the
note arrays itself and schedule `startNote()` calls — exactly the translation
layer the shared schema exists to avoid. Two consumers interpreting the same
data two ways is how notation and audio drift apart.

The fix is a scheduler in this library that consumes the SAME untransformed
note arrays resound-notation's `render()` consumes, on the SAME beat timeline
(notated quarter-note beats — resound-notation's `data-beat` units), and
exposes the live controls a practice tool needs.

## API

```js
import { Sequencer } from 'resound-sound';

const seq = new Sequencer({ instrument: piano });

seq.load(song);            // song = { voices, tempo, tempoMap, basis } — the
                           // SAME object handed to NotationRenderer.render()
await seq.warm();          // pre-render every pitch in the song (no-op if the
                           // instrument has no warm())
seq.play();                // or seq.play(song) = load + play
```

### Input

`load(song)` accepts the shared schema verbatim:

| field | meaning |
|---|---|
| `voices` | `[{ id, notes }, …]` — `id` optional (defaults to the index) |
| `tempo` | BPM of the beat implied by `basis` (default 120) |
| `basis` | what note gets the beat (default 4 = quarter). Same meaning as `getDuration()` |
| `tempoMap` | `[{ beat, multiplier }, …]` — rits/accels, sorted by beat |
| everything else | ignored (`timeSignature`, `keySignature`, `pickupBeats`, `lyric`, `displayOctave`, …) |

A voice's `notes` is the notation element array:

- note — `{ pitch: 'C4', length: '1/4', dotted?: true, tie?: 'start'|'continue'|'stop' }`
- rest — same without `pitch`
- chord — a nested array of notes
- unknown keys (`lyric`, `clef`, `articulation`, …) are ignored, not rejected

Out of scope for this pass (each has its own roadmap spec): tuplets, grace
notes, repeats/navigation, dynamics, articulations. Elements carrying only
those markers contribute 0 beats, matching resound-notation's `elementBeats`.

### Timeline semantics

- Position is measured in **notated quarter-note beats** — identical to
  resound-notation's `data-beat`. `beatsOf(note) = (num/den) * basis *
  (dotted ? 1.5 : 1)`, so with the default `basis: 4` a `'1/4'` is 1.0.
- Every voice starts at beat 0 and advances by its own elements. Voices are
  independent streams over one shared clock; nothing is padded or aligned.
- A chord advances the voice by its FIRST length-bearing member — the rule
  resound-notation's `elementBeats()` uses, so notation and audio agree on
  where the next element sits. (`Instrument.play()`'s legacy chord rule —
  advance by the shortest member — is unchanged on that path.)
- `totalBeats` = the longest voice's end.

### Ties

Per [SPEC-ties.md](./SPEC-ties.md): a `start` → `continue*` → `stop` run of the
same pitch in the same voice produces ONE sounding event whose duration is the
sum of the run's beats. `continue`/`stop` produce no attack but still consume
their time. A `stop`/`continue` whose pitch differs from the open note, or with
no open note, is malformed and sounds as an ordinary note (never silently
merged). Ties on rests are ignored. Ties are matched per pitch inside chords.

### Real-time clock

A `setTimeout` tick loop (25 ms) advances the beat cursor by
`dt / secondsPerBeat(beat)` and fires every event whose onset falls in the beat
window just crossed. It is a *cursor*, not a pre-scheduled Web Audio timeline:
that is what makes mute, tempo, seek and loop take effect on the next tick
instead of at the end of the piece.

`secondsPerBeat(beat) = 60 / (tempo × tempoMultiplier(beat))`, where
`tempoMultiplier(beat)` is the last `tempoMap` entry at or before `beat` (1 if
none). `basis` decides what a beat *is* — with `basis: 4` a beat is a quarter
note (resound-notation's `data-beat`); with `basis: 2` a quarter note is 0.5
beats and `tempo` counts half notes. This is exactly `getDuration()`'s
convention, so a note's milliseconds match on either path.

### Controls

| call | behavior |
|---|---|
| `play()` / `play(song)` | start (or resume) from the current beat; no-op while playing |
| `pause()` | stop the clock, fade active notes (`stopAll(0.08)`), keep the beat |
| `stop()` | pause + return to `startBeat` |
| `seek(beat)` | clamp to `[0, totalBeats]`, fire `onTick`; safe while playing |
| `setTempo(bpm)` | takes effect on the next tick; no restart |
| `mute(id)` / `unmute(id)` / `toggleMute(id)` / `setMuted(iterable)` | muted voices fire no notes; already-sounding notes ring out |
| `setLoop(start, end)` / `clearLoop()` | while playing, the cursor wraps at `end` back to `start`; a cursor already past `end` is pulled back to `start` on the next tick (one before `start` plays the lead-in and enters the loop normally); `loopEnd <= loopStart` clears |
| `onTick(beat)` | after every tick and every seek |
| `onEnd()` | once, when the cursor passes `totalBeats + tailBeats` |
| `pitches()` | unique pitches in the loaded song (for `warm()`) |
| `beat`, `playing`, `totalBeats`, `startBeat`, `loopStart`, `loopEnd`, `looping` | read-only state |

`startBeat` is the first sounding onset in the song, so `stop()` on a piece
that opens with rests parks on the first note rather than on silence.

`tailBeats` (constructor option, default 0) keeps the cursor running past the
last onset so a consumer's cursor UI can finish the final note.

### Velocity

Constructor option `velocity`, either a number or a callback:

```js
new Sequencer({
  instrument: piano,
  velocity: ({ activeVoices }) => [0.95, 0.8, 0.65, 0.5][activeVoices - 1],
});
```

The callback receives `{ note, voiceId, beat, durationBeats, activeVoices,
voiceCount, muted }` and returns 0–1. `activeVoices` counts unmuted voices, so
the singHarmony2 policy (solo loud, full choir soft) is a one-liner. A note's
own `velocity` property, when present, always wins. Default: leave velocity
`undefined` so the instrument picks (unchanged `startNote` behavior).

### Instruments

`instrument` is the default sound source. `instruments: { soprano: piano,
bass: cello }` overrides per voice id, falling back to `instrument`. Only
`startNote(pitch, ms, velocity)` and (optionally) `stopAll(fade)` / `warm()`
are required, so any `Instrument` subclass works.

## Constraints

- `startNote`, `warm`, `initInstruments`, `getInstrument`, `Instrument.play()`
  and every existing export keep their current behavior; the existing test
  battery stays green.
- Don't reformat the `src/index.js` export block (editor middleware regex) —
  append in the same style.
- No Web Audio calls in the scheduler beyond delegating to the instrument, so
  it stays testable in the node/jest environment.
- Injectable clock: constructor option `now: () => ms` (default
  `performance.now()`, falling back to `Date.now()`) so tests drive time
  deterministically under jest fake timers.

## Tests (TDD — write first, existing integration-test style)

Timeline (pure, no audio):
- dotted, plain and chord durations; `basis` other than 4
- tie chains of 2 and 3 merge into one event of summed duration; `continue`
  produces no attack; malformed tie (pitch mismatch, orphan `stop`) sounds
  normally; a tie across a rest does not merge
- chord: every member sounds; a tied member inside a chord merges while its
  neighbours re-attack; the voice advances by the first member
- multi-voice: independent streams share one timeline; `totalBeats` = longest
- unknown keys and marker-only elements are ignored/0-beat

Clock and controls (fake timers + a stub instrument recording `startNote`):
- notes fire at their beat, in order, with the right ms durations at a given tempo
- `tempoMap` multiplier stretches the gap between onsets
- `setTempo` mid-play changes the following gaps and nothing already fired
- `pause` stops firing and holds the beat; `play` resumes from it
- `seek` forward skips the notes in between; `seek` back replays them
- muted voice fires nothing; unmute mid-play resumes that voice
- A-B loop wraps at `loopEnd` back to `loopStart` and re-fires the range
- `onTick` reports the beat; `onEnd` fires once at the end and not while looping
- velocity callback receives the unmuted-voice count and its return reaches `startNote`;
  a note's own `velocity` wins
- per-voice `instruments` map routes each voice to its own instrument

## Docs

README section (schema-native playback with the singHarmony2 pattern) and a
CHANGELOG entry. Commit when green — no version bump, no push, no publish.
