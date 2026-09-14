CREATE TABLE public.n2f_audit_records (
 event_id uuid PRIMARY KEY,
 occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 253402300799999),
 recorded_at_ms bigint NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND 253402300799999),
 action text NOT NULL CHECK (octet_length(action) BETWEEN 1 AND 128),
 outcome text NOT NULL CHECK (outcome='succeeded'),
 actor_kind text NOT NULL CHECK (actor_kind IN ('anonymous','user','service','system')),
 actor_identity text NOT NULL,
 subject_id uuid NOT NULL,
 tenant text,
 work_id uuid NOT NULL,
 correlation_id uuid NOT NULL,
 causation_id uuid,
 origin text,
 details text NOT NULL CHECK (octet_length(details)<=65536 AND jsonb_typeof(details::jsonb)='object')
);
CREATE INDEX n2f_audit_records_order ON public.n2f_audit_records(recorded_at_ms DESC,event_id DESC);
