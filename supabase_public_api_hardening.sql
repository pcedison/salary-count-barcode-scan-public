-- Supabase Data API hardening for this project.
-- The runtime uses a server-side PostgreSQL connection, so public API roles do not need
-- direct access to application tables in the public schema.
-- This script enables RLS on every public app table currently flagged by Supabase linter
-- and revokes table privileges from the anon/authenticated roles.

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
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
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;
