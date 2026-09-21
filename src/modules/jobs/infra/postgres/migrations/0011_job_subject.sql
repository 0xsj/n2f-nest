ALTER TABLE public.signals_jobs_jobs
  ADD COLUMN subject_type text,
  ADD COLUMN subject_id uuid;

ALTER TABLE public.signals_jobs_jobs
  ADD CONSTRAINT signals_jobs_jobs_subject_shape_check
  CHECK (
    (subject_type IS NULL AND subject_id IS NULL) OR
    (subject_type IS NOT NULL AND subject_id IS NOT NULL AND subject_type ~ '^[a-z][a-z0-9_.-]{0,63}$')
  );

CREATE UNIQUE INDEX signals_jobs_jobs_subject_unique
  ON public.signals_jobs_jobs(organization_id,kind,subject_type,subject_id)
  WHERE subject_type IS NOT NULL;
