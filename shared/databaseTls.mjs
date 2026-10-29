// A pg connection string can override an explicit ssl object. Reject that
// ambiguity before connecting; never include the URL or credentials in errors.
export function assertExternalDatabaseTlsUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL connection URL');
  // pg accepts query host/port/user overrides. Check these before trusting the
  // authority hostname for the loopback-only testing exception.
  for (const key of url.searchParams.keys()) {
    if (['host', 'hostaddr', 'port', 'user', 'password', 'database', 'dbname', 'connectionstring'].includes(key.toLowerCase())) {
      throw new Error('PostgreSQL URL must not override the connection target or credentials through query parameters');
    }
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.replace(/^\[|\]$/g, ''))) return;
  for (const [rawKey, setting] of url.searchParams) {
    const key = rawKey.toLowerCase();
    if (key === 'sslmode' && setting === 'verify-full') continue;
    if (key.startsWith('ssl') || key === 'uselibpqcompat') {
      throw new Error('External PostgreSQL URL must not override TLS certificate validation; use sslmode=verify-full or omit TLS query options');
    }
  }
}
