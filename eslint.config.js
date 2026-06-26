// Flat config (ESLint 9). Replaces the legacy .eslintrc, which ESLint 9 no
// longer discovers reliably. Lints the whole src/ tree deterministically.
const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2018,
            sourceType: 'module',
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            ...tsPlugin.configs['eslint-recommended'].overrides?.[0]?.rules,
            ...tsPlugin.configs.recommended.rules,
            'quotes': ['warn', 'single'],
            'indent': ['warn', 4, { SwitchCase: 1 }],
            'semi': ['warn', 'always'],
            'comma-dangle': ['warn', 'always-multiline'],
            'dot-notation': 'off',
            'eqeqeq': 'warn',
            'curly': ['warn', 'all'],
            'brace-style': ['warn'],
            'prefer-arrow-callback': ['warn'],
            'max-len': ['warn', 140],
            'no-console': ['warn'],
            'comma-spacing': ['error'],
            'no-multi-spaces': ['warn', { ignoreEOLComments: true }],
            'lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            // Event-callback signatures often keep positional args they don't use.
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
        },
    },
    {
        files: ['test/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2020,
            sourceType: 'module',
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            'quotes': ['warn', 'single'],
            'semi': ['warn', 'always'],
            'comma-dangle': ['warn', 'always-multiline'],
            '@typescript-eslint/no-explicit-any': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
        },
    },
];
