-- Run after the draft namespace migration against a populated database clone.
-- This is verification-only and is not part of the application migrations.

DO $$
DECLARE
  table_name text;
  expected_tables constant text[] := ARRAY[
    'n2f_outbox',
    'n2f_mailbox',
    'n2f_mailbox_receipts',
    'n2f_identity_identities',
    'n2f_identity_credentials',
    'n2f_identity_verification_challenges',
    'n2f_identity_sessions',
    'n2f_audit_entries',
    'n2f_organization_organizations',
    'n2f_organization_memberships',
    'n2f_organization_invitations',
    'n2f_document_documents',
    'n2f_jobs_jobs'
  ];
  legacy_tables constant text[] := ARRAY[
    'signals_outbox',
    'signals_mailbox',
    'signals_mailbox_receipts',
    'signals_identity_identities',
    'signals_identity_credentials',
    'signals_identity_verification_challenges',
    'signals_identity_sessions',
    'signals_audit_entries',
    'signals_organization_organizations',
    'signals_organization_memberships',
    'signals_organization_invitations',
    'signals_document_documents',
    'signals_jobs_jobs'
  ];
BEGIN
  FOREACH table_name IN ARRAY expected_tables LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'namespace verification missing table public.%', table_name;
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY legacy_tables LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      RAISE EXCEPTION 'namespace verification found legacy table public.%', table_name;
    END IF;
  END LOOP;

  -- The ledger is intentionally still legacy during the first cutover.
  IF to_regclass('public.signals_migrations') IS NULL THEN
    RAISE EXCEPTION 'namespace verification expected the compatibility ledger';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename LIKE 'n2f_%'
      AND indexname LIKE 'signals_%'
  ) THEN
    RAISE EXCEPTION 'namespace verification found legacy index names';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class table_row
      ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname LIKE 'n2f_%'
      AND constraint_row.conname LIKE 'signals_%'
  ) THEN
    RAISE EXCEPTION 'namespace verification found legacy constraint names';
  END IF;
END
$$;

SELECT table_name, row_count
FROM (
  SELECT 'n2f_audit_entries' AS table_name,
         (SELECT count(*) FROM public.n2f_audit_entries) AS row_count
  UNION ALL
  SELECT 'n2f_document_documents',
         (SELECT count(*) FROM public.n2f_document_documents)
  UNION ALL
  SELECT 'n2f_identity_identities',
         (SELECT count(*) FROM public.n2f_identity_identities)
  UNION ALL
  SELECT 'n2f_identity_credentials',
         (SELECT count(*) FROM public.n2f_identity_credentials)
  UNION ALL
  SELECT 'n2f_identity_verification_challenges',
         (SELECT count(*) FROM public.n2f_identity_verification_challenges)
  UNION ALL
  SELECT 'n2f_identity_sessions',
         (SELECT count(*) FROM public.n2f_identity_sessions)
  UNION ALL
  SELECT 'n2f_jobs_jobs',
         (SELECT count(*) FROM public.n2f_jobs_jobs)
  UNION ALL
  SELECT 'n2f_organization_organizations',
         (SELECT count(*) FROM public.n2f_organization_organizations)
  UNION ALL
  SELECT 'n2f_organization_memberships',
         (SELECT count(*) FROM public.n2f_organization_memberships)
  UNION ALL
  SELECT 'n2f_organization_invitations',
         (SELECT count(*) FROM public.n2f_organization_invitations)
  UNION ALL
  SELECT 'n2f_outbox',
         (SELECT count(*) FROM public.n2f_outbox)
  UNION ALL
  SELECT 'n2f_mailbox',
         (SELECT count(*) FROM public.n2f_mailbox)
  UNION ALL
  SELECT 'n2f_mailbox_receipts',
         (SELECT count(*) FROM public.n2f_mailbox_receipts)
) counts
ORDER BY table_name;
