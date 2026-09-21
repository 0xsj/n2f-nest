CREATE TABLE public.signals_identity_verification_challenges (
 id uuid PRIMARY KEY,
 identity_id uuid NOT NULL REFERENCES public.signals_identity_identities(id),
 purpose text NOT NULL CHECK (purpose IN ('email_verification')),
 status text NOT NULL CHECK (status IN ('issued','consumed')),
 issued_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 token_digest text NOT NULL,
 CHECK (expires_at > issued_at),
 CHECK (
   (status='issued' AND consumed_at IS NULL) OR
   (status='consumed' AND consumed_at IS NOT NULL)
 )
);

CREATE INDEX signals_identity_verification_challenges_identity
 ON public.signals_identity_verification_challenges(identity_id);
