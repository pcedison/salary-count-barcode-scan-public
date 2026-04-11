import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client', 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@assets': path.resolve(__dirname, 'attached_assets')
    }
  },
  test: {
    environment: 'node',
    include: ['server/**/*.real-db.test.ts'],
    setupFiles: ['server/test-utils/load-env.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1
  }
});
