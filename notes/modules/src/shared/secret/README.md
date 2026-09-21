# Secret module notes

`SecretString` makes disclosure an explicit `reveal()` operation. Ordinary
string conversion, JSON serialization and Node inspection return `[REDACTED]`.

The value is not encryption, secure memory or a requiredness policy. Environment
and configuration layers decide whether an empty secret is acceptable. Consumers
should pass the wrapper instead of carrying raw credential strings through
logging or generic object presentation.

See [`src/shared/secret/`](../../../../../src/shared/secret/) and its tests for
the native presentation behavior.
