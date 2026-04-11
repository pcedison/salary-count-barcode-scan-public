import fs from 'fs';

const bundlePath = 'dist/index.js';
const bundle = fs.readFileSync(bundlePath, 'utf8');

const forbiddenPatterns = [
  { pattern: 'from "vite"', reason: 'production server bundle must not import vite' },
  { pattern: "from 'vite'", reason: 'production server bundle must not import vite' },
  {
    pattern: 'from "@vitejs/plugin-react"',
    reason: 'production server bundle must not import @vitejs/plugin-react',
  },
  {
    pattern: "from '@vitejs/plugin-react'",
    reason: 'production server bundle must not import @vitejs/plugin-react',
  },
  { pattern: 'vite.config.ts', reason: 'production server bundle must not embed vite.config.ts' },
];

for (const { pattern, reason } of forbiddenPatterns) {
  if (bundle.includes(pattern)) {
    throw new Error(`${reason}: found ${JSON.stringify(pattern)} in ${bundlePath}`);
  }
}

console.log('[verify-runtime-bundle] Production runtime bundle is free of Vite-only imports.');
