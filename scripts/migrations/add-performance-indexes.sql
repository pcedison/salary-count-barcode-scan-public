-- =============================================================================
-- Performance Indexes Migration
-- =============================================================================
-- Run these statements in the Supabase SQL editor or via psql.
-- These indexes correspond to the Drizzle schema definitions in shared/schema.ts.
-- All statements use IF NOT EXISTS so they are safe to re-run.
-- =============================================================================

-- temporary_attendance: fast lookups by employee_id (used in salary calculation)
CREATE INDEX IF NOT EXISTS ta_employee_id_idx
  ON temporary_attendance (employee_id);

-- temporary_attendance: fast lookups by date (used in attendance queries)
CREATE INDEX IF NOT EXISTS ta_date_idx
  ON temporary_attendance (date);

-- holidays: fast lookups by employee_id
CREATE INDEX IF NOT EXISTS holidays_employee_id_idx
  ON holidays (employee_id);

-- pending_bindings: fast lookups by line_user_id (used in LINE OAuth flow)
CREATE INDEX IF NOT EXISTS pb_line_user_id_idx
  ON pending_bindings (line_user_id);

-- salary_records: composite index for year/month/employee lookups
CREATE INDEX IF NOT EXISTS sr_year_month_employee_idx
  ON salary_records (salary_year, salary_month, employee_id);

-- employees: fast lookups by id_number (used in barcode scan / identity lookup).
-- NOTE: id_number already has a UNIQUE constraint in Supabase (from the Drizzle schema).
-- A unique constraint implicitly creates a btree index, so a separate index is not needed.
-- The statement below is included for documentation purposes only; it will be a no-op
-- if the unique constraint index already exists under a different name.
-- CREATE INDEX IF NOT EXISTS employees_id_number_idx
--   ON employees (id_number);

-- =============================================================================
-- OPTIONAL UNIQUE CONSTRAINT (do NOT apply without checking for duplicates first)
-- =============================================================================
-- The following statement enforces one salary record per employee per month.
-- WARNING: This will FAIL if duplicate (salary_year, salary_month, employee_id)
-- rows already exist in the table.
--
-- Run this diagnostic query first to check for duplicates:
--
--   SELECT salary_year, salary_month, employee_id, COUNT(*) AS cnt
--   FROM salary_records
--   WHERE employee_id IS NOT NULL
--   GROUP BY salary_year, salary_month, employee_id
--   HAVING COUNT(*) > 1;
--
-- Only apply the unique index below if the query above returns zero rows.
--
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_records_year_month_employee
--   ON salary_records (salary_year, salary_month, employee_id)
--   WHERE employee_id IS NOT NULL;
-- =============================================================================
