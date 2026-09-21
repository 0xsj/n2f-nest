# Socket module notes

The socket layer is a small versioned, bounded message envelope; WebSocket or
other connection adapters remain replaceable consumers of it.

## Origin

Realtime delivery is likely to matter for fan experiences, but it should not
force domain modules to know whether the process uses WebSockets, server-sent
events or a future gateway service.

## What and why

- Messages have a version, bounded identifier, namespaced lowercase type and
  object payload.
- Encoding validates by decoding the serialized bytes again. This catches
  schema drift at the boundary rather than after a message is sent.
- Decoding uses fatal UTF-8 and a byte limit. Invalid input returns a shared
  failure and never throws into a connection loop.

## Gotchas

- The envelope does not define authentication, authorization, ordering or
  replay. Those are connection and domain policies.
- Domain event envelopes and socket messages are related but not interchangeable:
  an event is a durable business fact, while a socket message is a delivery
  representation.

## Used in

- `src/shared/socket/index.ts`
- `src/shared/socket/socket.spec.ts`

## Related

- [`events`](../events/README.md)
- [`http`](../http/README.md)
