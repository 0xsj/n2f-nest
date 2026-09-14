CREATE TABLE public.n2f_identity_principals (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('human','service')),
 display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
 status text NOT NULL CHECK (status IN ('active','suspended')),
 created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
 updated_at_ms bigint NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
 version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
 CHECK (updated_at_ms >= created_at_ms)
);
CREATE TABLE public.n2f_identity_auth_states (
 principal_id uuid PRIMARY KEY REFERENCES public.n2f_identity_principals(id),
 auth_epoch integer NOT NULL CHECK (auth_epoch BETWEEN 1 AND 2147483647)
);
CREATE TABLE public.n2f_identity_credentials (
 principal_id uuid PRIMARY KEY REFERENCES public.n2f_identity_principals(id),
 canonical_email text COLLATE "C" NOT NULL UNIQUE CHECK (octet_length(canonical_email) BETWEEN 3 AND 254),
 password_hash text NOT NULL CHECK (octet_length(password_hash) BETWEEN 1 AND 512),
 verified_at_ms bigint CHECK (verified_at_ms IS NULL OR verified_at_ms BETWEEN 0 AND 253402300799999),
 password_version integer NOT NULL CHECK (password_version BETWEEN 1 AND 2147483647),
 created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
 changed_at_ms bigint NOT NULL CHECK (changed_at_ms BETWEEN 0 AND 253402300799999),
 CHECK (changed_at_ms >= created_at_ms),
 CHECK (verified_at_ms IS NULL OR verified_at_ms >= created_at_ms)
);
CREATE TABLE public.n2f_identity_sessions (
 id uuid PRIMARY KEY,
 principal_id uuid NOT NULL REFERENCES public.n2f_identity_principals(id),
 token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
 auth_epoch integer NOT NULL CHECK (auth_epoch BETWEEN 1 AND 2147483647),
 issued_at_ms bigint NOT NULL CHECK (issued_at_ms BETWEEN 0 AND 253402300799999),
 last_seen_at_ms bigint NOT NULL CHECK (last_seen_at_ms BETWEEN 0 AND 253402300799999),
 absolute_expires_at_ms bigint NOT NULL CHECK (absolute_expires_at_ms BETWEEN 0 AND 253402300799999),
 idle_expires_at_ms bigint NOT NULL CHECK (idle_expires_at_ms BETWEEN 0 AND 253402300799999),
 revoked_at_ms bigint CHECK (revoked_at_ms IS NULL OR revoked_at_ms BETWEEN 0 AND 253402300799999),
 CHECK (issued_at_ms <= last_seen_at_ms),
 CHECK (last_seen_at_ms < absolute_expires_at_ms),
 CHECK (last_seen_at_ms <= idle_expires_at_ms),
 CHECK (idle_expires_at_ms <= absolute_expires_at_ms),
 CHECK (idle_expires_at_ms > issued_at_ms),
 CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms)
);
CREATE INDEX n2f_identity_sessions_live ON public.n2f_identity_sessions(principal_id) WHERE revoked_at_ms IS NULL;
CREATE TABLE public.n2f_identity_challenges (
 id uuid PRIMARY KEY,
 principal_id uuid NOT NULL REFERENCES public.n2f_identity_credentials(principal_id),
 purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
 token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
 password_version integer NOT NULL CHECK (password_version BETWEEN 1 AND 2147483647),
 issued_at_ms bigint NOT NULL CHECK (issued_at_ms BETWEEN 0 AND 253402300799999),
 expires_at_ms bigint NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 253402300799999),
 consumed_at_ms bigint CHECK (consumed_at_ms IS NULL OR consumed_at_ms BETWEEN 0 AND 253402300799999),
 invalidated_at_ms bigint CHECK (invalidated_at_ms IS NULL OR invalidated_at_ms BETWEEN 0 AND 253402300799999),
 UNIQUE (purpose, token_digest),
 CHECK (issued_at_ms < expires_at_ms),
 CHECK (consumed_at_ms IS NULL OR (consumed_at_ms >= issued_at_ms AND consumed_at_ms < expires_at_ms)),
 CHECK (invalidated_at_ms IS NULL OR invalidated_at_ms >= issued_at_ms)
);
CREATE INDEX n2f_identity_challenges_outstanding ON public.n2f_identity_challenges(principal_id, purpose) WHERE consumed_at_ms IS NULL AND invalidated_at_ms IS NULL;
