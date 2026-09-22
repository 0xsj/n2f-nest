CREATE TABLE public.n2f_rate_limits (
  bucket_key text NOT NULL,
  window_start_ms bigint NOT NULL,
  window_ms integer NOT NULL,
  rule_limit integer NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (bucket_key, window_start_ms, window_ms, rule_limit),
  CHECK (length(bucket_key) BETWEEN 1 AND 256),
  CHECK (window_ms BETWEEN 1000 AND 86400000),
  CHECK (rule_limit BETWEEN 1 AND 1000000),
  CHECK (count >= 1)
);

CREATE INDEX n2f_rate_limits_window
  ON public.n2f_rate_limits(window_start_ms);
