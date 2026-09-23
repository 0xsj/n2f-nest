import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { traceRef } from '../telemetry/index.js';
import { Client } from './index.js';

it.skipIf(!process.env.N2F_TEST_NETWORK)(
  'executes bounded loopback attempts without redirect or status rewriting',
  async () => {
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/status':
        response.writeHead(409).end('{"ok":false}');
        break;
      case '/redirect':
        response.writeHead(302, { location: '/status' }).end();
        break;
      case '/large':
        response.end('x'.repeat(100));
        break;
      case '/slow':
        break;
      case '/trace':
        response.end(request.headers.traceparent);
        break;
      default:
        response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture');

  const made = Client.create({
    origin: `http://127.0.0.1:${address.port}`,
    timeoutMs: 50,
    maxRequest: 64,
    maxResponse: 64,
  });
  if (!made.ok) throw Error('fixture');
  const client = made.value;
  try {
    for (const [path, status] of [
      ['/status', 409],
      ['/redirect', 302],
    ] as const) {
      const result = await client.do({ method: 'GET', path });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe(status);
    }
    for (const [path, code] of [
      ['/large', 'httpclient.response_too_large'],
      ['/slow', 'httpclient.timeout'],
      ['//evil/x', 'httpclient.request'],
      ['/\\evil', 'httpclient.request'],
    ]) {
      const result = await client.do({ method: 'GET', path });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe(code);
    }
    const trace = traceRef('1'.repeat(32), '2'.repeat(16), true);
    if (!trace.ok) throw Error('fixture');
    const traced = await client.do({
      method: 'GET',
      path: '/trace',
      trace: trace.value,
    });
    expect(traced.ok).toBe(true);
    if (traced.ok) {
      expect(Buffer.from(traced.value.body).toString()).toBe(
        '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
      );
    }
    const controller = new AbortController();
    controller.abort();
    const canceled = await client.do(
      { method: 'GET', path: '/status' },
      controller.signal,
    );
    expect(canceled.ok).toBe(false);
    if (!canceled.ok) expect(canceled.error.kind).toBe('canceled');
    client.close();
    const closed = await client.do({ method: 'GET', path: '/status' });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.type).toBe('httpclient.closed');
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  },
  10000,
);
