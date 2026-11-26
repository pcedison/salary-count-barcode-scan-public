-- Explicit migration only: apply once, before deploying the pre-payroll review (月結前檢查).
-- Additive: creates one new table, touches no existing data. No runtime DDL.
CREATE TABLE IF NOT EXISTS public.payroll_reviews (
  id serial PRIMARY KEY,
  salary_year integer NOT NULL,
  salary_month integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  findings json NOT NULL DEFAULT '[]'::json,
  email_text text,
  notified_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT payroll_reviews_year_month_uniq UNIQUE (salary_year, salary_month)
);
COMMENT ON TABLE public.payroll_reviews IS 'barcode-scan:payroll-reviews:v1';
ALTER TABLE public.payroll_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_reviews FROM PUBLIC;
DO $harden$
DECLARE browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
      EXECUTE format('REVOKE ALL ON public.payroll_reviews FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.payroll_reviews_id_seq FROM %I', browser_role);
    END IF;
  END LOOP;
END $harden$;
