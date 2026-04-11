import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const EMPLOYEE_COLUMNS = [
  "deleted_at",
  "deleted_by",
  "purge_after_at",
  "employee_type",
];

const SALARY_COLUMNS = [
  "anonymized_at",
  "retention_until",
  "employee_snapshot",
];

const INDEXES = [
  "idx_employees_deleted_at",
  "idx_employees_purge_after_at",
  "idx_salary_records_retention_until",
];

function getMode(argv) {
  if (argv.includes("--apply")) return "apply";
  return "check";
}

async function fetchStatus(client) {
  const columnsResult = await client.query(
    `
      select
        table_name,
        column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'employees' and column_name = any($1::text[]))
          or
          (table_name = 'salary_records' and column_name = any($2::text[]))
        )
      order by table_name, column_name
    `,
    [EMPLOYEE_COLUMNS, SALARY_COLUMNS],
  );

  const indexesResult = await client.query(
    `
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname = any($1::text[])
      order by indexname
    `,
    [INDEXES],
  );

  return {
    columns: columnsResult.rows,
    indexes: indexesResult.rows,
  };
}

async function applySchema(client) {
  await client.query("begin");

  try {
    await client.query(`
      alter table if exists public.employees
        add column if not exists deleted_at timestamptz,
        add column if not exists deleted_by text,
        add column if not exists purge_after_at timestamptz,
        add column if not exists employee_type text default 'local'
    `);

    await client.query(`
      create index if not exists idx_employees_deleted_at
      on public.employees (deleted_at)
    `);

    await client.query(`
      create index if not exists idx_employees_purge_after_at
      on public.employees (purge_after_at)
    `);

    await client.query(`
      alter table if exists public.salary_records
        add column if not exists anonymized_at timestamptz,
        add column if not exists retention_until timestamptz,
        add column if not exists employee_snapshot jsonb
    `);

    await client.query(`
      create index if not exists idx_salary_records_retention_until
      on public.salary_records (retention_until)
    `);

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
      await applySchema(client);
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
