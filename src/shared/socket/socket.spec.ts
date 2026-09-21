import { expect, it } from 'vitest';
import { decode, encode, type Message } from './index.js';

it('round-trips bounded versioned messages', () => {
  const message: Message = {
    v: 1,
    id: 'message_01',
    type: 'identity.session.created',
    payload: { sessionId: 'session_01' },
  };
  const encoded = encode(message);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) return;
  expect(decode(encoded.value)).toEqual({ ok: true, value: message });
});

it('rejects malformed, oversized and schema-drifting messages', () => {
  for (const raw of [
    '{}',
    '{"v":2,"id":"x","type":"x","payload":{}}',
    '{"v":1,"id":"x","type":"Identity.Created","payload":{}}',
    '{"v":1,"id":"x","type":"x","payload":[]}',
    '{"v":1,"id":"x","type":"x","payload":{},"extra":true}',
  ]) {
    expect(decode(new TextEncoder().encode(raw)).ok).toBe(false);
  }
  expect(decode(new Uint8Array(65537)).ok).toBe(false);
});
