const dynamics = {
  fff: 1,
  ff: 0.875,
  f: 0.75,
  mf: 0.625,
  mp: 0.5,
  p: 0.375,
  pp: 0.25,
  ppp: 0.125,
  n: 0.01,
};

const frequencies = {
  C4: 261.626,
  'C#4': 277.18,
  Db4: 277.18,
  D4: 293.66,
  'D#4': 311.13,
  Eb4: 311.13,
  E4: 329.63,
  F4: 349.23,
  'F#4': 369.99,
  G4: 392.0,
  Ab4: 415.3,
  A4: 440,
  Bb4: 466.16,
  B4: 493.88,
};

export { dynamics, frequencies };
