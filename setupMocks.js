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
  constructor() {
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
    return new MockBiquadFilterNode();
  }

  createBuffer(channels, length, sampleRate) {
    const channelData = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate: sampleRate || this.sampleRate,
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
    return Promise.resolve();
  }

  suspend() {
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
