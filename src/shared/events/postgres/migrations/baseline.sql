-- Baseline schema. Event outbox and inbox (the per-consumer delivery ledger).
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

CREATE TABLE public.n2f_mailbox (
    event_id uuid NOT NULL,
    envelope text NOT NULL,
    CONSTRAINT n2f_mailbox_envelope_check CHECK (((octet_length(envelope) <= 65536) AND (jsonb_typeof((envelope)::jsonb) = 'object'::text)))
);

CREATE TABLE public.n2f_mailbox_receipts (
    event_id uuid NOT NULL,
    consumer text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease uuid,
    lease_until timestamp with time zone,
    last_error text,
    finished_at timestamp with time zone,
    CONSTRAINT n2f_mailbox_receipts_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT n2f_mailbox_receipts_check CHECK (((lease IS NULL) = (lease_until IS NULL))),
    CONSTRAINT n2f_mailbox_receipts_consumer_check CHECK ((consumer ~ '^[a-z0-9_.-]{1,64}$'::text)),
    CONSTRAINT n2f_mailbox_receipts_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 200))),
    CONSTRAINT n2f_mailbox_receipts_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'processed'::text, 'dead'::text])))
);

CREATE TABLE public.n2f_outbox (
    event_id uuid NOT NULL,
    envelope text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease uuid,
    lease_until timestamp with time zone,
    last_error text,
    finished_at timestamp with time zone,
    CONSTRAINT n2f_outbox_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT n2f_outbox_check CHECK (((lease IS NULL) = (lease_until IS NULL))),
    CONSTRAINT n2f_outbox_envelope_check CHECK (((octet_length(envelope) <= 65536) AND (jsonb_typeof((envelope)::jsonb) = 'object'::text))),
    CONSTRAINT n2f_outbox_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 200))),
    CONSTRAINT n2f_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sent'::text, 'dead'::text])))
);

ALTER TABLE ONLY public.n2f_mailbox
    ADD CONSTRAINT n2f_mailbox_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.n2f_mailbox_receipts
    ADD CONSTRAINT n2f_mailbox_receipts_pkey PRIMARY KEY (event_id, consumer);

ALTER TABLE ONLY public.n2f_outbox
    ADD CONSTRAINT n2f_outbox_pkey PRIMARY KEY (event_id);

CREATE INDEX n2f_mailbox_receipts_pending ON public.n2f_mailbox_receipts USING btree (consumer, available_at, event_id) WHERE (state = 'pending'::text);

CREATE INDEX n2f_outbox_finished ON public.n2f_outbox USING btree (finished_at) WHERE (state = 'sent'::text);

CREATE INDEX n2f_outbox_pending ON public.n2f_outbox USING btree (available_at, event_id) WHERE (state = 'pending'::text);

ALTER TABLE ONLY public.n2f_mailbox_receipts
    ADD CONSTRAINT n2f_mailbox_receipts_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.n2f_mailbox(event_id) ON DELETE CASCADE;
