import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const enabled = process.env.N2F_RUN_RATE_LIMIT_CLUSTER === '1';
const integration = enabled ? describe : describe.skip;

type JsonResponse = {
  status: number;
  body: any;
};

type RunningBackend = {
  child: ChildProcessWithoutNullStreams;
  baseUrl: string;
  output: () => string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body };
}

async function waitForBackend(process: RunningBackend): Promise<void> {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(`backend exited during startup:\n${process.output()}`);
    }

    try {
      const response = await jsonRequest(process.baseUrl, '/organizations');
      if (response.status === 401) return;
    } catch {
      // The child is still compiling or bootstrapping.
    }
    await delay(100);
  }

  throw new Error(`backend did not become ready:\n${process.output()}`);
}

async function startBackend(port: number): Promise<RunningBackend> {
  const child = spawn('node', ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N2F_STORAGE: 'postgres',
      N2F_EVENT_TRANSPORT: 'local',
      N2F_DATABASE_URL:
        process.env.N2F_DATABASE_URL ??
        'postgres://n2f:n2f_local@127.0.0.1:7220/n2f',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const running = {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => output,
  };
  await waitForBackend(running);
  return running;
}

async function stopBackend(process: RunningBackend | undefined): Promise<void> {
  if (!process || process.child.exitCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    process.child.once('exit', () => resolve());
  });
  process.child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);

  if (process.child.exitCode === null) {
    process.child.kill('SIGKILL');
    await exited;
  }
}

integration('PostgreSQL rate-limit cluster', () => {
  it('shares one login bucket across two backend processes', async () => {
    const portA = Number(process.env.N2F_RATE_LIMIT_PORT_A ?? 7301);
    const portB = Number(process.env.N2F_RATE_LIMIT_PORT_B ?? 7302);
    const email = `rate-limit-cluster-${randomUUID()}@example.com`;
    let backendA: RunningBackend | undefined;
    let backendB: RunningBackend | undefined;

    try {
      backendA = await startBackend(portA);
      backendB = await startBackend(portB);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await jsonRequest(backendA.baseUrl, '/identity/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'wrong-password' }),
        });
        expect(response.status).toBe(401);
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await jsonRequest(backendB.baseUrl, '/identity/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'wrong-password' }),
        });
        expect(response.status).toBe(401);
      }

      const limited = await jsonRequest(backendA.baseUrl, '/identity/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({
        code: 'rate_limit.exceeded',
        request_id: expect.any(String),
      });
    } finally {
      await stopBackend(backendB);
      await stopBackend(backendA);
    }
  }, 40000);
});
