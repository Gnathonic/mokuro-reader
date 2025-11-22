import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import svelte from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import prettier from 'eslint-config-prettier';

// Common browser and Node globals
const commonGlobals = {
  // Browser globals
  window: 'readonly',
  Window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  Navigator: 'readonly',
  console: 'readonly',
  localStorage: 'readonly',
  Blob: 'readonly',
  BlobPart: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  fetch: 'readonly',
  File: 'readonly',
  FileList: 'readonly',
  FileReader: 'readonly',
  MessageEvent: 'readonly',
  ErrorEvent: 'readonly',
  EventListener: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  CustomEvent: 'readonly',
  MouseEvent: 'readonly',
  KeyboardEvent: 'readonly',
  TouchEvent: 'readonly',
  DragEvent: 'readonly',
  WheelEvent: 'readonly',
  HTMLElement: 'readonly',
  HTMLDivElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLImageElement: 'readonly',
  HTMLSelectElement: 'readonly',
  Image: 'readonly',
  Worker: 'readonly',
  XMLHttpRequest: 'readonly',
  XMLHttpRequestBodyInit: 'readonly',
  OffscreenCanvas: 'readonly',
  OffscreenCanvasRenderingContext2D: 'readonly',
  createImageBitmap: 'readonly',
  FileSystemEntry: 'readonly',
  FileSystemFileEntry: 'readonly',
  FileSystemDirectoryEntry: 'readonly',
  Response: 'readonly',
  DOMParser: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  TextDecoder: 'readonly',
  Performance: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  btoa: 'readonly',
  caches: 'readonly',
  self: 'readonly',
  // Google API globals
  gapi: 'readonly',
  google: 'readonly',
  // Node globals
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  // ES2022 globals
  globalThis: 'readonly'
};

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022
      },
      globals: commonGlobals
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        sourceType: 'module',
        ecmaVersion: 2022,
        extraFileExtensions: ['.svelte']
      },
      globals: commonGlobals
    },
    plugins: {
      svelte,
      '@typescript-eslint': tsPlugin
    },
    rules: {
      ...svelte.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  // Service worker specific globals
  {
    files: ['**/service-worker.js'],
    languageOptions: {
      globals: {
        ...commonGlobals,
        self: 'readonly'
      }
    },
    rules: {
      'no-undef': 'off'
    }
  },
  // Allow any and unused vars in test files
  {
    files: ['**/__mocks__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },
  prettier,
  {
    ignores: ['build/', '.svelte-kit/', 'dist/', 'node_modules/', '**/*.cjs', '.eslintrc.cjs']
  }
];
