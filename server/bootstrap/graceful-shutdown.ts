import type { Server } from 'http';

type RuntimeServices = {
  stop(): void;
};

type Logger = {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
};

type ProcessLike = {
  once(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): unknown;
  off(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): unknown;
  exit(code?: number): never | void;
};

type InstallGracefulShutdownOptions = {
  server: Pick<Server, 'close'>;
  runtimeServices: RuntimeServices;
  logger: Logger;
  processLike?: ProcessLike;
  signals?: NodeJS.Signals[];
  shutdownTimeoutMs?: number;
};

const DEFAULT_SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function installGracefulShutdown({
  server,
  runtimeServices,
  logger,
  processLike = process,
  signals = DEFAULT_SHUTDOWN_SIGNALS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}: InstallGracefulShutdownOptions): { uninstall(): void } {
  let shuttingDown = false;
  let forceExitTimer: NodeJS.Timeout | null = null;
  const handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();

  const finish = (code: number) => {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }

    processLike.exit(code);
  };

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully`);

    try {
      runtimeServices.stop();
    } catch (error) {
      logger.error('Failed to stop runtime services during shutdown', error);
    }

    forceExitTimer = setTimeout(() => {
      logger.error(`Graceful shutdown timed out after ${shutdownTimeoutMs} ms; forcing exit`);
      processLike.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref?.();

    server.close((error?: Error) => {
      if (error) {
        logger.error('HTTP server failed to close during shutdown', error);
        finish(1);
        return;
      }

      logger.info('Graceful shutdown complete');
      finish(0);
    });
  };

  for (const signal of signals) {
    const handler: NodeJS.SignalsListener = () => shutdown(signal);
    handlers.set(signal, handler);
    processLike.once(signal, handler);
  }

  return {
    uninstall() {
      for (const [signal, handler] of handlers) {
        processLike.off(signal, handler);
      }

      if (forceExitTimer) {
        clearTimeout(forceExitTimer);
        forceExitTimer = null;
      }
    },
  };
}
