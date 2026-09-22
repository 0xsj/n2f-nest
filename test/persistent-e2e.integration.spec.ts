import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

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

async function resetRegistrationRateLimits(): Promise<void> {
  const databaseUrl = process.env.N2F_DATABASE_URL;
  if (!databaseUrl) return;

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(
      `DELETE FROM public.n2f_rate_limits
       WHERE bucket_key LIKE 'identity.register:%'`,
    );
  } finally {
    await client.end();
  }
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
  it('completes the cross-domain workflow through the running backend', async () => {
    await resetRegistrationRateLimits();

    const email = `persistent-e2e-${randomUUID()}@example.com`;
    const password = 'correct-horse-7';

    const liveness = await jsonRequest('/health/live');
    expect(liveness).toEqual({ status: 200, body: { status: 'live' } });

    const traceResponse = await fetch(`${baseUrl}/health/live`, {
      headers: {
        traceparent:
          '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      },
    });
    expect(traceResponse.status).toBe(200);
    expect(traceResponse.headers.get('traceparent')).toMatch(
      /^00-0123456789abcdef0123456789abcdef-(?!0123456789abcdef)[0-9a-f]{16}-01$/,
    );

    const readiness = await jsonRequest('/health/ready');
    expect(readiness).toEqual({ status: 200, body: { status: 'ready' } });

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get('content-type')).toContain(
      'text/plain',
    );
    expect(await metricsResponse.text()).toContain('n2f_http_requests_total');

    const rateLimitedEmail = `persistent-rate-limit-${randomUUID()}@example.com`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const refusedLogin = await postJson('/identity/login', {
        email: rateLimitedEmail,
        password: 'wrong-password',
      });
      expect(refusedLogin.status).toBe(401);
    }
    const limitedLogin = await postJson('/identity/login', {
      email: rateLimitedEmail,
      password: 'wrong-password',
    });
    expect(limitedLogin.status).toBe(429);
    expect(limitedLogin.body).toMatchObject({
      code: 'rate_limit.exceeded',
      request_id: expect.any(String),
    });

    const unauthenticatedOrganizations = await jsonRequest('/organizations');
    expect(unauthenticatedOrganizations.status).toBe(401);
    expect(unauthenticatedOrganizations.body.request_id).toEqual(
      expect.any(String),
    );

    const registered = await postJson('/identity/register', { email, password });
    expect(registered.status).toBe(201);
    expect(registered.body.status).toBe('pending_verification');

    const duplicateRegistration = await postJson('/identity/register', {
      email,
      password,
    });
    expect(duplicateRegistration.status).toBe(409);

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

    const invalidLogin = await postJson('/identity/login', {
      email,
      password: 'wrong-password',
    });
    expect(invalidLogin.status).toBe(401);

    const loggedIn = await postJson('/identity/login', { email, password });
    expect(loggedIn.status).toBe(201);
    expect(loggedIn.body.identityId).toBe(identityId);

    const sessionToken = loggedIn.body.token as string;
    const current = await jsonRequest('/identity/me', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ identityId, status: 'active' });

    const organization = await postJson(
      '/organizations',
      {
        name: 'Persistent E2E Organization',
        slug: `persistent-${randomUUID().slice(0, 8)}`,
      },
      sessionToken,
    );
    expect(organization.status).toBe(201);
    expect(organization.body).toEqual({
      organizationId: expect.any(String),
      ownerMembershipId: expect.any(String),
    });

    const organizations = await jsonRequest('/organizations', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(organizations.status).toBe(200);
    expect(organizations.body).toEqual([
      {
        organizationId: organization.body.organizationId,
        name: 'Persistent E2E Organization',
        slug: expect.stringMatching(/^persistent-[a-f0-9]{8}$/),
        status: 'active',
        membershipId: organization.body.ownerMembershipId,
        role: 'owner',
        membershipStatus: 'active',
      },
    ]);

    const ownerRoleChange = await jsonRequest(
      `/organizations/${organization.body.organizationId}/memberships/${organization.body.ownerMembershipId}/role`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    expect(ownerRoleChange.status).toBe(403);

    const organizationId = organization.body.organizationId as string;
    const document = await postJson(
      `/organizations/${organizationId}/documents`,
      {
        name: 'Persistent E2E document.pdf',
        storageKey: 'documents/persistent-e2e-document.pdf',
      },
      sessionToken,
    );
    expect(document.status).toBe(201);
    expect(document.body).toEqual({
      documentId: expect.any(String),
      organizationId,
      name: 'Persistent E2E document.pdf',
      storageKey: 'documents/persistent-e2e-document.pdf',
      status: 'active',
    });

    const documentId = document.body.documentId as string;
    const processing = await postJson(
      `/organizations/${organizationId}/documents/${documentId}/process`,
      { maxAttempts: 2 },
      sessionToken,
    );
    expect(processing.status).toBe(201);
    expect(processing.body).toEqual({
      documentId,
      jobId: expect.any(String),
      documentStatus: 'processing',
      jobStatus: 'queued',
      jobCreated: true,
    });

    const repeatedProcessing = await postJson(
      `/organizations/${organizationId}/documents/${documentId}/process`,
      { maxAttempts: 2 },
      sessionToken,
    );
    expect(repeatedProcessing).toEqual({
      status: 201,
      body: {
        documentId,
        jobId: processing.body.jobId,
        documentStatus: 'processing',
        jobStatus: 'queued',
        jobCreated: false,
      },
    });

    const processingJobId = processing.body.jobId as string;
    const started = await postJson(
      `/organizations/${organizationId}/jobs/${processingJobId}/start`,
      undefined,
      sessionToken,
    );
    expect(started.status).toBe(200);

    const completed = await postJson(
      `/organizations/${organizationId}/jobs/${processingJobId}/complete`,
      undefined,
      sessionToken,
    );
    expect(completed.status).toBe(200);

    const processed = await eventually(
      async () =>
        jsonRequest(
          `/organizations/${organizationId}/documents/${documentId}`,
          { headers: { authorization: `Bearer ${sessionToken}` } },
        ),
      (response) =>
        response.status === 200 && response.body.status === 'processed',
    );
    expect(processed.body.status).toBe('processed');

    const archived = await postJson(
      `/organizations/${organizationId}/documents/${documentId}/archive`,
      undefined,
      sessionToken,
    );
    expect(archived.status).toBe(200);
    expect(archived.body).toEqual({
      documentId,
      status: 'archived',
      archivedAt: expect.any(String),
    });

    const memberEmail = `persistent-member-${randomUUID()}@example.com`;
    const memberPassword = 'correct-horse-7';
    const memberRegistered = await postJson('/identity/register', {
      email: memberEmail,
      password: memberPassword,
    });
    expect(memberRegistered.status).toBe(201);

    const memberIdentityId = memberRegistered.body.identityId as string;
    const memberChallenge = await postJson('/identity/verification-challenges', {
      identityId: memberIdentityId,
    });
    expect(memberChallenge.status).toBe(201);

    const memberVerified = await postJson('/identity/verify', {
      challengeId: memberChallenge.body.challengeId,
      token: memberChallenge.body.token,
    });
    expect(memberVerified).toEqual({
      status: 201,
      body: { identityId: memberIdentityId, status: 'active' },
    });

    const invitation = await postJson(
      `/organizations/${organizationId}/invitations`,
      { identityId: memberIdentityId, role: 'member' },
      sessionToken,
    );
    expect(invitation.status).toBe(201);
    expect(invitation.body).toMatchObject({
      invitationId: expect.any(String),
      identityId: memberIdentityId,
      role: 'member',
      status: 'pending',
      expiresAt: expect.any(String),
    });

    const memberLoggedIn = await postJson('/identity/login', {
      email: memberEmail,
      password: memberPassword,
    });
    expect(memberLoggedIn.status).toBe(201);
    const memberSessionToken = memberLoggedIn.body.token as string;

    const accepted = await postJson(
      `/organizations/${organizationId}/invitations/${invitation.body.invitationId}/accept`,
      undefined,
      memberSessionToken,
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({
      invitationId: invitation.body.invitationId,
      membershipId: expect.any(String),
      organizationId,
      identityId: memberIdentityId,
      role: 'member',
    });

    const memberOrganizations = await jsonRequest('/organizations', {
      headers: { authorization: `Bearer ${memberSessionToken}` },
    });
    expect(memberOrganizations.status).toBe(200);
    expect(memberOrganizations.body).toEqual([
      {
        organizationId,
        name: 'Persistent E2E Organization',
        slug: expect.stringMatching(/^persistent-[a-f0-9]{8}$/),
        status: 'active',
        membershipId: accepted.body.membershipId,
        role: 'member',
        membershipStatus: 'active',
      },
    ]);

    const memberDocument = await jsonRequest(
      `/organizations/${organizationId}/documents/${documentId}`,
      { headers: { authorization: `Bearer ${memberSessionToken}` } },
    );
    expect(memberDocument.status).toBe(200);
    expect(memberDocument.body).toMatchObject({
      documentId,
      status: 'archived',
    });

    const revokedMembership = await jsonRequest(
      `/organizations/${organizationId}/memberships/${accepted.body.membershipId}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${sessionToken}` },
      },
    );
    expect(revokedMembership).toEqual({
      status: 200,
      body: { membershipId: accepted.body.membershipId, status: 'revoked' },
    });

    const revokedMemberOrganizations = await jsonRequest('/organizations', {
      headers: { authorization: `Bearer ${memberSessionToken}` },
    });
    expect(revokedMemberOrganizations).toEqual({ status: 200, body: [] });

    const revokedMemberDocument = await jsonRequest(
      `/organizations/${organizationId}/documents/${documentId}`,
      { headers: { authorization: `Bearer ${memberSessionToken}` } },
    );
    expect(revokedMemberDocument.status).toBe(403);

    const revokedMemberDocuments = await jsonRequest(
      `/organizations/${organizationId}/documents`,
      { headers: { authorization: `Bearer ${memberSessionToken}` } },
    );
    expect(revokedMemberDocuments.status).toBe(403);

    const revokedMemberJobs = await jsonRequest(
      `/organizations/${organizationId}/jobs`,
      { headers: { authorization: `Bearer ${memberSessionToken}` } },
    );
    expect(revokedMemberJobs.status).toBe(403);

    const revokedMemberTransition = await postJson(
      `/organizations/${organizationId}/jobs/${processingJobId}/start`,
      undefined,
      memberSessionToken,
    );
    expect(revokedMemberTransition.status).toBe(403);

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
      'organization.created.v1',
      'organization.membership.added.v1',
      'document.created.v1',
      'document.archived.v1',
    ];
    const audit = await eventually(
      async () => jsonRequest('/audit/entries'),
      (response) =>
        response.status === 200 &&
        expectedEventTypes.every((eventType) =>
          response.body.some(
            (entry: { eventType?: string; subject?: { id?: string } }) =>
              entry.eventType === eventType &&
              entry.subject?.id === identityId,
          ),
        ),
    );

    const identityAudit = audit.body.filter(
      (entry: { subject?: { id?: string } }) => entry.subject?.id === identityId,
    );
    const identityEventTypes = identityAudit.map(
      (entry: { eventType: string }) => entry.eventType,
    );
    for (const eventType of expectedEventTypes) {
      expect(identityEventTypes).toContain(eventType);
    }

    const workflowAudit = await eventually(
      async () => jsonRequest('/audit/entries'),
      (response) =>
        response.status === 200 &&
        ['document.processing.started.v1', 'document.processing.completed.v1'].every(
          (eventType) =>
            response.body.some(
              (entry: { eventType?: string; subject?: { id?: string } }) =>
                entry.eventType === eventType && entry.subject?.id === documentId,
            ),
        ),
    );
    expect(
      workflowAudit.body.filter(
        (entry: { eventType?: string; subject?: { id?: string } }) =>
          entry.subject?.id === documentId &&
          [
            'document.processing.started.v1',
            'document.processing.completed.v1',
          ].includes(entry.eventType ?? ''),
      ),
    ).toHaveLength(2);

    const memberEventTypes = [
      'organization.invitation.created.v1',
      'organization.invitation.accepted.v1',
      'organization.membership.added.v1',
      'organization.membership.revoked.v1',
    ];
    const memberAudit = await eventually(
      async () => jsonRequest('/audit/entries'),
      (response) =>
        response.status === 200 &&
        memberEventTypes.every((eventType) =>
          response.body.some(
            (entry: { eventType?: string; subject?: { id?: string } }) =>
              entry.eventType === eventType &&
              entry.subject?.id === memberIdentityId,
          ),
        ),
    );
    const observedMemberEventTypes = memberAudit.body
      .filter(
        (entry: { eventType?: string; subject?: { id?: string } }) =>
          entry.subject?.id === memberIdentityId,
      )
      .map((entry: { eventType: string }) => entry.eventType);
    for (const eventType of memberEventTypes) {
      expect(observedMemberEventTypes).toContain(eventType);
    }
  }, 15000);
});
