import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Piano,
  Fountain,
  Random,
  Clap,
  audioContextManager,
} from 'resound-sound';
import './App.css';

const INSTRUMENT_CLASSES = { Piano, Fountain, Random, Clap };
const PITCHES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_TO_OFFSET = {
  a: 0,  w: 1,  s: 2,  e: 3,  d: 4,  f: 5,
  t: 6,  g: 7,  y: 8,  h: 9,  u: 10, j: 11,
  k: 12,
};

const buildInstrument = (name) => new INSTRUMENT_CLASSES[name](`editor-${name.toLowerCase()}`);

const Slider = ({ label, value, min, max, step, onChange }) => (
  <label className="slider">
    <span>{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
    <span className="value">{value.toFixed(3)}</span>
  </label>
);

const Waveform = ({ analyser }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!analyser || !canvasRef.current) return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const buffer = new Uint8Array(analyser.fftSize);
    let raf;

    const draw = () => {
      analyser.getByteTimeDomainData(buffer);
      ctx.fillStyle = '#0b1d12';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7ee787';
      ctx.beginPath();
      const slice = canvas.width / buffer.length;
      for (let i = 0; i < buffer.length; i += 1) {
        const v = buffer[i] / 128;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(i * slice, y);
        else ctx.lineTo(i * slice, y);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} width={480} height={140} className="waveform" />;
};

function App() {
  const [instrumentName, setInstrumentName] = useState('Piano');
  const [octave, setOctave] = useState(4);
  const [envelope, setEnvelope] = useState(null);
  const [harmonics, setHarmonics] = useState([]);
  const [detune, setDetune] = useState([]);
  const [presetJson, setPresetJson] = useState('');
  const [analyser, setAnalyser] = useState(null);

  const instrument = useMemo(() => buildInstrument(instrumentName), [instrumentName]);

  // Tap analyser onto the audio context destination so the waveform reflects the live mix.
  useEffect(() => {
    const ctx = audioContextManager.getContext();
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    // Re-route: instruments connect to ctx.destination directly. Tap by also
    // reading from a passive analyser fed from a MediaStreamSource isn't possible
    // without restructuring instruments. Instead, install the analyser inline by
    // monkey-patching the destination — simplest visualization for a dev tool.
    const origConnect = ctx.destination.connect?.bind(ctx.destination);
    node.connect(ctx.destination);
    if (origConnect) ctx.destination.connect = (...args) => origConnect(...args);
    setAnalyser(node);
    return () => node.disconnect();
  }, []);

  // Pull the instrument's tunable surface into editable state whenever it changes.
  useEffect(() => {
    setEnvelope(instrument.envelope ? { ...instrument.envelope } : null);
    setHarmonics(instrument.harmonics ? instrument.harmonics.map((h) => ({ ...h })) : []);
    setDetune(instrument.detune ? [...instrument.detune] : []);
  }, [instrument]);

  // Sync edits back onto the live instrument.
  useEffect(() => {
    if (envelope) instrument.envelope = envelope;
  }, [envelope, instrument]);
  useEffect(() => {
    if (harmonics.length) instrument.harmonics = harmonics;
  }, [harmonics, instrument]);
  useEffect(() => {
    if (detune.length) instrument.detune = detune;
  }, [detune, instrument]);

  const playPitch = (offset) => {
    const noteIndex = offset % 12;
    const oct = octave + Math.floor(offset / 12);
    const pitch = `${PITCHES[noteIndex]}/${oct}`;
    instrument.play({
      data: [{ pitch, length: '1/4' }],
      tempo: 120,
      basis: 4,
    });
  };

  const playArpeggio = () => {
    instrument.play({
      data: [
        { pitch: `C/${octave}`, length: '1/8' },
        { pitch: `E/${octave}`, length: '1/8' },
        { pitch: `G/${octave}`, length: '1/8' },
        { pitch: `C/${octave + 1}`, length: '1/4' },
      ],
      tempo: 120,
      basis: 4,
    });
  };

  // Computer-keyboard input.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.repeat) return;
      const offset = KEY_TO_OFFSET[e.key];
      if (offset !== undefined) playPitch(offset);
      if (e.key === ' ') {
        e.preventDefault();
        playArpeggio();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const exportPreset = () => {
    const preset = {
      instrument: instrumentName,
      ...(envelope && { envelope }),
      ...(harmonics.length && { harmonics }),
      ...(detune.length && { detune }),
    };
    const json = JSON.stringify(preset, null, 2);
    setPresetJson(json);
    if (navigator.clipboard) navigator.clipboard.writeText(json);
  };

  return (
    <div className="app">
      <header>
        <h1>resound-sound playground</h1>
        <p className="hint">
          Keys a-k play C{octave}–C{octave + 1} (w/e/t/y/u = black keys). Space plays arpeggio.
        </p>
      </header>

      <section className="row">
        <div className="panel">
          <h2>Instrument</h2>
          <select
            value={instrumentName}
            onChange={(e) => setInstrumentName(e.target.value)}
          >
            {Object.keys(INSTRUMENT_CLASSES).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>

          <label className="slider">
            <span>Octave</span>
            <input
              type="range"
              min={1}
              max={6}
              step={1}
              value={octave}
              onChange={(e) => setOctave(parseInt(e.target.value, 10))}
            />
            <span className="value">{octave}</span>
          </label>

          <button onClick={() => playPitch(0)}>Play root</button>
          <button onClick={playArpeggio}>Play arpeggio</button>
          <button onClick={() => instrument.stop()}>Stop</button>
        </div>

        {envelope && (
          <div className="panel">
            <h2>ADSR envelope</h2>
            {['attack', 'decay', 'sustain', 'release'].map((k) => (
              <Slider
                key={k}
                label={k}
                value={envelope[k]}
                min={0}
                max={k === 'sustain' ? 1 : 2}
                step={0.001}
                onChange={(v) => setEnvelope({ ...envelope, [k]: v })}
              />
            ))}
          </div>
        )}

        {harmonics.length > 0 && (
          <div className="panel">
            <h2>Harmonics</h2>
            {harmonics.map((h, i) => (
              <div key={i} className="harmonic-row">
                <span>×{h.multiple}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={h.volume}
                  onChange={(e) => {
                    const next = [...harmonics];
                    next[i] = { ...h, volume: parseFloat(e.target.value) };
                    setHarmonics(next);
                  }}
                />
                <span className="value">{h.volume.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}

        {detune.length > 0 && (
          <div className="panel">
            <h2>Detune (cents)</h2>
            {detune.map((d, i) => (
              <div key={i} className="harmonic-row">
                <span>osc {i + 1}</span>
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={1}
                  value={d}
                  onChange={(e) => {
                    const next = [...detune];
                    next[i] = parseInt(e.target.value, 10);
                    setDetune(next);
                  }}
                />
                <span className="value">{d}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Waveform</h2>
        <Waveform analyser={analyser} />
      </section>

      <section className="panel">
        <h2>Preset</h2>
        <button onClick={exportPreset}>Copy preset JSON</button>
        {presetJson && <pre className="preset">{presetJson}</pre>}
      </section>
    </div>
  );
}

export default App;
