import path from 'path';
import { defineConfig } from 'vitest/config';

// Dedicated vitest config — pure-TS lib tests, no React plugin needed.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
