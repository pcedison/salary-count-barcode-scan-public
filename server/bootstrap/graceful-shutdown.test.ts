import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

function createProcessLike() {
  const emitter = new EventEmitter();
  const processLike = {
    once: vi.fn((signal: NodeJS.Signals, handler: NodeJS.SignalsListener) => {
      emitter.once(signal, handler);
      return processLike;
    }),
    off: vi.fn((signal: NodeJS.Signals, handler: NodeJS.SignalsListener) => {
      emitter.off(signal, handler);
      return processLike;
    }),
    exit: vi.fn(),
    emitSignal(signal: NodeJS.Signals) {
      emitter.emit(signal, signal);
    },
  };

  return processLike;
}

describe('installGracefulShutdown', () => {
  it('stops runtime services and exits cleanly when the platform sends SIGTERM', async () => {
    const { installGracefulShutdown } = await import('./graceful-shutdown');
    const close = vi.fn((callback?: (error?: Error) => void) => {
      callback?.();
      return undefined as never;
    });
    const server = { close };
    const runtimeServices = { stop: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processLike = createProcessLike();

    installGracefulShutdown({
      server,
      runtimeServices,
      logger,
      processLike,
      shutdownTimeoutMs: 100,
    });

    processLike.emitSignal('SIGTERM');

    expect(runtimeServices.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(processLike.exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith('Received SIGTERM; shutting down gracefully');
  });

  it('ignores repeated shutdown signals once shutdown has started', async () => {
    const { installGracefulShutdown } = await import('./graceful-shutdown');
    const close = vi.fn((callback?: (error?: Error) => void) => {
      callback?.();
      return undefined as never;
    });
    const server = { close };
    const runtimeServices = { stop: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processLike = createProcessLike();

    installGracefulShutdown({
      server,
      runtimeServices,
      logger,
      processLike,
      shutdownTimeoutMs: 100,
    });

    processLike.emitSignal('SIGTERM');
    processLike.emitSignal('SIGINT');

    expect(runtimeServices.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(processLike.exit).toHaveBeenCalledTimes(1);
  });
});
