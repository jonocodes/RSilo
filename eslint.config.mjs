import tseslint from 'typescript-eslint';

// Type-aware: each file is linted with the types of its nearest tsconfig.json
// (tsconfig.json for src, test/tsconfig.json for test). Violations that
// predate these rules are baselined in eslint-suppressions.json; fix one and
// run `bun run lint:prune` to drop it from the baseline.
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'data/**', 'drizzle/**', 'dist/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['self'] }],
      // `async` without `await` is how the D1 shim and test doubles implement
      // promise-returning APIs, so that a throw rejects instead of escaping.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
