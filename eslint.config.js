import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint configuration.
 *
 * `import/no-cycle` is deliberately an error: the specification forbids circular
 * dependencies, and a cycle between packages is a maintainability defect that is
 * very hard to unwind once it exists.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'prisma/migrations/**',
      '**/generated/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.mjs', '.cjs'],
        },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: 10, ignoreExternal: true }],
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'object-shorthand': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    // Entry points and scripts legitimately write to stdout.
    files: [
      'apps/*/src/index.js',
      'apps/*/src/scripts/**/*.js',
      'scripts/**/*.js',
      'prisma/seed.js',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
];
