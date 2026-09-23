-- Baseline schema. Document: documents and their processing run.
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

CREATE TABLE public.n2f_document_documents (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    storage_key text,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    processing_failure_code text,
    version integer DEFAULT 1 NOT NULL,
    processing_run uuid,
    processing_attempt integer DEFAULT 0 NOT NULL,
    CONSTRAINT n2f_document_documents_name_check CHECK (((char_length(name) > 0) AND (char_length(name) <= 200))),
    CONSTRAINT n2f_document_documents_processing_attempt_check CHECK ((processing_attempt >= 0)),
    CONSTRAINT n2f_document_documents_processing_failure_code_check CHECK (((processing_failure_code IS NULL) OR (processing_failure_code ~ '^[a-z][a-z0-9_.-]{0,127}$'::text))),
    CONSTRAINT n2f_document_documents_processing_state_check CHECK ((((status = ANY (ARRAY['active'::text, 'processing'::text, 'processed'::text])) AND (archived_at IS NULL) AND (processing_failure_code IS NULL)) OR ((status = 'processing_failed'::text) AND (archived_at IS NULL) AND (processing_failure_code IS NOT NULL)) OR ((status = 'archived'::text) AND (archived_at IS NOT NULL)))),
    CONSTRAINT n2f_document_documents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'processing'::text, 'processed'::text, 'processing_failed'::text, 'archived'::text]))),
    CONSTRAINT n2f_document_documents_storage_key_check CHECK (((storage_key IS NULL) OR ((char_length(storage_key) > 0) AND (char_length(storage_key) <= 512)))),
    CONSTRAINT n2f_document_documents_updated_at_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_document_documents_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY public.n2f_document_documents
    ADD CONSTRAINT n2f_document_documents_pkey PRIMARY KEY (id);

CREATE INDEX n2f_document_documents_organization ON public.n2f_document_documents USING btree (organization_id, created_at, id);
