import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const enabled = process.env.N2F_RUN_PERSISTENT_E2E === '1';
const integration = enabled ? describe : describe.skip;
const baseUrl = process.env.N2F_E2E_BASE_URL ?? 'http://127.0.0.1:7300';

type JsonResponse = {
  status: number;
  body: any;
};

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

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();

  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }

  expect(ready(value)).toBe(true);
  return value;
}

integration('Persistent HTTP E2E', () => {
  it('completes identity and audit delivery through the running backend', async () => {
    const email = `persistent-e2e-${randomUUID()}@example.com`;
    const password = 'correct-horse-7';

    const registered = await postJson('/identity/register', { email, password });
    expect(registered.status).toBe(201);
    expect(registered.body.status).toBe('pending_verification');

    const identityId = registered.body.identityId as string;
    const challenge = await postJson('/identity/verification-challenges', {
      identityId,
    });
    expect(challenge.status).toBe(201);

    const verified = await postJson('/identity/verify', {
      challengeId: challenge.body.challengeId,
      token: challenge.body.token,
    });
    expect(verified).toEqual({
      status: 201,
      body: { identityId, status: 'active' },
    });

    const loggedIn = await postJson('/identity/login', { email, password });
    expect(loggedIn.status).toBe(201);
    expect(loggedIn.body.identityId).toBe(identityId);

    const sessionToken = loggedIn.body.token as string;
    const current = await jsonRequest('/identity/me', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ identityId, status: 'active' });

    const loggedOut = await postJson('/identity/logout', undefined, sessionToken);
    expect(loggedOut).toEqual({
      status: 201,
      body: { sessionId: loggedIn.body.sessionId, revoked: true },
    });

    const revoked = await jsonRequest('/identity/me', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('session.revoked');

    const expectedEventTypes = [
      'identity.registered.v1',
      'identity.verification.challenge.issued.v1',
      'identity.verified.v1',
      'identity.session.created.v1',
      'identity.session.revoked.v1',
    ];
    const audit = await eventually(
      async () => jsonRequest('/audit/entries'),
      (response) =>
        response.status === 200 &&
        expectedEventTypes.every((eventType) =>
          response.body.some(
            (entry: { eventType?: string; subject?: { id?: string } }) =>
              entry.eventType === eventType && entry.subject?.id === identityId,
          ),
        ),
    );

    const identityAudit = audit.body.filter(
      (entry: { subject?: { id?: string } }) => entry.subject?.id === identityId,
    );
    expect(identityAudit.map((entry: { eventType: string }) => entry.eventType).sort()).toEqual(
      expectedEventTypes.sort(),
    );
  }, 15000);
});
