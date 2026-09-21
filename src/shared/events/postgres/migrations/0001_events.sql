CREATE TABLE public.signals_outbox (
 event_id uuid PRIMARY KEY,
 envelope text NOT NULL CHECK (octet_length(envelope)<=65536 AND jsonb_typeof(envelope::jsonb)='object'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease uuid,
 lease_until timestamptz,
 CHECK ((lease IS NULL) = (lease_until IS NULL))
);
CREATE INDEX signals_outbox_pending ON public.signals_outbox(available_at,event_id) WHERE state='pending';

CREATE TABLE public.signals_mailbox (
 event_id uuid PRIMARY KEY,
 envelope text NOT NULL CHECK (octet_length(envelope)<=65536 AND jsonb_typeof(envelope::jsonb)='object'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signals_mailbox_pending ON public.signals_mailbox(available_at,event_id) WHERE state='pending';
