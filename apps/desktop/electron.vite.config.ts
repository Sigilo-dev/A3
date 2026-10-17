import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), 'image-worker': resolve('src/main/image-worker.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
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
