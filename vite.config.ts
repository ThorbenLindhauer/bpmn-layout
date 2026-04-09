/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'BpmnLayout',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['bpmn-moddle', 'elkjs', 'elkjs/lib/elk.bundled.js'],
    },
  },
  plugins: [dts({ include: ['src'] })],
  optimizeDeps: {
    include: ['elkjs/lib/elk.bundled.js'],
  },
  test: {
    globals: true,
  },
});
