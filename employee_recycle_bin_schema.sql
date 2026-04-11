begin;

alter table if exists public.employees
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists purge_after_at timestamptz;

create index if not exists idx_employees_deleted_at on public.employees (deleted_at);
create index if not exists idx_employees_purge_after_at on public.employees (purge_after_at);

alter table if exists public.salary_records
  add column if not exists anonymized_at timestamptz,
  add column if not exists retention_until timestamptz,
  add column if not exists employee_snapshot jsonb;

create index if not exists idx_salary_records_retention_until on public.salary_records (retention_until);

commit;
