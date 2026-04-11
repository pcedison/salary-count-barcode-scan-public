import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalNodeEnv = process.env.NODE_ENV;
const originalLogLevel = process.env.LOG_LEVEL;

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.LOG_LEVEL = originalLogLevel;
    vi.restoreAllMocks();
  });

  it('routes production warnings to console.warn and suppresses lower levels', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'warn';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createLogger } = await import('./logger');
    const logger = createLogger('test');

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error(new Error('boom'));

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('"level":"warn"');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('boom');
  });

  it('renders development logs with a readable context prefix', async () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'debug';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { createLogger } = await import('./logger');
    const logger = createLogger('dev');

    logger.info('hello', { ok: true });

    expect(logSpy).toHaveBeenCalledWith('[dev]', 'hello', { ok: true });
  });

  it('falls back to safe serialization when console inspection fails', async () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'error';

    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (args.some((arg) => typeof arg === 'object' && arg !== null)) {
        throw new Error('inspect failed');
      }
    });

    const { createLogger } = await import('./logger');
    const logger = createLogger('fallback');

    logger.error('boom', { issue: 'zod' });

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[fallback]');
    expect(errorSpy.mock.calls[1]?.[0]).toBe('[fallback]');
    expect(errorSpy.mock.calls[1]?.[1]).toBe('boom');
    expect(errorSpy.mock.calls[1]?.[2]).toContain('"issue":"zod"');
  });
});
