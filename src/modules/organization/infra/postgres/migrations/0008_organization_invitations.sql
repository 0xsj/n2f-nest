CREATE TABLE public.signals_organization_invitations (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.signals_organization_organizations(id),
 identity_id uuid NOT NULL REFERENCES public.signals_identity_identities(id),
 role text NOT NULL CHECK (role IN ('admin','member')),
 status text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 revoked_at timestamptz,
 CHECK (updated_at>=created_at),
 CHECK (expires_at>created_at),
 CHECK ((status='pending' AND accepted_at IS NULL AND revoked_at IS NULL) OR
        (status='accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
        (status='revoked' AND accepted_at IS NULL AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX signals_organization_invitations_pending_identity
 ON public.signals_organization_invitations(organization_id,identity_id)
 WHERE status='pending';
