import { Broker } from '../src/shared/events/nats/index.js';
import { SecretString } from '../src/shared/secret/index.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mailbox, verificationFrom } from './support/mail.js';
import { resetLoopbackRateLimits } from './support/rate-limits.js';

const enabled = process.env.N2F_RUN_RESTART_INTEGRATION === '1';
const integration = enabled ? describe : describe.skip;

type JsonResponse = {
  status: number;
  body: any;
};

type RunningBackend = {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

const port = Number(process.env.N2F_RESTART_PORT ?? 7301);
const baseUrl = `http://127.0.0.1:${port}`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function jsonRequest(
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

function postJson(path: string, body: unknown, token?: string): Promise<JsonResponse> {
  return jsonRequest(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitForBackend(process: RunningBackend): Promise<void> {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(`backend exited during startup:\n${process.output()}`);
    }

    try {
      const response = await jsonRequest('/organizations');
      if (response.status === 401) return;
    } catch {
      // The child is still compiling or bootstrapping.
    }
    await delay(100);
  }

  throw new Error(`backend did not become ready:\n${process.output()}`);
}

async function startBackend(consumer: string): Promise<RunningBackend> {
  const child = spawn('node', ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N2F_STORAGE: 'postgres',
      N2F_EVENT_TRANSPORT: 'nats',
      N2F_DATABASE_URL:
        process.env.N2F_DATABASE_URL ??
        'postgres://n2f:n2f_local@127.0.0.1:7220/n2f',
      N2F_NATS_URL: process.env.N2F_NATS_URL ?? 'nats://127.0.0.1:7222',
      N2F_NATS_STREAM: process.env.N2F_NATS_STREAM ?? 'n2f_events',
      N2F_NATS_SUBJECT_PREFIX:
        process.env.N2F_NATS_SUBJECT_PREFIX ?? 'n2f.events.',
      N2F_NATS_CONSUMER: consumer,
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

  const running = { child, output: () => output };
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

/** Delete the durable consumer the backend processes provisioned for this run. */
async function removeConsumer(consumer: string): Promise<void> {
  const opened = await Broker.open({
    url: new SecretString(process.env.N2F_NATS_URL ?? 'nats://127.0.0.1:7222'),
    stream: process.env.N2F_NATS_STREAM ?? 'n2f_events',
    subjectPrefix: process.env.N2F_NATS_SUBJECT_PREFIX ?? 'n2f.events.',
    consumer,
    timeoutMs: 2000,
  });
  if (!opened.ok) return;
  await opened.value.removeConsumer();
  await opened.value.close();
}

integration('Persistent process restart', () => {
  it('preserves durable identity, session, organization and document state', async () => {
    const consumer = `restart_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let backend: RunningBackend | undefined;
    const email = `restart-${randomUUID()}@example.com`;
    const password = 'correct-horse-7';

    try {
      await resetLoopbackRateLimits();
      backend = await startBackend(consumer);

      const registered = await postJson('/identity/register', { email, password });
      expect(registered.status).toBe(202);

      const mail = await jsonRequest(mailbox(email));
      const verified = await postJson('/identity/verify', verificationFrom(mail.body));
      expect(verified).toEqual({
        status: 201,
        body: { identityId: expect.any(String), status: 'active' },
      });
      const identityId = verified.body.identityId as string;

      const loggedIn = await postJson('/identity/login', { email, password });
      expect(loggedIn.status).toBe(201);
      const sessionToken = loggedIn.body.token as string;

      const organization = await postJson(
        '/organizations',
        {
          name: 'Restart Continuity Organization',
          slug: `restart-${randomUUID().slice(0, 8)}`,
        },
        sessionToken,
      );
      expect(organization.status).toBe(201);

      const organizationId = organization.body.organizationId as string;
      const document = await postJson(
        `/organizations/${organizationId}/documents`,
        {
          name: 'Restart continuity.pdf',
          storageKey: 'documents/restart-continuity.pdf',
        },
        sessionToken,
      );
      expect(document.status).toBe(201);

      await stopBackend(backend);
      backend = await startBackend(consumer);

      const current = await jsonRequest('/identity/me', {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(current).toEqual({
        status: 200,
        body: {
          identityId,
          status: 'active',
          verifiedAt: expect.any(String),
        },
      });

      const organizations = await jsonRequest('/organizations', {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(organizations.status).toBe(200);
      expect(organizations.body).toEqual([
        {
          organizationId,
          name: 'Restart Continuity Organization',
          slug: expect.stringMatching(/^restart-[a-f0-9]{8}$/),
          status: 'active',
          membershipId: organization.body.ownerMembershipId,
          role: 'owner',
          membershipStatus: 'active',
        },
      ]);

      const persistedDocument = await jsonRequest(
        `/organizations/${organizationId}/documents/${document.body.documentId}`,
        { headers: { authorization: `Bearer ${sessionToken}` } },
      );
      expect(persistedDocument.status).toBe(200);
      expect(persistedDocument.body).toMatchObject({
        documentId: document.body.documentId,
        organizationId,
        name: 'Restart continuity.pdf',
        status: 'active',
      });

      const loggedOut = await postJson('/identity/logout', undefined, sessionToken);
      expect(loggedOut.status).toBe(201);
    } finally {
      await stopBackend(backend);
      await removeConsumer(consumer);
    }
  }, 30000);
});
