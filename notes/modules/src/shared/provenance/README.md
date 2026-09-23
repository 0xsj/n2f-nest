# Provenance module notes

Provenance records execution attribution and causality across local work,
messages and retries. It is a shared value model, not an authorization service,
transport codec, tracing SDK or durable audit store.

- [First slice](first-slice.md): scope and the additions made for this backend.
- [Language walkthrough](language-walkthrough.md): branded values, ownership,
  immutable snapshots and transition helpers.

The executable behavior lives in [`src/shared/provenance/`](../../../../../src/shared/provenance/).
HTTP, NATS, WebSocket, tracing and persistence adapters will validate and
authenticate their own external representations before constructing these values.
