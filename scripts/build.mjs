import { build } from 'esbuild';
await build({
  entryPoints: ['vendor/entry.ts'], bundle: true, platform: 'node', target: 'node22',
  format: 'esm', outfile: 'server/vclip-core.mjs', legalComments: 'inline',
});
console.log('Built extracted Donqui V.Clip core.');
