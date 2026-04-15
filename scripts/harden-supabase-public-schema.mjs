import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const TABLES = [
  "users",
  "employees",
  "temporary_attendance",
  "settings",
  "salary_records",
  "holidays",
  "pending_bindings",
  "oauth_states",
  "calculation_rules",
  "taiwan_holidays",
  "user_sessions",
];

function getMode(argv) {
  if (argv.includes("--apply")) return "apply";
  return "check";
}

function quoteIdent(identifier) {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

async function fetchStatus(client) {
  const rlsResult = await client.query(
    `
      select
        c.relname as table_name,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = 'public'
        and c.relname = any($1::text[])
      order by c.relname
    `,
    [TABLES],
  );

  const grantsResult = await client.query(
    `
      select
        table_name,
        grantee,
        string_agg(privilege_type, ', ' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated')
        and table_name = any($1::text[])
      group by table_name, grantee
      order by table_name, grantee
    `,
    [TABLES],
  );

  const policiesResult = await client.query(
    `
      select
        tablename as table_name,
        policyname,
        roles,
        cmd,
        qual,
        with_check
      from pg_policies
      where schemaname = 'public'
        and tablename = any($1::text[])
      order by tablename, policyname
    `,
    [TABLES],
  );

  return {
    tables: rlsResult.rows,
    grants: grantsResult.rows,
    policies: policiesResult.rows,
  };
}

async function fetchExistingTables(client) {
  const result = await client.query(
    `
      select
        c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = 'public'
        and c.relname = any($1::text[])
      order by c.relname
    `,
    [TABLES],
  );

  return new Set(result.rows.map((row) => row.table_name));
}

async function applyHardening(client) {
  await client.query("begin");

  try {
    const existingTables = await fetchExistingTables(client);

    for (const tableName of TABLES) {
      if (!existingTables.has(tableName)) {
        continue;
      }

      const qualified = `public.${quoteIdent(tableName)}`;
      await client.query(`alter table ${qualified} enable row level security`);
      await client.query(
        `revoke all privileges on table ${qualified} from anon, authenticated`,
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const mode = getMode(process.argv.slice(2));
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    if (mode === "apply") {
      await applyHardening(client);
    }

    const status = await fetchStatus(client);
    console.log(JSON.stringify({ mode, ...status }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
