import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export type EnvironmentLoadState = {
  source: 'dotenv' | 'process' | 'test';
  envPath: string;
  dotenvPresent: boolean;
  allowDotenvInProduction: boolean;
};

let cachedLoadState: EnvironmentLoadState | null = null;

function buildLoadState(): EnvironmentLoadState {
  const envPath = path.resolve(process.cwd(), '.env');
  const dotenvPresent = fs.existsSync(envPath);

  return {
    source: 'process',
    envPath,
    dotenvPresent,
    allowDotenvInProduction: process.env.ALLOW_DOTENV_IN_PRODUCTION === 'true'
  };
}

export function getEnvironmentLoadState(): EnvironmentLoadState {
  return cachedLoadState ?? buildLoadState();
}

export function resetEnvironmentLoadStateForTest(): void {
  cachedLoadState = null;
}

export function loadEnvironment(): EnvironmentLoadState {
  if (cachedLoadState) {
    return cachedLoadState;
  }

  const state = buildLoadState();
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isTestMode = nodeEnv === 'test';

  if (isTestMode) {
    cachedLoadState = {
      ...state,
      source: 'test'
    };
    return cachedLoadState;
  }

  if (nodeEnv === 'production' && state.dotenvPresent && !state.allowDotenvInProduction) {
    throw new Error(
      'Refusing to load workspace .env in production. Configure platform secrets instead, or set ALLOW_DOTENV_IN_PRODUCTION=true for an emergency override.'
    );
  }

  if (state.dotenvPresent) {
    const result = dotenv.config({
      path: state.envPath,
      quiet: true
    });

    if (result.error) {
      throw result.error;
    }

    cachedLoadState = {
      ...state,
      source: 'dotenv'
    };
    return cachedLoadState;
  }

  cachedLoadState = state;
  return cachedLoadState;
}
