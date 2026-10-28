import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The built page loads only its own files and talks only to its own server; the dev server's
// inline refresh script needs more, so the policy goes into the built page only.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

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

// Served by apps/server from the site root (WEB_DIR), so asset paths are absolute. In development
// the API calls go to a local server (BOLUSI_API_URL, default http://localhost:3000).
export default defineConfig({
  root: 'src',
  base: '/',
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Customers open it on cheap phones over mobile data.
    target: 'es2020',
  },
  server: {
    port: 5184,
    strictPort: true,
    proxy: { '/v1': process.env['BOLUSI_API_URL'] ?? 'http://localhost:3000' },
  },
});
