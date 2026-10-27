import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The shipped page may load only its own files; the dev server's inline refresh script needs more,
// so the policy goes into the built page only.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

function contentSecurityPolicy(): Plugin {
  return {
    name: 'bolusi-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

// The renderer: a plain web bundle loaded from disk by the Electron window (relative asset paths).
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome140',
    // Loaded from disk, never over a network: one bundle is fine.
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5183, strictPort: true },
});
