import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// COOP/COEP enable SharedArrayBuffer + WASM threads (also set in public/_headers for Cloudflare Pages).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [solid()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm', '@jsquash/jxl', 'libraw-wasm'],
  },
  build: { target: 'es2022', sourcemap: true },
});
