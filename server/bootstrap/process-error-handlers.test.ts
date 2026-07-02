import { describe, expect, it, vi } from 'vitest';

import { installProcessErrorHandlers } from './process-error-handlers';

type Listener = (...args: unknown[]) => void;

function createProcessLike() {
  const listeners = new Map<string, Listener[]>();
  return {
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((item) => item !== listener)
      );
    }),
    exit: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

function createLogger() {
  return { error: vi.fn() };
}

describe('installProcessErrorHandlers', () => {
  it('logs and exits with code 1 on uncaughtException', () => {
    const processLike = createProcessLike();
    const logger = createLogger();

    installProcessErrorHandlers({ logger, processLike });
    processLike.emit('uncaughtException', new Error('boom'));

    expect(logger.error).toHaveBeenCalledWith('Uncaught exception; exiting', expect.any(Error));
    expect(processLike.exit).toHaveBeenCalledWith(1);
  });

  it('logs and exits with code 1 on unhandledRejection', () => {
    const processLike = createProcessLike();
    const logger = createLogger();

    installProcessErrorHandlers({ logger, processLike });
    processLike.emit('unhandledRejection', 'rejection-reason');

    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled promise rejection; exiting',
      'rejection-reason'
    );
    expect(processLike.exit).toHaveBeenCalledWith(1);
  });

  it('only exits once when both events fire', () => {
    const processLike = createProcessLike();
    const logger = createLogger();

    installProcessErrorHandlers({ logger, processLike });
    processLike.emit('uncaughtException', new Error('first'));
    processLike.emit('unhandledRejection', 'second');

    expect(processLike.exit).toHaveBeenCalledTimes(1);
  });

  it('uninstall removes both listeners', () => {
    const processLike = createProcessLike();
    const logger = createLogger();

    const { uninstall } = installProcessErrorHandlers({ logger, processLike });
    uninstall();

    expect(processLike.listenerCount('uncaughtException')).toBe(0);
    expect(processLike.listenerCount('unhandledRejection')).toBe(0);
  });
});
