# Health module notes

`Gate` separates process liveness from dependency readiness. The gate starts in
`starting`, permits one bounded readiness probe while `serving`, and refuses new
probes after `draining` begins.

Checks receive an AbortSignal and must return the shared Result shape. A timeout,
external cancellation, failed check or thrown check makes readiness false; the
gate does not expose dependency internals through the health result.

See [`src/shared/health/`](../../../../../src/shared/health/).
