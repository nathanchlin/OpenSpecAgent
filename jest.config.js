// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  verbose: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  collectCoverageFrom: [
    'server/**/*.js',
    'public/helpers.js',
    '!server/index.js',
  ],
};
