# Jobs transport layer

The first HTTP transport exposes organization-scoped submit, list, start,
complete, fail, retry and cancel operations. It is intentionally inspectable
through bearer authentication while the template establishes the application
seam. A production worker-facing transport can later use a service identity or
message adapter without changing the Job domain.
