-- Baseline schema. Audit: the event projection, scoped by tenant.
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

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

ALTER TABLE ONLY public.n2f_audit_entries
    ADD CONSTRAINT n2f_audit_entries_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY public.n2f_audit_entries
    ADD CONSTRAINT n2f_audit_entries_pkey PRIMARY KEY (id);

CREATE INDEX n2f_audit_entries_recorded ON public.n2f_audit_entries USING btree (recorded_at, event_id);

CREATE INDEX n2f_audit_entries_tenant ON public.n2f_audit_entries USING btree (tenant_id, recorded_at, id) WHERE (tenant_id IS NOT NULL);
