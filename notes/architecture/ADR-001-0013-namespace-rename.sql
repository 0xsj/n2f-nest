-- DRAFT ONLY — do not add this file to appMigrations yet.
--
-- This migration is intentionally kept beside ADR-001 until the populated
-- database dry run and NATS cutover are approved. It preserves rows and the
-- signals_migrations ledger, but it changes persisted PostgreSQL object names.

DO $$
DECLARE
  table_name text;
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
  FOREACH table_name IN ARRAY legacy_tables LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'namespace migration expected table public.%', table_name;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE public.signals_outbox RENAME TO n2f_outbox;
ALTER TABLE public.signals_mailbox RENAME TO n2f_mailbox;
ALTER TABLE public.signals_mailbox_receipts RENAME TO n2f_mailbox_receipts;
ALTER TABLE public.signals_identity_identities RENAME TO n2f_identity_identities;
ALTER TABLE public.signals_identity_credentials RENAME TO n2f_identity_credentials;
ALTER TABLE public.signals_identity_verification_challenges
  RENAME TO n2f_identity_verification_challenges;
ALTER TABLE public.signals_identity_sessions RENAME TO n2f_identity_sessions;
ALTER TABLE public.signals_audit_entries RENAME TO n2f_audit_entries;
ALTER TABLE public.signals_organization_organizations
  RENAME TO n2f_organization_organizations;
ALTER TABLE public.signals_organization_memberships
  RENAME TO n2f_organization_memberships;
ALTER TABLE public.signals_organization_invitations
  RENAME TO n2f_organization_invitations;
ALTER TABLE public.signals_document_documents
  RENAME TO n2f_document_documents;
ALTER TABLE public.signals_jobs_jobs RENAME TO n2f_jobs_jobs;

DO $$
DECLARE
  item record;
BEGIN
  -- Index names are not automatically made generic by a table rename.
  FOR item IN
    SELECT index_class.relname AS old_name,
           regexp_replace(index_class.relname, '^signals_', 'n2f_') AS new_name
      FROM pg_class index_class
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_class.relnamespace
      JOIN pg_index index_definition
        ON index_definition.indexrelid = index_class.oid
      JOIN pg_class table_class
        ON table_class.oid = index_definition.indrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_class.relnamespace
     WHERE index_namespace.nspname = 'public'
       AND table_namespace.nspname = 'public'
       AND index_class.relkind = 'i'
       AND index_class.relname LIKE 'signals_%'
       AND table_class.relname LIKE 'n2f_%'
  LOOP
    EXECUTE format(
      'ALTER INDEX public.%I RENAME TO %I',
      item.old_name,
      item.new_name
    );
  END LOOP;
END
$$;

DO $$
DECLARE
  item record;
BEGIN
  -- Constraint names are separate catalog entries and need their own pass.
  FOR item IN
    SELECT table_class.relname AS table_name,
           constraint_row.conname AS old_name,
           regexp_replace(constraint_row.conname, '^signals_', 'n2f_') AS new_name
      FROM pg_constraint constraint_row
      JOIN pg_class table_class
        ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_class.relnamespace
     WHERE table_namespace.nspname = 'public'
       AND table_class.relname LIKE 'n2f_%'
       AND constraint_row.conname LIKE 'signals_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
      item.table_name,
      item.old_name,
      item.new_name
    );
  END LOOP;
END
$$;
