import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['.st/**', 'node_modules/**', 'out/**'] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
        rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
    },
    {
        files: ['extension/**/*.js'],
        languageOptions: { globals: { ...globals.browser, SillyTavern: 'readonly', jQuery: 'readonly', $: 'readonly', toastr: 'readonly' } },
    },
];
