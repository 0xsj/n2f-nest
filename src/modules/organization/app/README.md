# Organization application layer

The application boundary is typed in `failures.ts`. It keeps the three domain
failure unions separate while normalizing failures from identity and storage
ports into Organization-owned dependency failures. Domain-to-domain
composition therefore remains explicit and the ports stay open to remote
adapters.

Reserved for organization commands, queries and ports. The first application
slice will create an organization and its owner membership atomically.
