-- Review and apply explicitly before releasing the correction workflow.
-- No payroll amounts, holiday rows, payment flags or retention settings change.
BEGIN;
ALTER TABLE public.salary_records ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.salary_records ADD COLUMN IF NOT EXISTS holiday_calculation_base_salary double precision;
CREATE TABLE IF NOT EXISTS public.salary_corrections (
  id serial PRIMARY KEY,
  salary_record_id integer REFERENCES public.salary_records(id) ON DELETE SET NULL,
  original_record_id integer NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  idempotency_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  preview_token_hash varchar(64) NOT NULL,
  actor_id varchar(64) NOT NULL,
  actor_role text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  payment_handling text NOT NULL CHECK (payment_handling IN ('unpaid','paid_adjustment','unknown_adjustment')),
  holidays json NOT NULL,
  delta json NOT NULL,
  before_snapshot json NOT NULL,
  after_snapshot json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salary_corrections_record_revision_unique UNIQUE (original_record_id, revision),
  CONSTRAINT salary_corrections_record_key_unique UNIQUE (original_record_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS sr_history_order_idx ON public.salary_records (salary_year, salary_month, id);
CREATE INDEX IF NOT EXISTS sr_employee_history_idx ON public.salary_records (employee_id, salary_year, salary_month, id);
CREATE INDEX IF NOT EXISTS salary_corrections_record_link_idx ON public.salary_corrections (salary_record_id);
-- Journal access stays on the authenticated server connection. Never expose it
-- via Supabase's public API; this does not alter existing payroll table policies.
ALTER TABLE public.salary_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_corrections FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.salary_corrections_id_seq FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE public.salary_corrections FROM anon;
    REVOKE ALL ON SEQUENCE public.salary_corrections_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE public.salary_corrections FROM authenticated;
    REVOKE ALL ON SEQUENCE public.salary_corrections_id_seq FROM authenticated;
  END IF;
END $$;
COMMIT;
