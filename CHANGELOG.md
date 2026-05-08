# Changelog

All notable changes to this package follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/calebjedhugo/resound-sound/releases/tag/v0.1.0
