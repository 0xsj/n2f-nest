import { expect, it } from 'vitest';
import { parseTrustedProxies, trustedSource } from './proxy.js';

it('requires a trusted peer before using forwarded source addresses', () => {
  const parsed = parseTrustedProxies('10.0.0.0/8');
  if (!parsed.ok) throw new Error('fixture');
  const headers = { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' };
  expect(trustedSource(parsed.value, '10.0.0.1', headers)).toBe(
    '198.51.100.7',
  );
  expect(trustedSource(parsed.value, '203.0.113.9', headers)).toBe(
    '203.0.113.9',
  );
  expect(
    trustedSource(parsed.value, '10.0.0.1', {
      'x-forwarded-for': '198.51.100.7,not-an-ip',
    }),
  ).toBe('10.0.0.1');
});

it('canonicalizes mapped IPv4 peers and IPv6 forwarding', () => {
  const parsed = parseTrustedProxies('10.0.0.0/8');
  if (!parsed.ok) throw new Error('fixture');
  expect(
    trustedSource(parsed.value, '::ffff:10.0.0.1', {
      'x-forwarded-for': '2001:0db8::1',
    }),
  ).toBe('2001:db8::1');
});
