import fs from 'fs';
import { build } from 'esbuild';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

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
    'process.env.APP_VERSION': JSON.stringify(packageJson.version),
  },
});
