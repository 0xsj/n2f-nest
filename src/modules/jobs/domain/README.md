# Jobs domain layer

The `Job` aggregate represents business-visible execution work. It owns a
validated kind, organization reference, retry budget, attempt count and
queued/running/succeeded/failed/canceled lifecycle.

`start`, `complete`, `fail`, `retry` and `cancel` are immutable transitions.
Retry budget is consumed when work starts, not when it fails. A failed job can
return to queued only while attempts remain. The domain does not own a queue,
worker process, scheduler or handler implementation.
