DROP INDEX IF EXISTS public.signals_mailbox_pending;

CREATE TABLE public.signals_mailbox_receipts (
 event_id uuid NOT NULL REFERENCES public.signals_mailbox(event_id) ON DELETE CASCADE,
 consumer text NOT NULL CHECK (consumer ~ '^[a-z0-9_.-]{1,64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease uuid,
 lease_until timestamptz,
 PRIMARY KEY (event_id, consumer),
 CHECK ((lease IS NULL) = (lease_until IS NULL))
);
INSERT INTO public.signals_mailbox_receipts(event_id,consumer,state,attempts,available_at)
 SELECT event_id,'signals-migration',state,attempts,available_at
 FROM public.signals_mailbox;
ALTER TABLE public.signals_mailbox
 DROP COLUMN IF EXISTS state,
 DROP COLUMN IF EXISTS attempts,
 DROP COLUMN IF EXISTS available_at;
CREATE INDEX signals_mailbox_receipts_pending
 ON public.signals_mailbox_receipts(consumer,available_at,event_id)
 WHERE state='pending';
