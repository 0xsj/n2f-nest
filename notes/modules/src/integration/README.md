# Integration bridges

Modules never import one another. A module declares what it needs as a port
in its own `app/ports/` and as a Nest token in `infra/requires.ts`, both
re-exported from its `api.ts`. A bridge in `src/integration/` implements that
port by calling another module's public query, and the composition root hands
the bridge to the module that needs it.

## Origin

Until 2026-09-23 the adapters that crossed modules lived inside the consuming
module (`document/infra/in-memory/organization-access-reader.ts` imported
Organization's application layer), and Nest modules imported one another.
Code-level coupling was disciplined but unenforced, and a fork could not
delete Organization without editing Document and Jobs. See the
[hardening bar](../../../architecture/hardening-bar.md), items B1, B2 and B5.

## What and why

- **Modules are islands.** `src/modules/X` imports only `X`, `shared/` and
  `platform/`. Other code imports `X/api.ts`, never internals.
- **Commands stay inside workflows.** A module's commands are exported from
  `commands.ts`, which only `src/workflows/` may import. Bridges can call
  queries only, so no module ever changes another module's state.
- **The composition root decides.** `app.module.ts` registers each module once
  (`OrganizationModule.register({ requires: [...] })`) and passes the same
  registration object to every bridge and workflow that needs it, so Nest
  resolves one instance.
- **Data follows the same rule.** No foreign keys cross modules; a module
  holds another module's IDs as opaque references and confirms them through
  its ports.

Contracts shared between modules (a `contracts/` package) were rejected: they
still let one module depend on another. RPC and gRPC were deferred; a bridge
is exactly where a remote call would go if a module were ever extracted.

## Example

`DocumentModule` requires `DOCUMENT_REQUIRES.organizationAccess`, an
`OrganizationAccessReader`. `OrganizationAccessBridge` implements it with
`GetOrganizationMembership` and grants access only for an active membership in
an active organization. Jobs and Audit declare the same port in their own
terms; the shapes coincide, so one bridge serves all three. Each consumer's
provider lives in its own file (`document-access.ts`, `jobs-access.ts`, with
Audit's in `organization-access.ts`) and calls
`OrganizationAccessBridgeModule.provide<Port>()`, which fails to compile if
the bridge stops satisfying that consumer's port. Deleting an example module
therefore deletes its bridge file and nothing else (`make fork-check`, B6).

## Gotchas

- Registering a module twice creates two instances with separate in-memory
  state. Always reuse the composition root's registration object.
- A bridge that grows domain logic is a sign the logic belongs in one of the
  modules it connects.
- Events are the other cross-module channel. Consumers decode them with their
  own decoders; that contract work is item B3.

## Used in

- `src/integration/organization-identity.ts`
- `src/integration/organization-access.ts`
- `src/integration/{document,jobs}-access.ts`
- `src/app.module.ts`
- `scripts/check-module-boundaries.ts`
