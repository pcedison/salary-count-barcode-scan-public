type Logger = {
  error(message: string, ...meta: unknown[]): void;
};

type ProcessErrorEvent = 'uncaughtException' | 'unhandledRejection';

type ProcessLike = {
  on(event: ProcessErrorEvent, listener: (...args: unknown[]) => void): unknown;
  off(event: ProcessErrorEvent, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): never | void;
};

type InstallProcessErrorHandlersOptions = {
  logger: Logger;
  processLike?: ProcessLike;
};

/**
 * Node's default behavior for these events is an immediate crash without a
 * structured log line. These handlers keep the crash-and-restart semantics
 * (the process supervisor restarts us) but make sure the reason is logged
 * through the app logger first, and that overlapping events exit only once.
 */
export function installProcessErrorHandlers({
  logger,
  processLike = process,
}: InstallProcessErrorHandlersOptions): { uninstall(): void } {
  let exiting = false;

  const exitOnce = () => {
    if (exiting) {
      return;
    }
    exiting = true;
    processLike.exit(1);
  };

  const onUncaughtException = (error: unknown) => {
    logger.error('Uncaught exception; exiting', error);
    exitOnce();
  };

  const onUnhandledRejection = (reason: unknown) => {
    logger.error('Unhandled promise rejection; exiting', reason);
    exitOnce();
  };

  processLike.on('uncaughtException', onUncaughtException);
  processLike.on('unhandledRejection', onUnhandledRejection);

  return {
    uninstall() {
      processLike.off('uncaughtException', onUncaughtException);
      processLike.off('unhandledRejection', onUnhandledRejection);
    },
  };
}
