import { defineConfig, type Plugin } from 'vite';

// The offline core's process (src/core/entry.ts), bundled with every package it uses into one file
// beside main, so the installed app ships no node_modules for it. Node's own modules and electron
// stay outside; `node:sqlite` is the database, built into Electron.

/** Carries this build's server address to main, which reads it at start (see main.ts). */
function buildConfig(): Plugin {
  return {
    name: 'bolusi-build-config',
    generateBundle() {
      const apiBaseUrl = process.env['BOLUSI_API_URL'];
      this.emitFile({
        type: 'asset',
        fileName: 'build-config.json',
        source: JSON.stringify(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
      });
    },
  };
}

export default defineConfig({
  plugins: [buildConfig()],
  ssr: { noExternal: true, external: ['electron'] },
  build: {
    ssr: 'src/core/entry.ts',
    outDir: 'dist/main',
    emptyOutDir: false,
    target: 'node24',
    sourcemap: true,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'core.js' },
    },
  },
});
