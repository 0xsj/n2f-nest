CREATE TABLE public.signals_organization_organizations (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (char_length(name)>0 AND char_length(name)<=160),
 slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{0,62}$'),
 status text NOT NULL CHECK (status IN ('active','suspended','archived')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 CHECK (updated_at>=created_at)
);

CREATE TABLE public.signals_organization_memberships (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.signals_organization_organizations(id),
 identity_id uuid NOT NULL REFERENCES public.signals_identity_identities(id),
 role text NOT NULL CHECK (role IN ('owner','admin','member')),
 status text NOT NULL CHECK (status IN ('active','revoked')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK (updated_at>=created_at),
 CHECK (
   (status='active' AND revoked_at IS NULL) OR
   (status='revoked' AND revoked_at IS NOT NULL)
 ),
 UNIQUE (organization_id,identity_id)
);

CREATE INDEX signals_organization_memberships_identity
 ON public.signals_organization_memberships(identity_id);
