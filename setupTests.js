// Use fake timers — Instrument.play() drives note timing with real setTimeout,
// so tests advance time deterministically with jest.advanceTimersByTimeAsync.
jest.useFakeTimers();

afterEach(() => {
  jest.runAllTimers();
});
