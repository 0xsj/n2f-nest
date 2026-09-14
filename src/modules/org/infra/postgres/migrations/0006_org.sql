CREATE TABLE public.n2f_org_organizations (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
 created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 253402300799999)
);
CREATE TABLE public.n2f_org_memberships (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.n2f_org_organizations(id),
 principal_id uuid NOT NULL,
 role text NOT NULL CHECK (role IN ('owner','admin','member')),
 created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 253402300799999)
);
CREATE INDEX n2f_org_memberships_by_organization
 ON public.n2f_org_memberships(organization_id, id);
