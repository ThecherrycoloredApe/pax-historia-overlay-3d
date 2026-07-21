import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: {
    content: 'src/content.ts',
    'page-inject': 'src/page-inject.ts',
    popup: 'src/popup.ts',
  },
  bundle: true,
  format: 'iife',
  target: ['chrome111'],
  outdir: 'dist',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  loader: { '.glb': 'binary', '.png': 'binary' },
};

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/popup.html', 'dist/popup.html');
}

if (watch) {
  const ctx = await esbuild.context(options);
  await copyStatic();
  await ctx.watch();
  console.log('[build] watch actif — recharger l\'extension après chaque modif de manifest.json');
} else {
  await esbuild.build(options);
  await copyStatic();
}
