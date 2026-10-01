import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(root, 'shared') } },
  test: {
    environment: 'node',
    include: ['server/storage.payrollCorrection.real-db.test.ts'],
    // Deliberately do not use load-env.ts or the other real-database suites.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
