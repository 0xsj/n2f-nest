import {
  err,
  ok,
  typedFailure,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { PASSWORD_MAX_LENGTH } from '../ports/password-policy.js';
import { IDENTITY_EVENT_TYPES } from '../../domain/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import { normalizeEmail, Session } from '../../domain/index.js';
import type {
  ActiveSessionReader,
  CredentialAuthenticatorReader,
  PasswordVerifier,
  SessionEviction,
  SessionPolicy,
  SessionTokenIssuer,
  SessionWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type IdentityApplicationFailure,
} from '../failures.js';

export type AuthenticateIdentityCommand = Readonly<{
  email: unknown;
  password: SecretString;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type AuthenticateIdentityResult = Readonly<{
  identityId: ID;
  sessionId: ID;
  token: SecretString;
  expiresAt: Date;
}>;

export type AuthenticateIdentityDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  credentials: CredentialAuthenticatorReader;
  passwords: PasswordVerifier;
  sessions: SessionPolicy;
  active: ActiveSessionReader;
  tokens: SessionTokenIssuer;
  writer: SessionWriter;
}>;

function invalidCredentials(): IdentityApplicationFailure {
  return typedFailure(
    'unauthenticated',
    'identity.invalid_credentials',
    'credentials are invalid',
  );
}

export class AuthenticateIdentity {
  constructor(
    private readonly dependencies: AuthenticateIdentityDependencies,
  ) {}

  async execute(
    command: AuthenticateIdentityCommand,
  ): Promise<Result<AuthenticateIdentityResult, IdentityApplicationFailure>> {
    // Do not spend password-verifier work on an input outside Identity's
    // credential contract. Login still returns the same public refusal as any
    // other invalid credential so callers cannot distinguish this guard.
    if (command.password.reveal().length > PASSWORD_MAX_LENGTH) {
      return err(invalidCredentials());
    }

    const email = normalizeEmail(command.email);

    if (!email.ok) {
      return err(invalidCredentials());
    }

    const record = await this.dependencies.credentials.findByEmail(
      email.value,
      command.signal,
    );

    if (!record.ok) {
      return err(dependencyFailure(record.error, 'credential_reader'));
    }

    // Verify before looking at account state, and verify a decoy when there
    // is no credential, so every refusal costs the same password work and
    // response time does not reveal which emails exist or are active.
    const password =
      record.value === null
        ? await this.dependencies.passwords.verifyDecoy(command.password, command.signal)
        : await this.dependencies.passwords.verify(
            command.password,
            record.value.passwordHash,
            command.signal,
          );

    if (!password.ok) {
      return err(dependencyFailure(password.error, 'password_verifier'));
    }

    if (
      !password.value ||
      record.value === null ||
      record.value.identity.status !== 'active' ||
      record.value.credential.status !== 'active'
    ) {
      return err(invalidCredentials());
    }

    const createdAt = this.dependencies.clock.now();
    const expiresAt = this.dependencies.sessions.expiresAt(createdAt);

    if (!expiresAt.ok) {
      return err(dependencyFailure(expiresAt.error, 'session_policy'));
    }

    const sessionId = this.dependencies.ids.newId();

    if (!sessionId.ok) {
      return err(idGenerationFailure(sessionId.error));
    }

    const session = Session.create({
      id: sessionId.value,
      identityId: record.value.identity.id,
      createdAt,
      expiresAt: expiresAt.value,
    });

    if (!session.ok) {
      return session;
    }

    const token = await this.dependencies.tokens.issue(command.signal);

    if (!token.ok) {
      return err(dependencyFailure(token.error, 'session_token_issuer'));
    }

    const eventId = this.dependencies.ids.newId();

    if (!eventId.ok) {
      return err(idGenerationFailure(eventId.error));
    }

    const event = Envelope.create(
      eventId.value,
      IDENTITY_EVENT_TYPES.sessionCreated,
      createdAt.getTime(),
      command.work,
      {
        identity_id: record.value.identity.id,
        credential_id: record.value.credential.id,
        session_id: session.value.id,
        expires_at_ms: session.value.expiresAt.getTime(),
      },
      { kind: 'identity', id: record.value.identity.id },
    );

    if (!event.ok) {
      return err(dependencyFailure(event.error, 'session_created_event'));
    }

    const evicted = await this.evictions(session.value, command);

    if (!evicted.ok) {
      return evicted;
    }

    const committed = await this.dependencies.writer.commit(
      {
        session: session.value,
        credential: record.value.credential,
        tokenDigest: token.value.digest,
        event: event.value,
        evicted: evicted.value,
        work: command.work,
      },
      command.signal,
    );

    if (!committed.ok) {
      return err(dependencyFailure(committed.error, 'session_writer'));
    }

    return ok({
      identityId: record.value.identity.id,
      sessionId: session.value.id,
      token: token.value.token,
      expiresAt: session.value.expiresAt,
    });
  }

  /**
   * The sessions this login revokes so the identity keeps at most
   * `maxActivePerIdentity`: the oldest still-usable ones. Sessions that can no
   * longer authenticate do not count; pruning removes them. Two concurrent
   * logins may each see room and briefly exceed the cap by one; the next
   * login restores it.
   */
  private async evictions(
    created: Session,
    command: AuthenticateIdentityCommand,
  ): Promise<Result<SessionEviction[], IdentityApplicationFailure>> {
    const policy = this.dependencies.sessions;
    const active = await this.dependencies.active.listActive(created.identityId, command.signal);

    if (!active.ok) {
      return err(dependencyFailure(active.error, 'active_session_reader'));
    }

    const at = created.createdAt;
    const usable = active.value
      .filter((candidate) => candidate.assertUsable(at, policy.idleTimeoutMs).ok)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const evictions: SessionEviction[] = [];

    for (const stale of usable.slice(Math.max(0, policy.maxActivePerIdentity - 1))) {
      const revoked = stale.revoke(at);
      if (!revoked.ok) return revoked;
      const eventId = this.dependencies.ids.newId();
      if (!eventId.ok) return err(idGenerationFailure(eventId.error));
      const event = Envelope.create(
        eventId.value,
        IDENTITY_EVENT_TYPES.sessionRevoked,
        at.getTime(),
        command.work,
        {
          identity_id: revoked.value.identityId,
          session_id: revoked.value.id,
          status: revoked.value.status,
          reason: 'session_limit',
        },
        { kind: 'identity', id: revoked.value.identityId },
      );
      if (!event.ok) return err(dependencyFailure(event.error, 'session_revoked_event'));
      evictions.push({ session: revoked.value, event: event.value });
    }

    return ok(evictions);
  }
}
