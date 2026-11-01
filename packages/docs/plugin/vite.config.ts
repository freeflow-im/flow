// Builds the Docs app for ChatGPT as one script and one stylesheet (plugin/dist/web/app.js and app.css),
// which the plugin server inlines into the MCP UI resource. Separate from the app's own Vite build.
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  base: './',
  // `vite --config plugin/vite.config.ts` serves web/harness.html: the app inside a sandboxed iframe with a
  // stand-in for ChatGPT's host, talking to the plugin server on :3002.
  server: { port: 5174 },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist', 'web'),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: { inlineDynamicImports: true, entryFileNames: 'app.js', chunkFileNames: 'app-[name].js', assetFileNames: 'app.[ext]' },
    },
  },
});
