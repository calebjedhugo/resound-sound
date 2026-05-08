export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  setupFiles: ['<rootDir>/setupMocks.js'],
  setupFilesAfterEnv: ['<rootDir>/setupTests.js'],
  testMatch: ['**/src/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/editor/'],
};
