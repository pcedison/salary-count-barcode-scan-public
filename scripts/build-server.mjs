import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  platform: 'node',
  packages: 'external',
  bundle: true,
  format: 'esm',
  outdir: 'dist',
  target: 'node20',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
