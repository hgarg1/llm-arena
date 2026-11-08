/** Errors are reserved for bug-class problems; stylistic findings are warnings so lint can gate CI without a mass rewrite. */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2020: true },
  ignorePatterns: ['dist/', 'node_modules/', 'public/', 'views/', 'prisma/', 'api/', 'scripts/', '*.cjs', '*.js'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-var-requires': 'warn',
    '@typescript-eslint/no-namespace': 'warn',
    '@typescript-eslint/triple-slash-reference': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-prototype-builtins': 'warn',
    'no-useless-escape': 'warn',
    'no-control-regex': 'warn',
    'no-case-declarations': 'warn',
    'prefer-const': 'warn'
  },
  overrides: [
    { files: ['tests/**/*.ts'], env: { jest: true }, rules: { '@typescript-eslint/no-var-requires': 'off' } }
  ]
};
