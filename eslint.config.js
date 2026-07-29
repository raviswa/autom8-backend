// eslint.config.js  (ESLint 9 flat config — CommonJS)
// Rules tuned to the exact failure modes seen in this codebase:
//   - Python "def" keyword accidentally used in JS files  → no-undef
//   - Mixed ?? / || without parens causing SyntaxErrors    → no-mixed-operators
//   - Duplicate route/slug bindings                        → no-dupe-keys
//   - Unused require()s hiding broken imports              → no-unused-vars
//   - Unreachable code after return/throw                  → no-unreachable
//   - Merge conflict markers left in source                → no-warning-comments
//
// Run:  npm run lint
// Fix:  npm run lint:fix

'use strict';

const js      = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // ── Ignore generated / vendor files ─────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'public/**',
      'dist/**',
      'scripts/**',     // seed / one-off scripts
      'migrations/**',  // SQL files, not JS
    ],
  },

  // ── Base recommended rules ───────────────────────────────────────────────────
  js.configs.recommended,

  // ── Node.js / CommonJS backend ───────────────────────────────────────────────
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      // ── Real prod incidents ─────────────────────────────────────────────────
      'no-undef':              'error',   // catches Python keywords (def, None, True) in JS
      'no-unreachable':        'error',   // dead code after return/throw
      'no-dupe-keys':          'error',   // duplicate object keys / route bindings
      'no-duplicate-case':     'error',

      // ── Operator precedence (?? / || SyntaxError incident) ──────────────────
      'no-mixed-operators':    ['error', {
        groups: [
          ['??', '||'], ['??', '&&'],
          ['&&', '||'],
        ],
        allowSamePrecedence: true,
      }],

      // ── Import hygiene ───────────────────────────────────────────────────────
      'no-unused-vars': ['warn', {
        vars: 'all', args: 'after-used', ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],

      // ── Console is fine in backend ───────────────────────────────────────────
      'no-console': 'off',

      // ── Code quality ─────────────────────────────────────────────────────────
      'no-constant-condition':   'warn',
      'no-empty':                ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins':   'warn',

      // ── Async safety ─────────────────────────────────────────────────────────
      'no-async-promise-executor': 'error',
      'no-await-in-loop':          'warn',

      // ── Merge conflict markers (leftover in audit log incident) ─────────────
      'no-warning-comments': ['warn', { terms: ['<<<<<<', '>>>>>>'], location: 'start' }],
    },
  },
];
