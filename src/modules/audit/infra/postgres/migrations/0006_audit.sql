CREATE TABLE public.signals_audit_entries (
 id uuid PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE,
 event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9_.-]{1,120}\.v[1-9][0-9]{0,5}$'),
 occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL,
 work_context jsonb NOT NULL CHECK (jsonb_typeof(work_context)='object'),
 subject_kind text,
 subject_id uuid,
 CHECK ((subject_kind IS NULL) = (subject_id IS NULL))
);

CREATE INDEX signals_audit_entries_recorded
 ON public.signals_audit_entries(recorded_at,event_id);
