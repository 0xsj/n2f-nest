-- Baseline schema. Organization: organizations, memberships and invitations.
--
-- Squashed from the migration history up to v1.0.8 (see
-- notes/architecture/ADR-001-persistence-and-event-namespace.md). Constraint
-- and index names are kept exactly, because adapters map them to domain
-- failures and databases adopted from that history carry the same names.
-- Later changes to these tables are new migrations beside this file.

CREATE TABLE public.n2f_organization_invitations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_organization_invitations_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_organization_invitations_check1 CHECK ((expires_at > created_at)),
    CONSTRAINT n2f_organization_invitations_check2 CHECK ((((status = 'pending'::text) AND (accepted_at IS NULL) AND (revoked_at IS NULL)) OR ((status = 'accepted'::text) AND (accepted_at IS NOT NULL) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (accepted_at IS NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT n2f_organization_invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT n2f_organization_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text]))),
    CONSTRAINT n2f_organization_invitations_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_organization_memberships (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_organization_memberships_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_organization_memberships_check1 CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT n2f_organization_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT n2f_organization_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT n2f_organization_memberships_version_check CHECK ((version >= 1))
);

CREATE TABLE public.n2f_organization_organizations (
    id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT n2f_organization_organizations_check CHECK ((updated_at >= created_at)),
    CONSTRAINT n2f_organization_organizations_name_check CHECK (((char_length(name) > 0) AND (char_length(name) <= 160))),
    CONSTRAINT n2f_organization_organizations_slug_check CHECK ((slug ~ '^[a-z][a-z0-9-]{0,62}$'::text)),
    CONSTRAINT n2f_organization_organizations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text]))),
    CONSTRAINT n2f_organization_organizations_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY public.n2f_organization_invitations
    ADD CONSTRAINT n2f_organization_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_organization_memberships
    ADD CONSTRAINT n2f_organization_membership_organization_id_identity_id_key UNIQUE (organization_id, identity_id);

ALTER TABLE ONLY public.n2f_organization_memberships
    ADD CONSTRAINT n2f_organization_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_organization_organizations
    ADD CONSTRAINT n2f_organization_organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.n2f_organization_organizations
    ADD CONSTRAINT n2f_organization_organizations_slug_key UNIQUE (slug);

CREATE UNIQUE INDEX n2f_organization_invitations_pending_identity ON public.n2f_organization_invitations USING btree (organization_id, identity_id) WHERE (status = 'pending'::text);

CREATE INDEX n2f_organization_memberships_identity ON public.n2f_organization_memberships USING btree (identity_id);

ALTER TABLE ONLY public.n2f_organization_invitations
    ADD CONSTRAINT n2f_organization_invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.n2f_organization_organizations(id);

ALTER TABLE ONLY public.n2f_organization_memberships
    ADD CONSTRAINT n2f_organization_memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.n2f_organization_organizations(id);
