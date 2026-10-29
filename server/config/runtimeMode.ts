export function isCloudRunMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APP_DEPLOYMENT_MODE === 'cloudrun';
}

export function areBackgroundServicesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.APP_BACKGROUND_SERVICES === 'disabled') return false;
  if (isCloudRunMode(env)) return false; // No cross-revision worker ownership yet.
  return env.APP_BACKGROUND_SERVICES !== 'disabled';
}

export function usesStdoutAudit(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APP_AUDIT_SINK === 'stdout';
}
