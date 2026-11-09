// Separate function from api/index.js so match execution has its own scaling, memory and maxDuration.
const { createRunnerApp } = require('../dist/runner-app');

module.exports = createRunnerApp();
