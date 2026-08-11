import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      output: {
        // Only explicitly-matched packages land in a named chunk — otherwise
        // Rollup merges their whole dep tree in, which captured the eagerly-
        // used `clsx` into chunk-recharts and forced the entry to preload it.
        onlyExplicitManualChunks: true,
        // Function form: assign modules by package name. Packages exclusive
        // to one named chunk (lodash, zustand, classcat, d3-*, …) follow
        // their importer into that chunk automatically.
        manualChunks(id: string) {
          const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id.replace(/\\/g, '/'));
          const pkg = m?.[1];
          if (!pkg) return;
          // Org-chart stack serves exactly one route (/org/chart) — on demand.
          if (
            pkg === '@xyflow/react' ||
            pkg === '@xyflow/system' ||
            pkg === 'dagre' ||
            pkg === 'html-to-image'
          ) {
            return 'chunk-orgchart';
          }
          // Recharts + its exclusive wrappers — chart pages load on demand.
          // NOTE: clsx stays out on purpose (used eagerly by lib/utils).
          if (
            pkg === 'recharts' ||
            pkg === 'react-smooth' ||
            pkg === 'recharts-scale' ||
            pkg === 'victory-vendor'
          ) {
            return 'chunk-recharts';
          }
          // Framework runtime — shared by every route chunk, cache-stable.
          if (
            pkg === 'react' ||
            pkg === 'react-dom' ||
            pkg === 'scheduler' ||
            pkg === 'react-router' ||
            pkg === 'react-router-dom'
          ) {
            return 'vendor-react';
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
