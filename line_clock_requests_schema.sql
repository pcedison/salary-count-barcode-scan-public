-- Explicit migration only: run scripts/apply-line-clock-requests-schema.mjs.
-- Apply before deploying the matching LINE client/API. No runtime DDL.
CREATE TABLE public.line_clock_requests (
  event_id uuid PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  line_user_hash text NOT NULL,
  payload_hash text NOT NULL,
  date_key text NOT NULL,
  state_version text NOT NULL,
  receipt json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX line_clock_requests_employee_date_idx ON public.line_clock_requests(employee_id, date_key);
COMMENT ON TABLE public.line_clock_requests IS 'barcode-scan:line-clock-requests:v1';
ALTER TABLE public.line_clock_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.line_clock_requests FROM PUBLIC;
DO $harden$
DECLARE browser_role text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
      EXECUTE format('REVOKE ALL ON public.line_clock_requests FROM %I', browser_role);
    END IF;
  END LOOP;
END $harden$;
