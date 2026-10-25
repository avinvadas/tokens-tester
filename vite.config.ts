/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Content Security Policy injected into the built page.
 *
 * Everything is inlined by vite-plugin-singlefile, so the page needs no
 * external scripts, styles, fonts or images. `connect-src` stays open to
 * https (and local http) only so the user can load a tokens file from a URL.
 * The hosted build will add the usability-recorder domains in milestone 8;
 * the strict build never will.
 */
function csp(strict: boolean): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'connect-src https: http://localhost:* http://127.0.0.1:*',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'tt-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
      const label = `<meta name="tt-build" content="${strict ? 'strict' : 'hosted'}">`;
      return html.replace('<!-- tt:csp -->', `${meta}\n    ${label}`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const strict = mode === 'strict';
  return {
    base: './',
    define: { __STRICT__: JSON.stringify(strict) },
    plugins: [csp(strict), viteSingleFile()],
    build: {
      outDir: strict ? 'dist-strict' : 'dist',
      target: 'es2022',
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
