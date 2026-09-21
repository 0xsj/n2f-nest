CREATE TABLE public.signals_identity_identities (
 id uuid PRIMARY KEY,
 status text NOT NULL CHECK (status IN ('pending_verification','active','suspended','disabled')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 verified_at timestamptz
);

CREATE TABLE public.signals_identity_credentials (
 id uuid PRIMARY KEY,
 identity_id uuid NOT NULL REFERENCES public.signals_identity_identities(id),
 method text NOT NULL CHECK (method IN ('email_password')),
 email text NOT NULL UNIQUE,
 status text NOT NULL CHECK (status IN ('active','revoked')),
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 revoked_at timestamptz
);

CREATE INDEX signals_identity_credentials_identity
 ON public.signals_identity_credentials(identity_id);
