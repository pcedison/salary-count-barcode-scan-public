import { createLogger } from '../utils/logger';

const DEFAULT_LINE_OAUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type StorageModule = typeof import('../storage');

export interface RuntimeStoppable {
  stop(): void;
}

type RuntimeLogger = {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
};

type StartLineOAuthCleanupOptions = {
  intervalMs?: number;
  logger?: RuntimeLogger;
  importStorage?: () => Promise<StorageModule>;
};

const log = createLogger('line-oauth-cleanup');

export function startLineOAuthCleanup(
  options: StartLineOAuthCleanupOptions = {}
): RuntimeStoppable {
  const {
    intervalMs = DEFAULT_LINE_OAUTH_CLEANUP_INTERVAL_MS,
    logger = log,
    importStorage = () => import('../storage'),
  } = options;

  let cleanupHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  if (!process.env.LINE_LOGIN_CHANNEL_ID) {
    return {
      stop() {},
    };
  }

  void importStorage()
    .then(({ storage }) => {
      if (stopped) {
        return;
      }

      cleanupHandle = setInterval(async () => {
        try {
          await storage.cleanupExpiredOAuthStates();
        } catch (error) {
          logger.warn('LINE OAuth state cleanup failed', error);
        }
      }, intervalMs);

      logger.info('LINE OAuth state cleanup started', { intervalMs });
    })
    .catch((error) => {
      logger.error('Failed to initialize LINE OAuth state cleanup', error);
    });

  return {
    stop() {
      stopped = true;

      if (cleanupHandle) {
        clearInterval(cleanupHandle);
        cleanupHandle = null;
      }
    },
  };
}
