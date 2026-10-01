import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(root, 'shared') } },
  test: {
    environment: 'node', include: ['server/db-monitoring.payrollBackup.real-db.test.ts'],
    // No .env loader or other database suites.
    fileParallelism: false, maxWorkers: 1, minWorkers: 1,
    testTimeout: 20000, hookTimeout: 20000,
  },
});
