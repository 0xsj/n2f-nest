-- The schema produced by the complete pre-baseline migration history (26
-- migrations recorded in signals_migrations), captured with pg_dump. Used by
-- test/migration-baseline.integration.spec.ts to prove that adopting such a
-- database onto the baselines leaves it identical to a fresh one.

CREATE TABLE public.n2f_audit_entries (
    id uuid NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    work_context jsonb NOT NULL,
    subject_kind text,
    subject_id uuid,
    tenant_id uuid,
    CONSTRAINT n2f_audit_entries_check CHECK (((subject_kind IS NULL) = (subject_id IS NULL))),
    CONSTRAINT n2f_audit_entries_event_type_check CHECK ((event_type ~ '^[a-z0-9_.-]{1,120}\.v[1-9][0-9]{0,5}$'::text)),
    CONSTRAINT n2f_audit_entries_work_context_check CHECK ((jsonb_typeof(work_context) = 'object'::text))
);

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

CREATE TABLE public.n2f_identity_credentials (
    id uuid NOT NULL,
    identity_id uuid NOT NULL,
    method text NOT NULL,
    email text NOT NULL,
    status text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT n2f_identity_credentials_method_check CHECK ((method = 'email_password'::text)),
    CONSTRAINT n2f_identity_credentials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

CREATE TABLE public.n2f_identity_identities (
    id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_identity_identities_status_check CHECK ((status = ANY (ARRAY['pending_verification'::text, 'active'::text, 'suspended'::text, 'disabled'::text]))),
    CONSTRAINT n2f_identity_identities_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_identity_sessions (
    id uuid NOT NULL,
    identity_id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    token_digest text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_identity_sessions_check CHECK ((expires_at > created_at)),
    CONSTRAINT n2f_identity_sessions_check1 CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT n2f_identity_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT n2f_identity_sessions_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_identity_verification_challenges (
    id uuid NOT NULL,
    identity_id uuid NOT NULL,
    purpose text NOT NULL,
    status text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    token_digest text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_identity_verification_challenges_check CHECK ((expires_at > issued_at)),
    CONSTRAINT n2f_identity_verification_challenges_check1 CHECK ((((status = 'issued'::text) AND (consumed_at IS NULL)) OR ((status = 'consumed'::text) AND (consumed_at IS NOT NULL)))),
    CONSTRAINT n2f_identity_verification_challenges_purpose_check CHECK ((purpose = 'email_verification'::text)),
    CONSTRAINT n2f_identity_verification_challenges_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'consumed'::text]))),
    CONSTRAINT n2f_identity_verification_challenges_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_jobs_jobs (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL,
    max_attempts integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    failure_code text,
    subject_type text,
    subject_id uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_jobs_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT n2f_jobs_jobs_check CHECK ((attempts <= max_attempts)),
    CONSTRAINT n2f_jobs_jobs_check1 CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_jobs_jobs_check2 CHECK ((((status = 'queued'::text) AND (started_at IS NULL) AND (finished_at IS NULL) AND (failure_code IS NULL)) OR ((status = 'running'::text) AND (started_at IS NOT NULL) AND (finished_at IS NULL) AND (failure_code IS NULL) AND (attempts >= 1)) OR ((status = 'succeeded'::text) AND (started_at IS NOT NULL) AND (finished_at IS NOT NULL) AND (failure_code IS NULL)) OR ((status = 'failed'::text) AND (started_at IS NOT NULL) AND (finished_at IS NOT NULL) AND (failure_code IS NOT NULL)) OR ((status = 'canceled'::text) AND (finished_at IS NOT NULL)))),
    CONSTRAINT n2f_jobs_jobs_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[a-z][a-z0-9_.-]{0,127}$'::text))),
    CONSTRAINT n2f_jobs_jobs_kind_check CHECK ((kind ~ '^[a-z][a-z0-9_.-]{0,119}$'::text)),
    CONSTRAINT n2f_jobs_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT n2f_jobs_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT n2f_jobs_jobs_subject_shape_check CHECK ((((subject_type IS NULL) AND (subject_id IS NULL)) OR ((subject_type IS NOT NULL) AND (subject_id IS NOT NULL) AND (subject_type ~ '^[a-z][a-z0-9_.-]{0,63}$'::text)))),
    CONSTRAINT n2f_jobs_jobs_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_mailbox (
    event_id uuid NOT NULL,
    envelope text NOT NULL,
    CONSTRAINT n2f_mailbox_envelope_check CHECK (((octet_length(envelope) <= 65536) AND (jsonb_typeof((envelope)::jsonb) = 'object'::text)))
);

CREATE TABLE public.n2f_mailbox_receipts (
    event_id uuid NOT NULL,
    consumer text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease uuid,
    lease_until timestamp with time zone,
    last_error text,
    finished_at timestamp with time zone,
    CONSTRAINT n2f_mailbox_receipts_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT n2f_mailbox_receipts_check CHECK (((lease IS NULL) = (lease_until IS NULL))),
    CONSTRAINT n2f_mailbox_receipts_consumer_check CHECK ((consumer ~ '^[a-z0-9_.-]{1,64}$'::text)),
    CONSTRAINT n2f_mailbox_receipts_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 200))),
    CONSTRAINT n2f_mailbox_receipts_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'processed'::text, 'dead'::text])))
);

