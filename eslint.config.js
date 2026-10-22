'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'out/**', 'renderer/vendor/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Classic browser scripts loaded by renderer/index.html. Functions are
    // shared between files through the global scope.
    files: ['renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, Chart: 'readonly', dashboard: 'readonly', module: 'writable' },
    },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', vars: 'local' }] },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
