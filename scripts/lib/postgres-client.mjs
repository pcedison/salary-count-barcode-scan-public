import postgres from 'postgres';

export function shouldDisablePreparedStatements(databaseUrl) {
  try {
    const parsedUrl = new URL(databaseUrl);

    return (
      parsedUrl.hostname.endsWith('.pooler.supabase.com') &&
      parsedUrl.port === '6543'
    );
  } catch {
    return false;
  }
}

export function createPostgresClient(databaseUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || /[,%]/.test(parsedUrl.hostname)) throw new Error();
  } catch {
    throw new Error('Invalid PostgreSQL connection configuration.');
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const allowUnverified = process.env.PGSSLREJECT_UNAUTHORIZED?.trim().toLowerCase() === 'false';
  if (!isLoopback && allowUnverified && !hostname.endsWith('.pooler.supabase.com')) {
    throw new Error('Certificate validation bypass is only allowed for a known Supabase pooler.');
  }
  if (!isLoopback && allowUnverified) {
    console.warn('PostgreSQL certificate validation is disabled by explicit configuration for a known Supabase pooler.');
  }

  return postgres(databaseUrl, {
    // Bind the driver's destination to the single hostname checked above.
    host: [hostname],
    port: [Number(parsedUrl.port || process.env.PGPORT || 5432)],
    ssl: isLoopback ? false : { rejectUnauthorized: !allowUnverified },
    ...(shouldDisablePreparedStatements(databaseUrl) ? { prepare: false } : {})
  });
}