CREATE TABLE public.n2f_organization_invitations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_organization_invitations_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_organization_invitations_check1 CHECK ((expires_at > created_at)),
    CONSTRAINT n2f_organization_invitations_check2 CHECK ((((status = 'pending'::text) AND (accepted_at IS NULL) AND (revoked_at IS NULL)) OR ((status = 'accepted'::text) AND (accepted_at IS NOT NULL) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (accepted_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT n2f_organization_invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT n2f_organization_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text]))),
    CONSTRAINT n2f_organization_invitations_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_organization_memberships (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_organization_memberships_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_organization_memberships_check1 CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT n2f_organization_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT n2f_organization_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT n2f_organization_memberships_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_organization_organizations (
    id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_organization_organizations_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_organization_organizations_name_check CHECK (((char_length(name) > 0) AND (char_length(name) <= 160))),
    CONSTRAINT n2f_organization_organizations_slug_check CHECK ((slug ~ '^[a-z][a-z0-9-]{0,62}$'::text)),
    CONSTRAINT n2f_organization_organizations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text]))),
    CONSTRAINT n2f_organization_organizations_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_outbox (
    event_id uuid NOT NULL,
    envelope text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease uuid,
    lease_until timestamp with time zone,
    last_error text,
    finished_at timestamp with time zone,
    CONSTRAINT n2f_outbox_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT n2f_outbox_check CHECK (((lease IS NULL) = (lease_until IS NULL))),
    CONSTRAINT n2f_outbox_envelope_check CHECK (((octet_length(envelope) <= 65536) AND (jsonb_typeof((envelope)::jsonb) = 'object'::text))),
    CONSTRAINT n2f_outbox_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 200))),
    CONSTRAINT n2f_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sent'::text, 'dead'::text])))
);

CREATE TABLE public.n2f_rate_limits (
    bucket_key text NOT NULL,
    window_start_ms bigint NOT NULL,
    window_ms integer NOT NULL,
    rule_limit integer NOT NULL,
    count integer NOT NULL,
    CONSTRAINT n2f_rate_limits_bucket_key_check CHECK (((length(bucket_key) >= 1) AND (length(bucket_key) <= 256))),
    CONSTRAINT n2f_rate_limits_count_check CHECK ((count >= 1)),
    CONSTRAINT n2f_rate_limits_rule_limit_check CHECK (((rule_limit >= 1) AND (rule_limit <= 1000000))),
    CONSTRAINT n2f_rate_limits_window_ms_check CHECK (((window_ms >= 1000) AND (window_ms <= 86400000)))
);

CREATE TABLE public.signals_migrations (
    version bigint NOT NULL,
    checksum text NOT NULL
);

ALTER TABLE ONLY public.n2f_audit_entries
    ADD CONSTRAINT n2f_audit_entries_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY public.n2f_audit_entries
    ADD CONSTRAINT n2f_audit_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_document_documents
    ADD CONSTRAINT n2f_document_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_identity_credentials
    ADD CONSTRAINT n2f_identity_credentials_email_key UNIQUE (email);

ALTER TABLE ONLY public.n2f_identity_credentials
    ADD CONSTRAINT n2f_identity_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_identity_identities
    ADD CONSTRAINT n2f_identity_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_identity_sessions
    ADD CONSTRAINT n2f_identity_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_identity_sessions
    ADD CONSTRAINT n2f_identity_sessions_token_digest_key UNIQUE (token_digest);

