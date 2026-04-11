-- Supabase / PostgreSQL bootstrap schema for the current runtime.
-- Safe by default:
--   1. Non-destructive and idempotent: no DROP TABLE statements.
--   2. No legacy users/password bootstrap surface.
--   3. No seeded admin PIN or sample business data.
--   4. Keeps public-schema RLS hardening for Supabase Data API exposure.
--
-- Preferred production path remains:
--   npm run db:push
-- Use this SQL only when an operator explicitly needs SQL Editor bootstrap compatibility.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  id_number TEXT NOT NULL UNIQUE,
  is_encrypted BOOLEAN DEFAULT FALSE,
  position TEXT,
  department TEXT,
  email TEXT,
  phone TEXT,
  active BOOLEAN DEFAULT TRUE,
  employee_type TEXT DEFAULT 'local',
  line_user_id TEXT,
  line_display_name TEXT,
  line_picture_url TEXT,
  line_binding_date TIMESTAMPTZ,
  special_leave_days INTEGER DEFAULT 0,
  special_leave_work_date_range TEXT,
  special_leave_used_dates JSONB DEFAULT '[]'::jsonb,
  special_leave_cash_days INTEGER DEFAULT 0,
  special_leave_cash_month TEXT,
  special_leave_notes TEXT,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  purge_after_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS temporary_attendance (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER,
  date TEXT NOT NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT DEFAULT '',
  is_holiday BOOLEAN DEFAULT FALSE,
  is_barcode_scanned BOOLEAN DEFAULT FALSE,
  holiday_id INTEGER,
  holiday_type TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  base_hourly_rate DOUBLE PRECISION NOT NULL DEFAULT 119,
  ot1_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.34,
  ot2_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.67,
  base_month_salary DOUBLE PRECISION NOT NULL DEFAULT 28590,
  welfare_allowance DOUBLE PRECISION NOT NULL DEFAULT 0,
  deductions JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowances JSONB NOT NULL DEFAULT '[]'::jsonb,
  admin_pin TEXT NOT NULL,
  barcode_enabled BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS salary_records (
  id SERIAL PRIMARY KEY,
  salary_year INTEGER NOT NULL,
  salary_month INTEGER NOT NULL,
  employee_id INTEGER,
  employee_name TEXT,
  base_salary DOUBLE PRECISION NOT NULL,
  housing_allowance DOUBLE PRECISION DEFAULT 0,
  welfare_allowance DOUBLE PRECISION DEFAULT 0,
  total_ot1_hours DOUBLE PRECISION DEFAULT 0,
  total_ot2_hours DOUBLE PRECISION DEFAULT 0,
  total_overtime_pay DOUBLE PRECISION DEFAULT 0,
  holiday_days INTEGER DEFAULT 0,
  holiday_daily_salary DOUBLE PRECISION DEFAULT 0,
  total_holiday_pay DOUBLE PRECISION DEFAULT 0,
  gross_salary DOUBLE PRECISION NOT NULL,
  deductions JSONB DEFAULT '[]'::jsonb,
  allowances JSONB DEFAULT '[]'::jsonb,
  total_deductions DOUBLE PRECISION DEFAULT 0,
  net_salary DOUBLE PRECISION NOT NULL,
  attendance_data JSONB,
  special_leave_info JSONB,
  anonymized_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ,
  employee_snapshot JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id),
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  holiday_type TEXT NOT NULL DEFAULT 'national_holiday',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_bindings (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  line_user_id TEXT NOT NULL,
  line_display_name TEXT,
  line_picture_url TEXT,
  status TEXT NOT NULL,
  requested_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id SERIAL PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS calculation_rules (
  id SERIAL PRIMARY KEY,
  rule_key VARCHAR(50) NOT NULL UNIQUE,
  version VARCHAR(20) NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  employee_id INTEGER,
  total_ot1_hours DOUBLE PRECISION NOT NULL,
  total_ot2_hours DOUBLE PRECISION NOT NULL,
  base_salary DOUBLE PRECISION NOT NULL,
  welfare_allowance DOUBLE PRECISION,
  housing_allowance DOUBLE PRECISION,
  total_overtime_pay DOUBLE PRECISION NOT NULL,
  gross_salary DOUBLE PRECISION NOT NULL,
  net_salary DOUBLE PRECISION NOT NULL,
  description TEXT,
  created_by VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS taiwan_holidays (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  year INTEGER NOT NULL,
  holiday_date TEXT NOT NULL,
  holiday_name TEXT NOT NULL,
  is_holiday BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT taiwan_holidays_year_date_unique UNIQUE (year, holiday_date)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

-- Compatibility pass for partially created legacy tables.
DO $$
BEGIN
  IF to_regclass('public.employees') IS NOT NULL THEN
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN DEFAULT FALSE;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_type TEXT DEFAULT 'local';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_user_id TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_display_name TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_picture_url TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_binding_date TIMESTAMPTZ;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_leave_days INTEGER DEFAULT 0;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_leave_work_date_range TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_leave_used_dates JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_leave_cash_days INTEGER DEFAULT 0;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_leave_cash_month TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS special_leave_notes TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_by TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS purge_after_at TIMESTAMPTZ;
  END IF;

  IF to_regclass('public.temporary_attendance') IS NOT NULL THEN
    ALTER TABLE temporary_attendance ADD COLUMN IF NOT EXISTS employee_id INTEGER;
    ALTER TABLE temporary_attendance ADD COLUMN IF NOT EXISTS clock_out TEXT DEFAULT '';
    ALTER TABLE temporary_attendance ADD COLUMN IF NOT EXISTS is_holiday BOOLEAN DEFAULT FALSE;
    ALTER TABLE temporary_attendance ADD COLUMN IF NOT EXISTS is_barcode_scanned BOOLEAN DEFAULT FALSE;
    ALTER TABLE temporary_attendance ADD COLUMN IF NOT EXISTS holiday_id INTEGER;
    ALTER TABLE temporary_attendance ADD COLUMN IF NOT EXISTS holiday_type TEXT;
  END IF;

  IF to_regclass('public.settings') IS NOT NULL THEN
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS welfare_allowance DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS deductions JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS allowances JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS admin_pin TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS barcode_enabled BOOLEAN DEFAULT TRUE;
  END IF;

  IF to_regclass('public.salary_records') IS NOT NULL THEN
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS employee_id INTEGER;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS employee_name TEXT;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS allowances JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS attendance_data JSONB;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS special_leave_info JSONB;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;
    ALTER TABLE salary_records ADD COLUMN IF NOT EXISTS employee_snapshot JSONB;
  END IF;

  IF to_regclass('public.holidays') IS NOT NULL THEN
    ALTER TABLE holidays ADD COLUMN IF NOT EXISTS employee_id INTEGER;
    ALTER TABLE holidays ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE holidays ADD COLUMN IF NOT EXISTS holiday_type TEXT DEFAULT 'national_holiday';
    ALTER TABLE holidays ADD COLUMN IF NOT EXISTS description TEXT;
  END IF;
END
$$;

-- Indexes used by current runtime flows.
CREATE INDEX IF NOT EXISTS idx_employees_id_number ON employees(id_number);
CREATE INDEX IF NOT EXISTS idx_employees_line_user_id ON employees(line_user_id);
CREATE INDEX IF NOT EXISTS idx_employees_deleted_at ON employees(deleted_at);
CREATE INDEX IF NOT EXISTS idx_temp_attendance_employee_id ON temporary_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_temp_attendance_date ON temporary_attendance(date);
CREATE INDEX IF NOT EXISTS idx_temp_attendance_date_empid ON temporary_attendance(date, employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_records_year_month ON salary_records(salary_year, salary_month);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
CREATE INDEX IF NOT EXISTS idx_holidays_employee_id ON holidays(employee_id);
CREATE INDEX IF NOT EXISTS idx_pending_bindings_employee_id ON pending_bindings(employee_id);
CREATE INDEX IF NOT EXISTS idx_pending_bindings_line_user_id ON pending_bindings(line_user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);

COMMENT ON TABLE settings IS
  'No admin PIN is seeded here. Provide DEFAULT_ADMIN_PIN via env for first boot, or let the app generate a random bootstrap PIN.';

-- Remove known legacy permissive policies and harden public schema access.
DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'employees',
    'temporary_attendance',
    'settings',
    'salary_records',
    'holidays',
    'pending_bindings',
    'oauth_states',
    'calculation_rules',
    'taiwan_holidays',
    'user_sessions'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    FOREACH policy_name IN ARRAY ARRAY[
      '允許完全訪問',
      'allow all access',
      'Allow full access'
    ]
    LOOP
      IF EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = table_name
          AND policyname = policy_name
      ) THEN
        EXECUTE format('DROP POLICY %I ON public.%I', policy_name, table_name);
      END IF;
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated',
      table_name
    );
  END LOOP;
END
$$;

-- Operator note:
--   This script intentionally does not insert a settings row or seed an admin PIN.
--   On first application boot, either:
--     1. set DEFAULT_ADMIN_PIN to a strong operator-supplied 6-digit PIN, or
--     2. omit DEFAULT_ADMIN_PIN and let the server generate a random bootstrap PIN.
