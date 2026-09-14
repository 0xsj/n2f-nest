# WebSocket contract

W01: Root owns a finite transport endpoint with an exact allowed Origin and the
required subprotocol n2f.v1. Missing/repeated/wrong Origin or missing subprotocol
refuses admission. Maximum 64 admitted connections, including work still finishing.
No cookie/principal trust or tenant membership is inferred by this adapter; root
may supply an opaque authorization and revalidation callback.
W02: Text messages are UTF-8 JSON objects with exactly v,id,type,payload:
v is numeric 1, id is 1..64 ASCII letters/digits/underscore/hyphen, type is 1..64
lowercase letters/digits/dot/underscore, payload is a JSON object.
Maximum serialized message is 65536 bytes. Binary closes 1003; malformed envelope
closes 1008; message size violation closes 1009; internal handler failure closes 1011.
W03: Process one application message at a time per connection. Go/Rust use socket
backpressure; Node refuses overlapping application messages with 1013 instead of
an unbounded Promise queue. Handler and write have a 1000 ms budget. Handler
callbacks honor cancellation and cannot retain socket objects or start detached work.
A slow write closes the connection. No successful local write claims client processing.
W04: Ping every 15 seconds; lack of pong terminates by the following heartbeat
budget. When supplied, the adapter invokes opaque admission revalidation before
each application message and heartbeat ping. Protocol adapters handle control
frames. Shutdown refuses new upgrades, closes admitted connections (1001 when a
graceful close can be delivered), and drains under the remaining root budget,
then forces transport closure.
W05: Root opens a connection provenance scope; each admitted application message
opens child work with fresh work/scope IDs. Client message id is only an echo key,
never a trusted provenance ID. Connection scope is not an authenticated session.
Observation uses fixed operation names, close reason and byte/count facts; never
payloads, raw Origin, arbitrary message types or credentials as metric labels.
W06: Diagnostic ping replies pong with the echoed id and payload containing the
connection scope ID and fresh message scope ID. The adapter accepts a root-owned
session handler so domain message routing can replace the diagnostic behavior.
Real wire verification must cover admission, repeated messages, malformed/binary/
oversize frames, heartbeat control frames and shutdown with an open connection.
