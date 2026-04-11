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
  return postgres(databaseUrl, {
    ssl: { rejectUnauthorized: false },
    ...(shouldDisablePreparedStatements(databaseUrl) ? { prepare: false } : {})
  });
}
