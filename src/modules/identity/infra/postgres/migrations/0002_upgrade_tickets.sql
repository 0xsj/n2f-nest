CREATE TABLE public.n2f_identity_upgrade_tickets (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES public.n2f_identity_sessions(id),
 token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
 issued_at_ms bigint NOT NULL CHECK (issued_at_ms BETWEEN 0 AND 253402300799999),
 expires_at_ms bigint NOT NULL CHECK (expires_at_ms > issued_at_ms AND expires_at_ms <= 253402300799999 AND expires_at_ms - issued_at_ms <= 30000),
 consumed_at_ms bigint,
 CONSTRAINT n2f_identity_upgrade_tickets_consumed_check CHECK (consumed_at_ms IS NULL OR (consumed_at_ms >= issued_at_ms AND consumed_at_ms < expires_at_ms)),
 CONSTRAINT n2f_identity_upgrade_tickets_digest_unique UNIQUE (token_digest)
);
CREATE INDEX n2f_identity_upgrade_tickets_session ON public.n2f_identity_upgrade_tickets(session_id);
