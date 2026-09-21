CREATE TABLE public.signals_identity_sessions (
 id uuid PRIMARY KEY,
 identity_id uuid NOT NULL REFERENCES public.signals_identity_identities(id),
 status text NOT NULL CHECK (status IN ('active','revoked')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 token_digest text NOT NULL UNIQUE,
 CHECK (expires_at > created_at),
 CHECK (
   (status='active' AND revoked_at IS NULL) OR
   (status='revoked' AND revoked_at IS NOT NULL)
 )
);

CREATE INDEX signals_identity_sessions_identity
 ON public.signals_identity_sessions(identity_id);
