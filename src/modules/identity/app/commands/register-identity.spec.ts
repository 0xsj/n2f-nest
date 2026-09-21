import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../shared/clock/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID, type IDGenerator } from '../../../../shared/id/index.js';
import {
  anonymous,
  attribution,
  operation,
  restoreWork,
} from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type { Credential, Identity } from '../../domain/index.js';
import {
  RegisterIdentity,
  type RegisterIdentityCommand,
} from './register-identity.js';
import type {
  PasswordHasher,
  PasswordPolicy,
  RegistrationWriter,
} from '../ports/index.js';

const ids = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
].map((value) => parse(value));

if (ids.some((result) => !result.ok)) {
  throw new Error('test IDs should be valid');
}

const validIds: ID[] = ids.map((result) => {
  if (!result.ok) throw new Error('test ID should be valid');
  return result.value;
});

class TestIds implements IDGenerator {
  private position = 0;

  newId(): Result<ID, Failure> {
    const value = validIds[this.position++];

    return value === undefined
      ? err(failure('unavailable', 'test IDs exhausted', { type: 'test.ids' }))
      : ok(value);
  }
}

class AllowPassword implements PasswordPolicy {
  validate(): Result<void, Failure> {
    return ok(undefined);
  }
}

class TestHasher implements PasswordHasher {
  received: string | undefined;

  async hash(
    password: SecretString,
  ): Promise<Result<SecretString, Failure>> {
    this.received = password.reveal();
    return ok(new SecretString('argon2-test-hash'));
  }
}

class TestWriter implements RegistrationWriter {
  input:
    | Readonly<{
        identity: Identity;
        credential: Credential;
        passwordHash: SecretString;
        event: Envelope;
      }>
    | undefined;

  async commit(input: {
    identity: Identity;
    credential: Credential;
    passwordHash: SecretString;
    event: Envelope;
  }): Promise<Result<void, Failure>> {
    this.input = input;
    return ok(undefined);
  }
}

function workContext() {
  const result = restoreWork({
    workId: validIds[0]!,
    correlationId: validIds[1]!,
    correlationSource: 'local',
    operation: operation('identity.register').value,
    attribution: attribution({ initiator: anonymous() }).value,
    origin: 'request',
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

function command(): RegisterIdentityCommand {
  return {
    email: ' Artist@Example.com ',
    password: new SecretString('correct horse battery staple'),
    work: workContext(),
  };
}

function setup() {
  const hasher = new TestHasher();
  const writer = new TestWriter();
  const useCase = new RegisterIdentity({
    clock: new FakeClock(new Date('2026-09-19T00:00:00.000Z')),
    ids: new TestIds(),
    passwordPolicy: new AllowPassword(),
    passwordHasher: hasher,
    writer,
  });

  return { hasher, writer, useCase };
}

describe('RegisterIdentity', () => {
  it('composes the domain, hashes the password and commits one registration', async () => {
    const { hasher, writer, useCase } = setup();

    const result = await useCase.execute(command());

    expect(result.ok).toBe(true);
    expect(hasher.received).toBe('correct horse battery staple');
    expect(writer.input?.identity.status).toBe('pending_verification');
    expect(writer.input?.credential.email).toBe('artist@example.com');
    expect(writer.input?.passwordHash.reveal()).toBe('argon2-test-hash');
  });

  it('records provenance on the event while excluding secret material', async () => {
    const { writer, useCase } = setup();

    await useCase.execute(command());

    const input = writer.input;
    expect(input).toBeDefined();

    if (!input) {
      return;
    }

    const raw = JSON.parse(new TextDecoder().decode(input.event.bytes())) as {
      type: string;
      work: { operation: string; attribution: { initiator: unknown } };
      payload: Record<string, unknown>;
    };

    expect(raw.type).toBe('identity.registered.v1');
    expect(raw.work.operation).toBe('identity.register');
    expect(raw.work.attribution.initiator).toEqual({ kind: 'anonymous' });
    expect(raw.payload).not.toHaveProperty('password');
    expect(raw.payload).not.toHaveProperty('password_hash');
    expect(raw.payload).not.toHaveProperty('email');
  });

  it('stops before hashing when password policy rejects the password', async () => {
    const hasher = new TestHasher();
    const writer = new TestWriter();
    const useCase = new RegisterIdentity({
      clock: new FakeClock(new Date('2026-09-19T00:00:00.000Z')),
      ids: new TestIds(),
      passwordPolicy: {
        validate: () =>
          err(
            failure('invalid', 'password policy rejected', {
              type: 'identity.password_policy',
            }),
          ),
      },
      passwordHasher: hasher,
      writer,
    });

    const result = await useCase.execute(command());

    expect(result.ok).toBe(false);
    expect(hasher.received).toBeUndefined();
    expect(writer.input).toBeUndefined();
  });

  it('does not write when hashing fails', async () => {
    const writer = new TestWriter();
    const useCase = new RegisterIdentity({
      clock: new FakeClock(new Date('2026-09-19T00:00:00.000Z')),
      ids: new TestIds(),
      passwordPolicy: new AllowPassword(),
      passwordHasher: {
        hash: async () =>
          err(
            failure('unavailable', 'password hashing failed', {
              type: 'identity.password_hashing',
            }),
          ),
      },
      writer,
    });

    const result = await useCase.execute(command());

    expect(result.ok).toBe(false);
    expect(writer.input).toBeUndefined();
  });
});
