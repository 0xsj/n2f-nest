-- Session activity: idle expiry, the per-identity cap and pruning.
-- Existing sessions count as last used when they were created.
ALTER TABLE public.n2f_identity_sessions ADD COLUMN last_seen_at timestamp with time zone;
UPDATE public.n2f_identity_sessions SET last_seen_at = created_at;
ALTER TABLE public.n2f_identity_sessions ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE public.n2f_identity_sessions
    ADD CONSTRAINT n2f_identity_sessions_last_seen_check CHECK ((last_seen_at >= created_at));
CREATE INDEX n2f_identity_sessions_expires ON public.n2f_identity_sessions USING btree (expires_at);
CREATE INDEX n2f_identity_sessions_last_seen ON public.n2f_identity_sessions USING btree (last_seen_at);
CREATE INDEX n2f_identity_sessions_revoked ON public.n2f_identity_sessions USING btree (revoked_at) WHERE (revoked_at IS NOT NULL);
