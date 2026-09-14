CREATE UNIQUE INDEX IF NOT EXISTS n2f_org_memberships_organization_principal
 ON public.n2f_org_memberships(organization_id, principal_id);

CREATE TABLE public.n2f_org_invitations (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.n2f_org_organizations(id),
 inviter_principal_id uuid NOT NULL,
 invitee_principal_id uuid NOT NULL,
 role text NOT NULL CHECK (role IN ('admin','member')),
 status text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
 created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
 expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms AND expires_at_ms <= 253402300799999),
 resolved_at_ms bigint,
 CHECK (inviter_principal_id <> invitee_principal_id),
 CHECK ((status = 'pending' AND resolved_at_ms IS NULL) OR (status <> 'pending' AND resolved_at_ms IS NOT NULL)),
 CHECK (resolved_at_ms IS NULL OR resolved_at_ms BETWEEN created_at_ms AND 253402300799999)
);
CREATE UNIQUE INDEX n2f_org_invitations_pending_target
 ON public.n2f_org_invitations(organization_id, invitee_principal_id)
 WHERE status = 'pending';
CREATE INDEX n2f_org_invitations_by_invitee
 ON public.n2f_org_invitations(invitee_principal_id, status, created_at_ms DESC);
