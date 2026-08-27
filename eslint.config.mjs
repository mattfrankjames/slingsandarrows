import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * Most of the value here isn't style — it's the four project rules at the
 * bottom of each block, which encode invariants this codebase has already
 * broken at least once.
 */
export default [
  { ignores: ['dist/**', '.parcel-cache/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },

  js.configs.recommended,

  // ── Browser code ───────────────────────────────────────────────────────────
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],

      // Unreviewed innerHTML is how user content becomes markup. board.js and
      // post-render.js build nodes with createElement/textContent instead;
      // this keeps that a rule rather than a habit. Assigning a string literal
      // (`el.innerHTML = ''`) is fine and stays allowed.
      'no-restricted-syntax': [
        'error',
        {
          // Constants are fine — a string literal, or a template literal with
          // nothing interpolated into it. Only assignments that splice a value
          // into markup are flagged.
          selector:
            "AssignmentExpression[left.property.name='innerHTML']" +
            ":not([right.type='Literal'])" +
            ":not([right.type='TemplateLiteral'][right.expressions.length=0])",
          message:
            'Interpolated innerHTML risks injecting user content as markup. Build nodes with createElement/textContent, or escape first and add an eslint-disable with a reason.',
        },
      ],
    },
  },

  // ── Browser code, minus the shared library ─────────────────────────────────
  // Each of these prevents a specific regression that has already happened.
  {
    files: ['src/**/*.js'],
    ignores: ['src/core/js/lib/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'localStorage',
          message:
            'The session lives in src/core/js/lib/session.js. Six modules used to read `gotrue.user` directly and two forgot to check expires_at.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Use src/core/js/lib/session.js — it owns the stored session.',
        },
      ],
    },
  },

  // ── Cloudinary credentials ─────────────────────────────────────────────────
  // PR #86 moved the composer into a new file and carried the unsigned
  // upload_preset along with it, re-introducing the leak #87 had just fixed.
  // Only lib/media.js talks to Cloudinary.
  {
    files: ['src/**/*.js'],
    ignores: ['src/core/js/lib/media.js'],
    rules: {
      // NOTE: flat config *replaces* a rule rather than merging it, so this
      // list must repeat the innerHTML selector from the block above —
      // otherwise defining no-restricted-syntax here would silently disable it
      // for every file this block matches.
      'no-restricted-syntax': [
        'error',
        {
          // Constants are fine — a string literal, or a template literal with
          // nothing interpolated into it. Only assignments that splice a value
          // into markup are flagged.
          selector:
            "AssignmentExpression[left.property.name='innerHTML']" +
            ":not([right.type='Literal'])" +
            ":not([right.type='TemplateLiteral'][right.expressions.length=0])",
          message:
            'Interpolated innerHTML risks injecting user content as markup. Build nodes with createElement/textContent, or escape first and add an eslint-disable with a reason.',
        },
        {
          selector: "Literal[value='upload_preset']",
          message:
            'Uploads go through src/core/js/lib/media.js, which fetches a signed signature. An unsigned upload_preset in client code ships to the browser.',
        },
        {
          selector: "MemberExpression[object.property.name='env'][property.name=/^CLOUDINARY/]",
          message:
            'Parcel inlines process.env at build time, so this would put the credential in a public bundle. Cloudinary config is server-side only.',
        },
      ],
    },
  },

  // ── The core / site boundary ───────────────────────────────────────────────
  // src/core is the part of this codebase that is not about one band; src/site
  // is everything that is. Keeping the dependency pointing one way is the cheap
  // half of making this shareable later — the expensive half is retrofitting
  // the discipline, which means auditing every file.
  //
  // This catches imports. tests/unit/boundary.test.js catches the other
  // direction of the same problem: core *containing* band-specific values,
  // which no import rule can see.
  {
    files: ['src/core/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/site/**', '../site/*', './site/*'],
              message:
                'src/core must stay band-agnostic. Take the value through configuration rather than importing it from src/site.',
            },
          ],
        },
      ],
    },
  },

  // ── Netlify Functions ──────────────────────────────────────────────────────
  {
    files: ['netlify/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // ── Function handlers ──────────────────────────────────────────────────────
  {
    files: ['netlify/functions/**/*.mjs'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@netlify/blobs',
              message:
                'Go through netlify/lib/store.mjs — it owns paging, and a direct list()+get() loop reads the entire store on every request.',
            },
          ],
        },
      ],
      // Twelve functions each had their own JWT decoder that never checked a
      // signature. Identity checks live in netlify/lib/auth.mjs.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='clientContext']",
          message:
            'Resolve the caller with getUser()/requireUser() from netlify/lib/auth.mjs, which verifies the token against Identity.',
        },
        {
          selector: "NewExpression[callee.name='Response'][arguments.0.callee.name='JSON']",
          message: 'Use json() from netlify/lib/http.mjs so the content type and error shape stay consistent.',
        },
      ],
    },
  },

  // ── Tooling and tests ──────────────────────────────────────────────────────
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.js', '*.config.js', '*.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Browser globals too: the bodies of page.evaluate() are serialised and
      // run in the page, so `document` there is real.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  prettier,
];
