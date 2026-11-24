export { default as Instrument } from './instruments/Instrument';
export { default as Synth } from './instruments/Synth';
export { default as Piano } from './instruments/Piano';
export { default as Fountain } from './instruments/Fountain';
export { default as Random } from './instruments/Random';
export { default as Clap } from './instruments/Clap';
export { default as Theremin } from './instruments/Theremin';

export { default as audioContextManager } from './lib/AudioContextManager';
export { default as MusicalClock } from './lib/MusicalClock';
export { applyEnvelope } from './lib/Envelope';
export { getFrequency } from './lib/noteFrequencies';
export { getDuration } from './lib/duration';
export { initInstruments, getInstrument, instrumentReady } from './lib/instrumentRegistry';
export { default as Sequencer } from './lib/Sequencer';
export { buildTimeline, noteBeats, elementBeats, soundingBeats } from './lib/timeline';
