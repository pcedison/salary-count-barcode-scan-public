const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function describeDatabaseTarget(databaseUrl) {
  try {
    const parsedUrl = new URL(databaseUrl);
    const host = parsedUrl.hostname || null;
    const database = parsedUrl.pathname.replace(/^\/+/, '') || null;

    return {
      host,
      database,
      isRemote: Boolean(host) && !LOCAL_DATABASE_HOSTS.has(host)
    };
  } catch {
    return {
      host: null,
      database: null,
      isRemote: false
    };
  }
}

export function resolveAesMigrationOperator(cliOperator, envOperator = process.env.AES_MIGRATION_OPERATOR) {
  const normalizedCliOperator = `${cliOperator ?? ''}`.trim();
  if (normalizedCliOperator.length > 0) {
    return normalizedCliOperator;
  }

  const normalizedEnvOperator = `${envOperator ?? ''}`.trim();
  return normalizedEnvOperator.length > 0 ? normalizedEnvOperator : null;
}

export function validateAesMutationRequest(options) {
  const {
    mode,
    databaseUrl,
    allowRemote = false,
    operator = null,
    useAesEncryption = false,
    encryptionSaltConfigured = false
  } = options;

  const target = describeDatabaseTarget(databaseUrl);

  if (mode !== 'execute' && mode !== 'rollback') {
    return { target, operator };
  }

  if (target.isRemote && !allowRemote) {
    throw new Error(
      `Refusing to ${mode} against remote database ${target.host}/${target.database ?? 'unknown'}. Re-run with --allow-remote after confirming the operator window.`
    );
  }

  if (mode === 'execute') {
    if (!useAesEncryption) {
      throw new Error('USE_AES_ENCRYPTION=true must be set before --execute so new writes stay on the AES path.');
    }

    if (!encryptionSaltConfigured) {
      throw new Error('ENCRYPTION_SALT must be explicitly set before --execute.');
    }

    if (!operator) {
      throw new Error(
        'Operator identity is required. Re-run with --operator <name> or AES_MIGRATION_OPERATOR=... before --execute.'
      );
    }
  }

  return { target, operator };
}
