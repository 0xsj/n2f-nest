# Pagination module notes

Pagination uses bounded opaque cursors scoped to a query identity. The cursor is
an encoding convenience, not authorization and not a promise that a changing
dataset has a stable global order.

The cursor carries a version, scope and position. Decoding requires the same
scope, rejects malformed Unicode/control data and returns only the position. A
page window expects at most `limit + 1` rows, returns a copied item array and
anchors the next cursor on the last returned row.

See [`src/shared/pagination/`](../../../../../src/shared/pagination/).
