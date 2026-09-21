# Environment module notes

Environment variables are parsed once at the process boundary and exposed as
typed, redacted configuration rather than read opportunistically throughout
the application.

## Origin

This slice carries forward the old template's strict environment reader while
keeping the shared layer independent from Nest's configuration module. The
tests cover missing values, invalid values, bounds and safe diagnostics.

## What and why

- `Reader` captures its source at construction. A configuration object cannot
  change because the host process mutates `process.env` later.
- Required strings, integers, booleans and enums are explicit operations;
  empty strings are not silently treated as valid configuration.
- Secrets are returned as `SecretString`, which makes accidental logging safe
  while retaining an explicit `reveal()` escape at integration boundaries.
- A manifest contains names, presence and parse status without values. This is
  suitable for startup diagnostics and avoids turning configuration errors into
  credential disclosure.
- `process.env` access belongs only to `OsEnvironment`; tests can supply a
  plain record and remain deterministic.

## Gotchas

- Parsing is strict by design. If a setting has a useful default, the process
  composition root should choose that default explicitly before creating the
  domain modules.
- Environment parsing validates syntax and bounds, not whether a URL, key or
  database is reachable. Connectivity belongs to health checks or startup
  policy.
- `SecretString.reveal()` should be kept at the narrow adapter boundary; do
  not pass raw secrets through domain objects.

## Used in

- `src/shared/env/lookup.ts`
- `src/shared/env/parse.ts`
- `src/shared/env/reader.ts`
- `src/shared/env/os.ts`
- `src/shared/env/env.spec.ts`
- `src/shared/env/boundary.spec.ts`

## Related

- [`secret`](../secret/README.md)
- [`health`](../health/README.md)
- [`logger`](../logger/README.md)
