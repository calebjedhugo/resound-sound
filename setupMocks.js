/**
 * Browser API mocks for jest.
 * Lifted from resound-fe/src/__tests__/helpers/mocks.js, audio-only subset.
 *
 * Nodes remember their connections (`outputs`; a node or destination that
 * is connected to lists its `inputs`), so a test can follow where a sound
 * goes: e.g. what reaches `context.destination`.
 */

function connectNode(from, to) {
  from.outputs.push(to);
  if (to && to.inputs) to.inputs.push(from);
  return to;
}

function disconnectNode(from) {
  from.outputs.forEach((to) => {
    if (to && to.inputs) to.inputs = to.inputs.filter((node) => node !== from);
  });
  from.outputs = [];
}

/**
 * A mock AudioParam: every scheduling method, recorded.
 */
function mockParam(value) {
  return {
    value,
    setValueAtTime: jest.fn(),
    linearRampToValueAtTime: jest.fn(),
    exponentialRampToValueAtTime: jest.fn(),
    cancelScheduledValues: jest.fn(),
    cancelAndHoldAtTime: jest.fn(),
    setTargetAtTime: jest.fn(),
  };
}

class MockNode {
  constructor() {
    this.inputs = [];
    this.outputs = [];
  }

  connect(to) {
    return connectNode(this, to);
  }

  disconnect() {
    disconnectNode(this);
  }
}

class MockGainNode extends MockNode {
  constructor() {
    super();
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

}

class MockOscillatorNode extends MockNode {
  constructor() {
    super();
    this.frequency = mockParam(440);
    this.detune = mockParam(0);
    this.type = 'sine';
    this.onended = null;
  }

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

class MockBiquadFilterNode extends MockNode {
  constructor(sampleRate = 44100) {
    super();
    this.sampleRate = sampleRate;
    this.type = 'lowpass';
    this.frequency = mockParam(350);
    this.Q = mockParam(1);
    this.gain = {
      value: 0,
      setValueAtTime: jest.fn(),
    };
  }


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

class MockWaveShaperNode extends MockNode {
  constructor() {
    super();
    this.curve = null;
    this.oversample = 'none';
  }

}

class MockDynamicsCompressorNode extends MockNode {
  constructor() {
    super();
    this.threshold = { value: -24 };
    this.knee = { value: 30 };
    this.ratio = { value: 12 };
    this.attack = { value: 0.003 };
    this.release = { value: 0.25 };
    this.reduction = 0;
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = new MockNode();
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

  createDynamicsCompressor() {
    return new MockDynamicsCompressorNode();
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
    const source = {
      buffer: null,
      inputs: [],
      outputs: [],
      connect: jest.fn((to) => connectNode(source, to)),
      disconnect: jest.fn(() => disconnectNode(source)),
      start: jest.fn(),
      stop: jest.fn(),
      onended: null,
    };
    return source;
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
