import { expect, it } from 'vitest';
import { SecretString } from '../../secret/index.js';
import { Broker } from './broker.js';

it('rejects invalid JetStream configuration before connecting', async () => {
  for (const config of [
    { url: 'http://localhost:4222', stream: 'n2f_events', consumer: 'audit', timeoutMs: 1000 },
    { url: 'nats://', stream: 'n2f_events', consumer: 'audit', timeoutMs: 1000 },
    { url: 'nats://localhost:4222', stream: 'bad stream', consumer: 'audit', timeoutMs: 1000 },
    { url: 'nats://localhost:4222', stream: 'n2f_events', consumer: 'audit', timeoutMs: 0 },
    { url: 'nats://localhost:4222', stream: 'n2f_events', consumer: 'audit', timeoutMs: 1000, subjectPrefix: 'n2f.events' },
    { url: 'nats://localhost:4222', stream: 'n2f_events', consumer: 'audit', timeoutMs: 1000, subjectPrefix: 'n2f.*.' },
  ]) {
    const result = await Broker.open({
      ...config,
      url: new SecretString(config.url),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('events.jetstream_config');
  }
});
