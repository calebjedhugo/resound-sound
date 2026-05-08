const path = require('path');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const outputPath = isProduction
    ? 'dist'
    : 'src/editor/node_modules/resound-sound/dist';

  return {
    entry: './src/index.js',
    mode: argv.mode || 'development',
    target: 'web',
    experiments: {
      outputModule: true,
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, outputPath),
      library: { type: 'module' },
      module: true,
      environment: { module: true },
      clean: true,
    },
    resolve: {
      extensions: ['.js'],
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          resolve: { fullySpecified: false },
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [['@babel/preset-env', { targets: { esmodules: true } }]],
            },
          },
        },
      ],
    },
  };
};
