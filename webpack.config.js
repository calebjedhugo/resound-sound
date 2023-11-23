const path = require('path');

module.exports = {
  entry: './src/index.js',
  mode: 'production',
  output: {
    filename: 'index.js',
    path: path.resolve(__dirname, 'src/editor/node_modules/resound-sound'),
    library: 'resound-sound', // Name of the library exported by your module
    libraryTarget: 'umd', // Universal Module Definition
    umdNamedDefine: true,
  },
};
