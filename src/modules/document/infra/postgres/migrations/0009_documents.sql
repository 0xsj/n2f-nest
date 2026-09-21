CREATE TABLE public.signals_document_documents (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.signals_organization_organizations(id),
 name text NOT NULL CHECK (char_length(name)>0 AND char_length(name)<=200),
 storage_key text CHECK (storage_key IS NULL OR (char_length(storage_key)>0 AND char_length(storage_key)<=512)),
 status text NOT NULL CHECK (status IN ('active','archived')),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 archived_at timestamptz,
 CHECK (updated_at>=created_at),
 CHECK (
   (status='active' AND archived_at IS NULL) OR
   (status='archived' AND archived_at IS NOT NULL)
 )
);

CREATE INDEX signals_document_documents_organization
 ON public.signals_document_documents(organization_id,created_at,id);
