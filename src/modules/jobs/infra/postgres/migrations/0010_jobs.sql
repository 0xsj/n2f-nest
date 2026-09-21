CREATE TABLE public.signals_jobs_jobs (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.signals_organization_organizations(id),
 kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,119}$'),
 status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled')),
 attempts integer NOT NULL CHECK (attempts>=0),
 max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 started_at timestamptz,
 finished_at timestamptz,
 failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 CHECK (attempts<=max_attempts),
 CHECK (updated_at>=created_at),
 CHECK (
   (status='queued' AND started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL) OR
   (status='running' AND started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL AND attempts>=1) OR
   (status='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL) OR
   (status='failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NOT NULL) OR
   (status='canceled' AND finished_at IS NOT NULL)
 )
);

CREATE INDEX signals_jobs_jobs_organization
 ON public.signals_jobs_jobs(organization_id,created_at,id);
