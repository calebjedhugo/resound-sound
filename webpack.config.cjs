const path = require('path');

module.exports = (env, argv) => ({
    entry: './src/index.js',
    mode: argv.mode || 'development',
    target: 'web',
    experiments: {
      outputModule: true,
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, 'dist'),
      library: { type: 'module' },
      module: true,
      environment: { module: true },
      clean: false,
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
  });
