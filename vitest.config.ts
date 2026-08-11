import path from 'path';
import { defineConfig } from 'vitest/config';

const alias = { '@': path.resolve(__dirname, './src') };

// Two test projects, one command (`npm test` runs both):
//  - node: existing pure-TS lib/logic tests (no DOM, no React plugin needed).
//  - ui:   jsdom + Testing Library component/flow tests under src/__tests__,
//          with the shared browser-API polyfills in src/test/setup.ts.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: ['src/__tests__/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          include: ['src/__tests__/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
});
