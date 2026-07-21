/**
 * Serveur de prévisualisation des modèles (dev uniquement, hors extension).
 *
 *   node tools/preview-server.mjs
 *
 *   http://localhost:5599            → planche des TYPES tels que rendus par
 *                                      l'overlay (src/dev/model-preview.ts)
 *   http://localhost:5599/sheet?dir=X → planche de contact d'un kit BRUT posé
 *                                      dans preview/kit/X/ (src/dev/asset-sheet.ts)
 *
 * Les planches sont enregistrées dans preview/*.png.
 *
 * RAISON D'ÊTRE : les types composites (usine, infrastructure, port, monument)
 * sont assemblés à la main dans asset-models.ts avec des échelles et positions
 * relatives, et les kits nomment leurs modèles `building-a` … `building-t`.
 * Composer ou choisir sans regarder produit des résultats absurdes (une usine
 * qui ressemble à une ferme). Toujours vérifier ici AVANT de livrer.
 */

import * as esbuild from 'esbuild';
import { createServer } from 'node:http';
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, normalize as normalizePath } from 'node:path';

const PORT = 5599;
const KIT_ROOT = 'preview/kit';

const bundle = async (entry) => {
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: ['chrome111'],
    write: false,
    loader: { '.glb': 'binary', '.png': 'binary' },
    logLevel: 'warning',
  });
  return r.outputFiles[0].text;
};

const scripts = {
  '/preview.js': await bundle('src/dev/model-preview.ts'),
  '/sheet.js': await bundle('src/dev/asset-sheet.ts'),
};

const page = (src) => `<!doctype html><meta charset="utf-8"><title>PREVIEW</title>
<style>body{margin:0;background:#222;display:grid;place-items:center;min-height:100vh}canvas{max-width:100%}</style>
<script type="module" src="${src}"></script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, type, body) => res.writeHead(code, { 'content-type': type }).end(body);

  try {
    if (req.method === 'POST' && url.pathname === '/save') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const name = (url.searchParams.get('name') ?? 'models').replace(/[^\w-]/g, '');
      await mkdir('preview', { recursive: true });
      await writeFile(`preview/${name}.png`, Buffer.from(body.split(',')[1], 'base64'));
      console.log(`planche enregistree : preview/${name}.png`);
      return res.writeHead(204).end();
    }

    if (url.pathname === '/kit-list') {
      const dir = (url.searchParams.get('dir') ?? '').replace(/[^\w-]/g, '');
      const files = (await readdir(join(KIT_ROOT, dir)))
        .filter((f) => f.toLowerCase().endsWith('.glb'))
        .sort();
      return send(200, 'application/json', JSON.stringify(files));
    }

    if (url.pathname.startsWith('/kit/')) {
      // normalize + préfixe vérifié : pas d'échappée hors de preview/kit/
      const target = normalizePath(join(KIT_ROOT, url.pathname.slice('/kit/'.length)));
      if (!target.startsWith(normalizePath(KIT_ROOT))) return res.writeHead(403).end();
      const type = target.endsWith('.png') ? 'image/png' : 'model/gltf-binary';
      return send(200, type, await readFile(target));
    }

    if (scripts[url.pathname]) return send(200, 'text/javascript', scripts[url.pathname]);
    if (url.pathname === '/sheet') return send(200, 'text/html', page('/sheet.js'));
    return send(200, 'text/html', page('/preview.js'));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => console.log(`preview sur http://localhost:${PORT}`));
