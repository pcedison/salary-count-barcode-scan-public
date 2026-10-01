import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as query } from 'drizzle-orm';

export class AuthInvalidationGuardError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuthInvalidationGuardError';
  }
}

/** Validate before importing the application's database module or connecting. */
export function validateAuthInvalidationCommand(
  argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
): void {
  if (argv.length !== 1 || argv[0] !== '--confirm') {
    throw new AuthInvalidationGuardError('AUTH_INVALIDATION_CONFIRMATION_REQUIRED');
  }
  if (env.PAYROLL_WRITES_PAUSED?.trim().toLowerCase() !== 'true') {
    throw new AuthInvalidationGuardError('AUTH_INVALIDATION_MAINTENANCE_REQUIRED');
  }
  if (!env.DATABASE_URL?.trim()) {
    throw new AuthInvalidationGuardError('AUTH_INVALIDATION_DATABASE_REQUIRED');
  }
  try {
    const target = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.username ||
      !target.hostname || target.pathname.length < 2) throw new Error('Invalid target');
  } catch {
    throw new AuthInvalidationGuardError('AUTH_INVALIDATION_INVALID_TARGET');
  }
}

/** After an external full PostgreSQL restore, invalidate restored admin authority. */
export async function runAuthInvalidationCommand(argv = process.argv.slice(2)) {
  validateAuthInvalidationCommand(argv);
  // Deliberately no dotenv loader, implicit fallback URL or integration bootstrap.
  const [{ db, sql }, { invalidateRestoredAdminSessions }] = await Promise.all([
    import('../db'), import('../db-monitoring'),
  ]);
  try {
    return await db.transaction(async tx => {
      const [table] = await tx.execute<{ relation: string | null }>(query`
        SELECT to_regclass('public.user_sessions') AS relation`);
      if (!table.relation) throw new Error('Administrator session storage is unavailable.');
      await tx.execute(query.raw('LOCK TABLE public.user_sessions IN SHARE ROW EXCLUSIVE MODE'));
      const [sessions] = await tx.execute<{ count: number }>(query`
        SELECT count(*)::int AS count FROM public.user_sessions WHERE sess::jsonb ? 'adminAuth'`);
      await invalidateRestoredAdminSessions(tx);
      return { adminSessionsInvalidated: Number(sessions.count), epochAdvanced: true };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAuthInvalidationCommand().then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    // Database errors can include credentials or session content. Print neither.
    console.error(error instanceof AuthInvalidationGuardError ? error.code : 'AUTH_INVALIDATION_FAILED');
    process.exitCode = 1;
  });
}
