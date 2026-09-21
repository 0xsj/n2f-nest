ALTER TABLE public.signals_document_documents
  ADD COLUMN processing_failure_code text;

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.signals_document_documents'::regclass
       AND contype = 'c'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.signals_document_documents DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END
$$;

ALTER TABLE public.signals_document_documents
  ADD CONSTRAINT signals_document_documents_name_check
    CHECK (char_length(name)>0 AND char_length(name)<=200),
  ADD CONSTRAINT signals_document_documents_storage_key_check
    CHECK (storage_key IS NULL OR (char_length(storage_key)>0 AND char_length(storage_key)<=512)),
  ADD CONSTRAINT signals_document_documents_status_check
    CHECK (status IN ('active','processing','processed','processing_failed','archived')),
  ADD CONSTRAINT signals_document_documents_processing_failure_code_check
    CHECK (processing_failure_code IS NULL OR processing_failure_code ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  ADD CONSTRAINT signals_document_documents_updated_at_check
    CHECK (updated_at>=created_at),
  ADD CONSTRAINT signals_document_documents_processing_state_check
    CHECK (
      (status IN ('active','processing','processed') AND archived_at IS NULL AND processing_failure_code IS NULL) OR
      (status='processing_failed' AND archived_at IS NULL AND processing_failure_code IS NOT NULL) OR
      (status='archived' AND archived_at IS NOT NULL)
    );
