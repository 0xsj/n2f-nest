-- Baseline schema. Jobs: organization-scoped jobs, one open job per subject.
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

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

ALTER TABLE ONLY public.n2f_jobs_jobs
    ADD CONSTRAINT n2f_jobs_jobs_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX n2f_jobs_jobs_open_subject ON public.n2f_jobs_jobs USING btree (organization_id, kind, subject_type, subject_id) WHERE ((subject_type IS NOT NULL) AND ((status = ANY (ARRAY['queued'::text, 'running'::text])) OR ((status = 'failed'::text) AND (attempts < max_attempts))));

CREATE INDEX n2f_jobs_jobs_organization ON public.n2f_jobs_jobs USING btree (organization_id, created_at, id);

CREATE INDEX n2f_jobs_jobs_running ON public.n2f_jobs_jobs USING btree (started_at, id) WHERE (status = 'running'::text);
