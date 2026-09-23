-- Baseline schema. Identity: identities, credentials, verification challenges and sessions.
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

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

CREATE INDEX n2f_identity_credentials_identity ON public.n2f_identity_credentials USING btree (identity_id);

CREATE INDEX n2f_identity_sessions_identity ON public.n2f_identity_sessions USING btree (identity_id);

CREATE INDEX n2f_identity_verification_challenges_identity ON public.n2f_identity_verification_challenges USING btree (identity_id);

ALTER TABLE ONLY public.n2f_identity_credentials
    ADD CONSTRAINT n2f_identity_credentials_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.n2f_identity_identities(id);

ALTER TABLE ONLY public.n2f_identity_sessions
    ADD CONSTRAINT n2f_identity_sessions_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.n2f_identity_identities(id);

ALTER TABLE ONLY public.n2f_identity_verification_challenges
    ADD CONSTRAINT n2f_identity_verification_challenges_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES public.n2f_identity_identities(id);
