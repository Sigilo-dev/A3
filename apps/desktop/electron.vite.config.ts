import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  preload: {
    build: {
      // A sandboxed preload must be one CommonJS bundle, with only Electron external.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  renderer: {
    plugins: [react()],
    build: { minify: true },
    server: { host: '127.0.0.1' }
  }
});
