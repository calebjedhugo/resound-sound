import * as ResoundSound from 'resound-sound';

const { audioContextManager } = ResoundSound;

// Synth is the design surface for new sounds; everything else is in the picker
// for tweaking the existing instruments' tunables.
const INSTRUMENT_NAMES = ['Synth', 'Piano', 'Fountain', 'Random', 'Clap'];
const INSTRUMENT_CLASSES = Object.fromEntries(
  INSTRUMENT_NAMES.filter((n) => ResoundSound[n]).map((n) => [n, ResoundSound[n]])
);
const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_TO_OFFSET = {
  a: 0,  w: 1,  s: 2,  e: 3,  d: 4,  f: 5,
  t: 6,  g: 7,  y: 8,  h: 9,  u: 10, j: 11,
  k: 12,
};

const state = {
  instrumentName: 'Synth',
  instrument: null,
  octave: 4,
};

const WAVEFORMS = ['sine', 'triangle', 'sawtooth', 'square'];
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'];

const root = document.getElementById('app');

const h = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
};

const slider = ({ label, value, min, max, step, onInput, format }) => {
  const valueEl = h('span', { class: 'value' }, format ? format(value) : value.toFixed(3));
  const input = h('input', {
    type: 'range', min, max, step, value,
    onInput: (e) => {
      const v = parseFloat(e.target.value);
      valueEl.textContent = format ? format(v) : v.toFixed(3);
      onInput(v);
    },
  });
  return h('label', { class: 'slider' }, [h('span', {}, label), input, valueEl]);
};

const buildInstrument = (name) => new INSTRUMENT_CLASSES[name](`editor-${name.toLowerCase()}`);

const playPitch = (offset) => {
  const noteIndex = ((offset % 12) + 12) % 12;
  const oct = state.octave + Math.floor(offset / 12);
  state.instrument.play({
    data: [{ pitch: `${PITCHES[noteIndex]}/${oct}`, length: '1/4' }],
    tempo: 120,
    basis: 4,
  });
};

const playArpeggio = () => {
  const o = state.octave;
  state.instrument.play({
    data: [
      { pitch: `C/${o}`, length: '1/8' },
      { pitch: `E/${o}`, length: '1/8' },
      { pitch: `G/${o}`, length: '1/8' },
      { pitch: `C/${o + 1}`, length: '1/4' },
    ],
    tempo: 120,
    basis: 4,
  });
};

const buildEnvelopePanel = () => {
  const env = state.instrument.envelope;
  if (!env) return null;
  return h('div', { class: 'panel' }, [
    h('h2', {}, 'ADSR envelope'),
    ...['attack', 'decay', 'sustain', 'release'].map((k) =>
      slider({
        label: k,
        value: env[k],
        min: 0,
        max: k === 'sustain' ? 1 : 2,
        step: 0.001,
        onInput: (v) => { env[k] = v; },
      })
    ),
  ]);
};

const buildHarmonicsPanel = () => {
  const harmonics = state.instrument.harmonics;
  if (!harmonics || !harmonics.length) return null;
  return h('div', { class: 'panel' }, [
    h('h2', {}, 'Harmonics'),
    ...harmonics.map((harmonic, i) => {
      const valueEl = h('span', { class: 'value' }, harmonic.volume.toFixed(2));
      const input = h('input', {
        type: 'range', min: 0, max: 1, step: 0.01, value: harmonic.volume,
        onInput: (e) => {
          const v = parseFloat(e.target.value);
          harmonics[i].volume = v;
          valueEl.textContent = v.toFixed(2);
        },
      });
      return h('div', { class: 'harmonic-row' }, [
        h('span', {}, `×${harmonic.multiple}`),
        input,
        valueEl,
      ]);
    }),
  ]);
};

const buildDetunePanel = () => {
  const detune = state.instrument.detune;
  if (!detune || !detune.length) return null;
  return h('div', { class: 'panel' }, [
    h('h2', {}, 'Detune (cents)'),
    ...detune.map((d, i) => {
      const valueEl = h('span', { class: 'value' }, String(d));
      const input = h('input', {
        type: 'range', min: -50, max: 50, step: 1, value: d,
        onInput: (e) => {
          const v = parseInt(e.target.value, 10);
          detune[i] = v;
          valueEl.textContent = String(v);
        },
      });
      return h('div', { class: 'harmonic-row' }, [
        h('span', {}, `osc ${i + 1}`),
        input,
        valueEl,
      ]);
    }),
  ]);
};

const buildTimbrePanel = () => {
  const inst = state.instrument;
  if (inst.waveform === undefined && inst.filterType === undefined && inst.filterCutoff === undefined) {
    return null;
  }
  const children = [h('h2', {}, 'Timbre')];

  if (inst.waveform !== undefined) {
    const select = h('select', {
      onChange: (e) => { inst.waveform = e.target.value; },
    }, WAVEFORMS.map((w) => h('option', { value: w, selected: w === inst.waveform }, w)));
    children.push(h('label', { class: 'slider' }, [h('span', {}, 'waveform'), select, h('span', {})]));
  }
  if (inst.filterType !== undefined) {
    const select = h('select', {
      onChange: (e) => { inst.filterType = e.target.value; },
    }, FILTER_TYPES.map((f) => h('option', { value: f, selected: f === inst.filterType }, f)));
    children.push(h('label', { class: 'slider' }, [h('span', {}, 'filter'), select, h('span', {})]));
  }
  if (inst.filterCutoff !== undefined) {
    children.push(slider({
      label: 'cutoff',
      value: inst.filterCutoff,
      min: 100,
      max: 12000,
      step: 50,
      onInput: (v) => { inst.filterCutoff = v; },
      format: (v) => `${Math.round(v)}Hz`,
    }));
  }
  return h('div', { class: 'panel' }, children);
};

