#!/usr/bin/env node
/* Vendors the few third-party runtime modules JARVIS actually uses into
   site/vendor/ as plain classic scripts (no bundler at runtime, no npm at deploy).

   - Dexie (Apache-2.0) UMD build, copied verbatim from node_modules.
   - ts-fsrs (MIT) bundled to an IIFE global `FSRS` with esbuild.

   Apache-2.0 requires redistributions to keep the license and NOTICE, so every
   generated file gets a short banner and the upstream license texts are copied
   next to them as site/vendor/*.LICENSE.txt / *.NOTICE.txt.

   Run: node tools/build/vendor.mjs
   The generated files are committed so the deployed site stays dependency-free. */
import { mkdirSync, copyFileSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'site', 'vendor');
mkdirSync(out, { recursive: true });

const readVersion = pkg => JSON.parse(readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;

function banner(lines) {
  return '/*! ' + lines.join('\n    ') + ' */\n';
}

/* ── Dexie (Apache-2.0) ───────────────────────────────────────────── */
const dexieVersion = readVersion('dexie');
copyFileSync(path.join(root, 'node_modules', 'dexie', 'LICENSE'), path.join(out, 'dexie.LICENSE.txt'));
copyFileSync(path.join(root, 'node_modules', 'dexie', 'NOTICE'), path.join(out, 'dexie.NOTICE.txt'));
writeFileSync(
  path.join(out, 'dexie.min.js'),
  banner([
    `Dexie v${dexieVersion} — Apache-2.0`,
    'Copyright (c) 2014-2024 David Fahlander',
    'Upstream: https://github.com/dexie/Dexie.js',
    'License: site/vendor/dexie.LICENSE.txt · NOTICE: site/vendor/dexie.NOTICE.txt',
  ]) + readFileSync(path.join(root, 'node_modules', 'dexie', 'dist', 'dexie.min.js'), 'utf8'),
);

/* ── ts-fsrs (MIT) ────────────────────────────────────────────────── */
const fsrsVersion = readVersion('ts-fsrs');
copyFileSync(path.join(root, 'node_modules', 'ts-fsrs', 'LICENSE'), path.join(out, 'ts-fsrs.LICENSE.txt'));

await build({
  entryPoints: [path.join(root, 'tools', 'build', 'fsrs-entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'FSRS',
  target: ['es2019'],
  outfile: path.join(out, 'fsrs.min.js'),
  legalComments: 'none',
  banner: {
    js: banner([
      `ts-fsrs v${fsrsVersion} — MIT`,
      'Upstream: https://github.com/open-spaced-repetition/ts-fsrs',
      'License: site/vendor/ts-fsrs.LICENSE.txt',
    ]).trim(),
  },
});

for (const f of ['dexie.min.js', 'fsrs.min.js']) {
  console.log(`${f}: ${(statSync(path.join(out, f)).size / 1024).toFixed(1)} KB`);
}
