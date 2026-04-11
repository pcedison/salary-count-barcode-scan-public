import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('loadEnvironment', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV
    };
  });

  afterEach(() => {
    process.env = {
      ...ORIGINAL_ENV
    };
    vi.restoreAllMocks();
  });

  it('refuses to load workspace .env in production without an explicit override', async () => {
    vi.doMock('fs', () => ({
      default: {
        existsSync: vi.fn(() => true)
      }
    }));

    vi.doMock('dotenv', () => ({
      default: {
        config: vi.fn()
      }
    }));

    process.env.NODE_ENV = 'production';

    const { loadEnvironment, resetEnvironmentLoadStateForTest } = await import('./loadEnv');
    resetEnvironmentLoadStateForTest();

    expect(() => loadEnvironment()).toThrow(
      'Refusing to load workspace .env in production. Configure platform secrets instead, or set ALLOW_DOTENV_IN_PRODUCTION=true for an emergency override.'
    );
  });

  it('loads .env in development when the file is present', async () => {
    const configMock = vi.fn(() => ({ parsed: { SESSION_SECRET: 'dev-secret' } }));

    vi.doMock('fs', () => ({
      default: {
        existsSync: vi.fn(() => true)
      }
    }));

    vi.doMock('dotenv', () => ({
      default: {
        config: configMock
      }
    }));

    process.env.NODE_ENV = 'development';

    const { loadEnvironment, resetEnvironmentLoadStateForTest } = await import('./loadEnv');
    resetEnvironmentLoadStateForTest();

    const state = loadEnvironment();

    expect(state.source).toBe('dotenv');
    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).toHaveBeenCalledWith(
      expect.objectContaining({
        quiet: true
      })
    );
  });
});
