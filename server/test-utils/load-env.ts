import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function isLocalDatabase(url?: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

if (
  !process.env.PGSSLREJECT_UNAUTHORIZED &&
  process.env.DATABASE_URL &&
  !isLocalDatabase(process.env.DATABASE_URL)
) {
  // Local restore/test scripts should match the hosted pooler compatibility
  // mode we already use in real-db tests unless the operator overrides it.
  process.env.PGSSLREJECT_UNAUTHORIZED = 'false';
}
