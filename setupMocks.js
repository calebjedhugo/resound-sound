/**
 * Browser API mocks for jest.
 * Lifted from resound-fe/src/__tests__/helpers/mocks.js, audio-only subset.
 */

class MockGainNode {
  constructor() {
    this.gain = {
      value: 1,
      setValueAtTime: jest.fn(),
      linearRampToValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
      // Instrument.stopAll() calls this first, inside a try/catch. Without it
      // the whole fade-out silently became a no-op under test.
      cancelScheduledValues: jest.fn(),
      // Instrument.updateVolume()'s ramp, likewise swallowed if missing.
      setTargetAtTime: jest.fn(),
    };
  }

  connect() {
    return this;
  }

  disconnect() {}
}

class MockOscillatorNode {
  constructor() {
    this.frequency = {
      value: 440,
      setValueAtTime: jest.fn(),
      linearRampToValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    };
    this.detune = {
      value: 0,
      setValueAtTime: jest.fn(),
      linearRampToValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    };
    this.type = 'sine';
    this.onended = null;
  }

  connect() {
    return this;
  }

  disconnect() {}
  start() {}
  stop() {
    if (this.onended) {
      setTimeout(() => this.onended(), 0);
    }
  }

  setPeriodicWave() {
    this.type = 'custom';
  }
}

class MockBiquadFilterNode {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.type = 'lowpass';
    this.frequency = {
      value: 350,
      setValueAtTime: jest.fn(),
      linearRampToValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    };
    this.Q = {
      value: 1,
      setValueAtTime: jest.fn(),
    };
    this.gain = {
      value: 0,
      setValueAtTime: jest.fn(),
    };
  }

  connect() {
    return this;
  }

  disconnect() {}

  // The spec's lowpass biquad (Q in dB) at the current frequency/Q values,
  // for code that folds the filter into a periodic wave. Lowpass only.
  getFrequencyResponse(frequencyHz, magResponse, phaseResponse) {
    const theta = (2 * Math.PI * this.frequency.value) / this.sampleRate;
    const alpha = Math.sin(theta) / (2 * 10 ** (this.Q.value / 20));
    const cos = Math.cos(theta);
    const b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
    const a = [1 + alpha, -2 * cos, 1 - alpha];
    // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (a0 + a1 e^-jw + a2 e^-2jw)
    const at = (c, w) => [c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w),
      -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w))];
    frequencyHz.forEach((f, i) => {
      const w = (2 * Math.PI * f) / this.sampleRate;
      const [nr, ni] = at(b, w);
      const [dr, di] = at(a, w);
      const den = dr * dr + di * di;
      const hr = (nr * dr + ni * di) / den;
      const hi = (ni * dr - nr * di) / den;
      magResponse[i] = Math.hypot(hr, hi);
      phaseResponse[i] = Math.atan2(hi, hr);
    });
  }
}

class MockWaveShaperNode {
  constructor() {
    this.curve = null;
    this.oversample = 'none';
  }

  connect() {
    return this;
  }

  disconnect() {}
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = 'running';
    this.sampleRate = 44100;
  }

  createWaveShaper() {
    return new MockWaveShaperNode();
  }

  createPeriodicWave() {
    return {};
  }

  createOscillator() {
    return new MockOscillatorNode();
  }

  createGain() {
    return new MockGainNode();
  }

  createBiquadFilter() {
    return new MockBiquadFilterNode(this.sampleRate);
  }

  createBuffer(channels, length, sampleRate) {
    const channelData = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate: sampleRate || this.sampleRate,
      duration: length / (sampleRate || this.sampleRate),
      getChannelData: () => channelData,
    };
  }

  createBufferSource() {
    return {
      buffer: null,
      connect: jest.fn(() => ({ connect: jest.fn() })),
      start: jest.fn(),
      stop: jest.fn(),
      onended: null,
    };
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
}

class MockOfflineAudioContext extends MockAudioContext {
  constructor(channels = 1, length = 44100, sampleRate = 44100) {
    super();
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels;
  }

  startRendering() {
    return Promise.resolve(this.createBuffer(this.numberOfChannels, this.length, this.sampleRate));
  }
}

global.OfflineAudioContext = MockOfflineAudioContext;
global.webkitOfflineAudioContext = MockOfflineAudioContext;

if (typeof window === 'undefined') {
  global.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
}

global.AudioContext = MockAudioContext;
global.webkitAudioContext = MockAudioContext;
global.window.AudioContext = MockAudioContext;
global.window.webkitAudioContext = MockAudioContext;

/**
 * Minimal `document` mock — just enough for
 * `audioContextManager.resumeOnFirstGesture()` to install/remove one-time
 * gesture listeners. `listeners` is exposed directly so tests can assert on
 * it (e.g. `document.listeners.pointerdown`).
 */
class MockDocument {
  constructor() {
    this.listeners = {};
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
  }

  dispatchEvent(event) {
    const handlers = this.listeners[event.type] || [];
    handlers.slice().forEach((handler) => handler(event));
  }
}

global.document = new MockDocument();