ALTER TABLE ONLY public.n2f_identity_verification_challenges
    ADD CONSTRAINT n2f_identity_verification_challenges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_jobs_jobs
    ADD CONSTRAINT n2f_jobs_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_mailbox
    ADD CONSTRAINT n2f_mailbox_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.n2f_mailbox_receipts
    ADD CONSTRAINT n2f_mailbox_receipts_pkey PRIMARY KEY (event_id, consumer);

ALTER TABLE ONLY public.n2f_organization_invitations
    ADD CONSTRAINT n2f_organization_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_organization_memberships
    ADD CONSTRAINT n2f_organization_membership_organization_id_identity_id_key UNIQUE (organization_id, identity_id);

ALTER TABLE ONLY public.n2f_organization_memberships
    ADD CONSTRAINT n2f_organization_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_organization_organizations
    ADD CONSTRAINT n2f_organization_organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_organization_organizations
    ADD CONSTRAINT n2f_organization_organizations_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.n2f_outbox
    ADD CONSTRAINT n2f_outbox_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.n2f_rate_limits
    ADD CONSTRAINT n2f_rate_limits_pkey PRIMARY KEY (bucket_key, window_start_ms, window_ms, rule_limit);

ALTER TABLE ONLY public.signals_migrations
    ADD CONSTRAINT signals_migrations_pkey PRIMARY KEY (version);

CREATE INDEX n2f_audit_entries_recorded ON public.n2f_audit_entries USING btree (recorded_at, event_id);

CREATE INDEX n2f_audit_entries_tenant ON public.n2f_audit_entries USING btree (tenant_id, recorded_at, id) WHERE (tenant_id IS NOT NULL);

CREATE INDEX n2f_document_documents_organization ON public.n2f_document_documents USING btree (organization_id, created_at, id);

CREATE INDEX n2f_identity_credentials_identity ON public.n2f_identity_credentials USING btree (identity_id);

CREATE INDEX n2f_identity_sessions_identity ON public.n2f_identity_sessions USING btree (identity_id);

CREATE INDEX n2f_identity_verification_challenges_identity ON public.n2f_identity_verification_challenges USING btree (identity_id);

CREATE UNIQUE INDEX n2f_jobs_jobs_open_subject ON public.n2f_jobs_jobs USING btree (organization_id, kind, subject_type, subject_id) WHERE ((subject_type IS NOT NULL) AND ((status = ANY (ARRAY['queued'::text, 'running'::text])) OR ((status = 'failed'::text) AND (attempts < max_attempts))));

CREATE INDEX n2f_jobs_jobs_organization ON public.n2f_jobs_jobs USING btree (organization_id, created_at, id);

CREATE INDEX n2f_jobs_jobs_running ON public.n2f_jobs_jobs USING btree (started_at, id) WHERE (status = 'running'::text);

CREATE INDEX n2f_mailbox_receipts_pending ON public.n2f_mailbox_receipts USING btree (consumer, available_at, event_id) WHERE (state = 'pending'::text);

CREATE UNIQUE INDEX n2f_organization_invitations_pending_identity ON public.n2f_organization_invitations USING btree (organization_id, identity_id) WHERE (status = 'pending'::text);

CREATE INDEX n2f_organization_memberships_identity ON public.n2f_organization_memberships USING btree (identity_id);

CREATE INDEX n2f_outbox_finished ON public.n2f_outbox USING btree (finished_at) WHERE (state = 'sent'::text);

CREATE INDEX n2f_outbox_pending ON public.n2f_outbox USING btree (available_at, event_id) WHERE (state = 'pending'::text);

CREATE INDEX n2f_rate_limits_window ON public.n2f_rate_limits USING btree (window_start_ms);

ALTER TABLE ONLY public.n2f_identity_credentials
    ADD CONSTRAINT n2f_identity_credentials_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.n2f_identity_identities(id);

ALTER TABLE ONLY public.n2f_identity_sessions
    ADD CONSTRAINT n2f_identity_sessions_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.n2f_identity_identities(id);

ALTER TABLE ONLY public.n2f_identity_verification_challenges
    ADD CONSTRAINT n2f_identity_verification_challenges_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.n2f_identity_identities(id);

ALTER TABLE ONLY public.n2f_mailbox_receipts
    ADD CONSTRAINT n2f_mailbox_receipts_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.n2f_mailbox(event_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.n2f_organization_invitations
    ADD CONSTRAINT n2f_organization_invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.n2f_organization_organizations(id);

ALTER TABLE ONLY public.n2f_organization_memberships
    ADD CONSTRAINT n2f_organization_memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.n2f_organization_organizations(id);
