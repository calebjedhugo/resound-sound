const path = require('path');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const outputPath = isProduction
    ? 'dist'
    : 'src/editor/node_modules/resound-sound';

  return {
    entry: './src/index.js',
    mode: argv.mode || 'development',
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, outputPath),
      library: 'resound-sound',
      libraryTarget: 'umd',
      umdNamedDefine: true,
    },
  };
};