const buildCreatePanel = () => {
  const inst = state.instrument;
  if (state.instrumentName !== 'Synth') return null;

  const nameInput = h('input', { type: 'text', placeholder: 'PascalCaseName', class: 'name-input' });
  const status = h('p', { class: 'hint' });

  const button = h('button', {
    onClick: async () => {
      const name = nameInput.value.trim();
      status.textContent = '';
      if (!name) {
        status.textContent = 'Pick a name first.';
        return;
      }
      const config = {
        name,
        envelope: { ...inst.envelope },
        harmonics: inst.harmonics.map((entry) => ({ ...entry })),
        detune: [...inst.detune],
        waveform: inst.waveform,
        filterType: inst.filterType,
        filterCutoff: inst.filterCutoff,
      };
      try {
        const response = await fetch('/api/instruments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        });
        const result = await response.json();
        if (!response.ok) {
          status.textContent = `Error: ${result.error}`;
          return;
        }
        status.textContent = `Wrote ${result.file}. Reloading…`;
        setTimeout(() => window.location.reload(), 600);
      } catch (e) {
        status.textContent = `Network error: ${e.message}`;
      }
    },
  }, 'Create instrument');

  return h('section', { class: 'panel' }, [
    h('h2', {}, 'Save as new instrument'),
    h('p', { class: 'hint' }, 'Writes src/instruments/<Name>.js and adds it to the package exports. Commit and publish to ship.'),
    nameInput,
    button,
    status,
  ]);
};

const buildWaveform = () => {
  const ctx = audioContextManager.getContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(ctx.destination);
  const canvas = h('canvas', { class: 'waveform', width: 480, height: 140 });
  const c2d = canvas.getContext('2d');
  const buffer = new Uint8Array(analyser.fftSize);
  const draw = () => {
    analyser.getByteTimeDomainData(buffer);
    c2d.fillStyle = '#0b1d12';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.lineWidth = 2;
    c2d.strokeStyle = '#7ee787';
    c2d.beginPath();
    const slice = canvas.width / buffer.length;
    for (let i = 0; i < buffer.length; i += 1) {
      const y = (buffer[i] / 128 * canvas.height) / 2;
      if (i === 0) c2d.moveTo(i * slice, y);
      else c2d.lineTo(i * slice, y);
    }
    c2d.stroke();
    requestAnimationFrame(draw);
  };
  draw();
  return h('section', { class: 'panel' }, [h('h2', {}, 'Waveform'), canvas]);
};

const buildPresetPanel = () => {
  const pre = h('pre', { class: 'preset' });
  pre.style.display = 'none';
  const button = h('button', {
    onClick: () => {
      const inst = state.instrument;
      const preset = {
        instrument: state.instrumentName,
        ...(inst.envelope && { envelope: { ...inst.envelope } }),
        ...(inst.harmonics && { harmonics: inst.harmonics.map((h2) => ({ ...h2 })) }),
        ...(inst.detune && { detune: [...inst.detune] }),
      };
      const json = JSON.stringify(preset, null, 2);
      pre.textContent = json;
      pre.style.display = 'block';
      if (navigator.clipboard) navigator.clipboard.writeText(json);
    },
  }, 'Copy preset JSON');
  return h('section', { class: 'panel' }, [h('h2', {}, 'Preset'), button, pre]);
};

const render = () => {
  state.instrument = buildInstrument(state.instrumentName);

  const select = h('select', {
    onChange: (e) => {
      state.instrumentName = e.target.value;
      render();
    },
  }, Object.keys(INSTRUMENT_CLASSES).map((n) =>
    h('option', { value: n, selected: n === state.instrumentName }, n)
  ));

  const octaveSlider = slider({
    label: 'Octave',
    value: state.octave,
    min: 1,
    max: 6,
    step: 1,
    onInput: (v) => { state.octave = v; hint.textContent = hintText(); },
    format: (v) => String(v),
  });

  const hintText = () =>
    `Keys a-k play C${state.octave}–C${state.octave + 1} (w/e/t/y/u = black keys). Space plays arpeggio.`;
  const hint = h('p', { class: 'hint' }, hintText());

  const controls = h('div', { class: 'panel' }, [
    h('h2', {}, 'Instrument'),
    select,
    octaveSlider,
    h('button', { onClick: () => playPitch(0) }, 'Play root'),
    h('button', { onClick: playArpeggio }, 'Play arpeggio'),
    h('button', { onClick: () => state.instrument.stop() }, 'Stop'),
  ]);

  const panels = h('section', { class: 'row' }, [
    controls,
    buildTimbrePanel(),
    buildEnvelopePanel(),
    buildHarmonicsPanel(),
    buildDetunePanel(),
  ]);

  root.replaceChildren(
    h('header', {}, [h('h1', {}, 'resound-sound playground'), hint]),
    panels,
    buildWaveform(),
    buildPresetPanel(),
    buildCreatePanel(),
  );
};

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const offset = KEY_TO_OFFSET[e.key];
  if (offset !== undefined) playPitch(offset);
  if (e.key === ' ') {
    e.preventDefault();
    playArpeggio();
  }
});

render();
