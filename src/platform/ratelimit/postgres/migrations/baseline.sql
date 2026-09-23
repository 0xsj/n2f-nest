-- Baseline schema. Rate limiting: shared fixed-window buckets.
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

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

ALTER TABLE ONLY public.n2f_rate_limits
    ADD CONSTRAINT n2f_rate_limits_pkey PRIMARY KEY (bucket_key, window_start_ms, window_ms, rule_limit);

CREATE INDEX n2f_rate_limits_window ON public.n2f_rate_limits USING btree (window_start_ms);
