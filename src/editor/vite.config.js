import { defineConfig } from 'vite';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_SRC = resolve(__dirname, '../../src');
const INSTRUMENTS_DIR = resolve(PACKAGE_SRC, 'instruments');
const INDEX_FILE = resolve(PACKAGE_SRC, 'index.js');

const RESERVED = new Set(['Instrument', 'Synth', 'Piano', 'Fountain', 'Random', 'Clap']);

const buildInstrumentSource = ({ name, envelope, harmonics, detune, waveform, filterType, filterCutoff }) =>
  `import Synth from './Synth';

class ${name} extends Synth {
  constructor(id = '${name.toLowerCase()}', recordingCallback = null) {
    super(id, recordingCallback);
    this.envelope = ${JSON.stringify(envelope)};
    this.harmonics = ${JSON.stringify(harmonics)};
    this.detune = ${JSON.stringify(detune)};
    this.waveform = '${waveform}';
    this.filterType = '${filterType}';
    this.filterCutoff = ${filterCutoff};
  }
}

export default ${name};
`;

const insertExport = (indexSource, name) => {
  const line = `export { default as ${name} } from './instruments/${name}';`;
  if (indexSource.includes(line)) return indexSource;
  // Insert after the last instrument export
  const matches = [...indexSource.matchAll(/export \{ default as \w+ \} from '\.\/instruments\/\w+';\n/g)];
  if (matches.length === 0) {
    throw new Error('Could not locate instrument export block in src/index.js');
  }
  const last = matches[matches.length - 1];
  const insertAt = last.index + last[0].length;
  return `${indexSource.slice(0, insertAt)}${line}\n${indexSource.slice(insertAt)}`;
};

const createInstrument = (config) => {
  const { name } = config;
  if (typeof name !== 'string' || !/^[A-Z][A-Za-z0-9]+$/.test(name)) {
    throw new Error('Name must be PascalCase (e.g. Brass, ChiptuneLead).');
  }
  if (RESERVED.has(name)) throw new Error(`${name} is reserved by the package.`);
  const filePath = resolve(INSTRUMENTS_DIR, `${name}.js`);
  if (existsSync(filePath)) throw new Error(`${name}.js already exists.`);

  writeFileSync(filePath, buildInstrumentSource(config));
  const indexSource = readFileSync(INDEX_FILE, 'utf-8');
  writeFileSync(INDEX_FILE, insertExport(indexSource, name));

  return { name, file: `src/instruments/${name}.js` };
};

const createInstrumentPlugin = () => ({
  name: 'create-instrument',
  configureServer(server) {
    server.middlewares.use('/api/instruments', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        try {
          const result = createInstrument(JSON.parse(body));
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
  },
});

export default defineConfig({
  server: { port: 5174 },
  plugins: [createInstrumentPlugin()],
});
