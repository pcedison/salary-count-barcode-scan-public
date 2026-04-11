import { logOperation, OperationType } from './admin-auth';
import { attachApiFallbackHandlers, createConfiguredApp } from './bootstrap/create-app';
import { startRuntimeServices } from './bootstrap/runtime-services';
import { registerRoutes } from './routes';
import { serveStatic } from './static';
import { createLogger } from './utils/logger';

const app = createConfiguredApp();
const appLog = createLogger('server');
const isDevelopment = process.env.NODE_ENV === 'development';

(async () => {
  const server = await registerRoutes(app);

  attachApiFallbackHandlers(app, appLog);

  if (isDevelopment) {
    const viteModuleUrl = new URL('./vite.ts', import.meta.url).href;
    const { setupVite } = await import(viteModuleUrl);
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT) || 5000;

  server.listen(
    {
      port,
      host: '0.0.0.0',
      ...(process.platform !== 'win32' && { reusePort: true }),
    },
    () => {
      appLog.info(`[server] serving on port ${port}`);

      const runtimeServices = startRuntimeServices({ logger: appLog });

      server.once('close', () => {
        runtimeServices.stop();
      });

      logOperation(
        OperationType.SYSTEM_CONFIG,
        '系統已啟動，資料庫監控、備份與保留排程已開始執行',
        { success: true }
      );
    }
  );
})();
