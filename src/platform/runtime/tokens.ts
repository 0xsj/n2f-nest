export const RUNTIME_CONFIG = Symbol('platform.runtime.config');
export const DATABASE = Symbol('platform.runtime.database');
export const EVENT_OUTBOX = Symbol('platform.runtime.eventOutbox');
export const DURABLE_EVENT_PUBLISHER = Symbol(
  'platform.runtime.durableEventPublisher',
);
export const OUTBOX_DISPATCHER = Symbol('platform.runtime.outboxDispatcher');
export const NATS_BROKER = Symbol('platform.runtime.natsBroker');
