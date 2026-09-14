/**
 * Identity PostgreSQL store; see CONTRACT.md (S01–S16). One transaction per
 * mutation, locks in the S04 order, guarded updates, outbox rows on the same
 * client. pg types never leave this directory.
 * @module modules/identity/infra/postgres
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/store.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { Database, type Migration } from '../../../../shared/postgres/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { AuthState } from '../../domain/auth-state.js';
import { MAX_VERSION } from '../../domain/bounds.js';
import { Challenge, type ChallengeSnapshot } from '../../domain/challenge.js';
import {
  PasswordCredential,
  type CredentialSnapshot,
} from '../../domain/credential.js';
import { Email } from '../../domain/email.js';
import {
  Principal,
  type Snapshot as PrincipalSnapshot,
  type Status,
} from '../../domain/principal.js';
import { Session } from '../../domain/session.js';
import { TokenDigest, type TokenPurpose } from '../../domain/token.js';
import { UpgradeTicket, type UpgradeTicketSnapshot } from '../../domain/upgrade-ticket.js';
import type {
  ChallengeRecord,
  ChangePasswordRecord,
  CredentialRecord,
  IssueChallengeRecord,
  LoginRecord,
  RegisterRecord,
  ResetPasswordRecord,
  UpgradeTicketAdmission,
  UpgradeTicketRecord,
  Store as StorePorts,
  VerifyRecord,
} from '../../app/command/ports.js';
import type { Resolution, SessionResolver } from '../../app/query/index.js';

export const migration = (version: number): Migration => ({
  version,
  sql: readFileSync(
    new URL('./migrations/0001_identity.sql', import.meta.url),
    'utf8',
  ),
});
export const upgradeTicketMigration = (version: number): Migration => ({
  version,
  sql: readFileSync(new URL('./migrations/0002_upgrade_tickets.sql', import.meta.url), 'utf8'),
});

/** Private marker: the transaction rolled back and the outcome is a value. */
const ROLLBACK = 'identity.store_rollback';
const rollbackWith = <O extends string>(outcome: O): Result<never, Failure> =>
  err(
    failure('internal', 'rolled back with outcome', {
      type: ROLLBACK,
      fields: { outcome },
    }),
  );
const settle = <O extends string>(r: Result<O, Failure>): Result<O, Failure> =>
  !r.ok && r.error.type === ROLLBACK ? ok(r.error.fields!.outcome as O) : r;
const corrupt = (domainType: string | undefined): Failure =>
  failure('internal', 'corrupt identity record', {
    type: 'identity.record_corrupt',
    fields: { domain_type: domainType ?? 'unknown' },
  });
/** A stored row the domain refuses is corruption (S05); hash faults keep their type. */
const restored = <T>(r: Result<T, Failure>): Result<T, Failure> =>
  r.ok || r.error.type === 'identity.credential_corrupt'
    ? r
    : err(corrupt(r.error.type));
const guardFailed = (): Failure =>
  failure('internal', 'guarded update affected no row under lock', {
    type: 'identity.record_corrupt',
    fields: { domain_type: 'guard' },
  });

type Client = pg.PoolClient;
type PrincipalRow = {
  id: string;
  kind: string;
  display_name: string;
  status: string;
  created_at_ms: string;
  updated_at_ms: string;
  version: number;
};
type CredentialRow = {
  principal_id: string;
  canonical_email: string;
  password_hash: string;
  verified_at_ms: string | null;
  password_version: number;
  created_at_ms: string;
  changed_at_ms: string;
};
type SessionRow = {
  id: string;
  principal_id: string;
  token_digest: Buffer;
  auth_epoch: number;
  issued_at_ms: string;
  last_seen_at_ms: string;
  absolute_expires_at_ms: string;
  idle_expires_at_ms: string;
  revoked_at_ms: string | null;
};
type ChallengeRow = {
  id: string;
  principal_id: string;
  purpose: string;
  token_digest: Buffer;
  password_version: number;
  issued_at_ms: string;
  expires_at_ms: string;
  consumed_at_ms: string | null;
  invalidated_at_ms: string | null;
};
type UpgradeTicketRow = {
  id: string;
  session_id: string;
  token_digest: Buffer;
  issued_at_ms: string;
  expires_at_ms: string;
  consumed_at_ms: string | null;
};
const PRINCIPAL =
  'id, kind, display_name, status, created_at_ms, updated_at_ms, version';
const CREDENTIAL =
  'principal_id, canonical_email, password_hash, verified_at_ms, password_version, created_at_ms, changed_at_ms';
const SESSION =
  'id, principal_id, token_digest, auth_epoch, issued_at_ms, last_seen_at_ms, absolute_expires_at_ms, idle_expires_at_ms, revoked_at_ms';
const SESSION_JOIN =
  's.id, s.principal_id, s.token_digest, s.auth_epoch, s.issued_at_ms, s.last_seen_at_ms, s.absolute_expires_at_ms, s.idle_expires_at_ms, s.revoked_at_ms';
const CHALLENGE =
  'id, principal_id, purpose, token_digest, password_version, issued_at_ms, expires_at_ms, consumed_at_ms, invalidated_at_ms';
const UPGRADE_TICKET =
  'id, session_id, token_digest, issued_at_ms, expires_at_ms, consumed_at_ms';
const ms = (v: string | number): number => Number(v);
const optional = (v: string | null): number | undefined =>
  v === null ? undefined : Number(v);
const uuid = (v: string): ID => {
  const id = parse(v);
  if (!id.ok) throw new TypeError('stored uuid is not a valid ID');
  return id.value;
};

function principalOf(row: PrincipalRow): Result<PrincipalSnapshot, Failure> {
  const r = restored(
    Principal.restore({
      id: uuid(row.id),
      kind: row.kind as PrincipalSnapshot['kind'],
      displayName: row.display_name,
      status: row.status as Status,
      createdAtMs: ms(row.created_at_ms),
      updatedAtMs: ms(row.updated_at_ms),
      version: row.version,
    }),
  );
  return r.ok ? ok(r.value.snapshot()) : r;
}
function credentialOf(row: CredentialRow): Result<CredentialSnapshot, Failure> {
  const email = Email.parse(row.canonical_email);
  if (!email.ok || email.value.reveal() !== row.canonical_email)
    return err(corrupt('identity.credential_invalid'));
  const verified = optional(row.verified_at_ms);
  const r = restored(
    PasswordCredential.restore({
      principalId: uuid(row.principal_id),
      email: email.value,
      passwordHash: new SecretString(row.password_hash),
      passwordVersion: row.password_version,
      createdAtMs: ms(row.created_at_ms),
      changedAtMs: ms(row.changed_at_ms),
      ...(verified === undefined ? {} : { verifiedAtMs: verified }),
    }),
  );
  return r.ok ? ok(r.value.snapshot()) : r;
}
function digestOf(purpose: string, data: Buffer): Result<TokenDigest, Failure> {
  return restored(
    TokenDigest.parse(purpose as TokenPurpose, Uint8Array.from(data)),
  );
}
function sessionOf(row: SessionRow): Result<Session, Failure> {
  const digest = digestOf('session', row.token_digest);
  if (!digest.ok) return digest;
  const revoked = optional(row.revoked_at_ms);
  return restored(
    Session.restore({
      id: uuid(row.id),
      principalId: uuid(row.principal_id),
      tokenDigest: digest.value,
      authEpoch: row.auth_epoch,
      issuedAtMs: ms(row.issued_at_ms),
      lastSeenAtMs: ms(row.last_seen_at_ms),
      absoluteExpiresAtMs: ms(row.absolute_expires_at_ms),
      idleExpiresAtMs: ms(row.idle_expires_at_ms),
      ...(revoked === undefined ? {} : { revokedAtMs: revoked }),
    }),
  );
}
function challengeOf(row: ChallengeRow): Result<ChallengeSnapshot, Failure> {
  const digest = digestOf(row.purpose, row.token_digest);
  if (!digest.ok) return digest;
  const consumed = optional(row.consumed_at_ms);
  const invalidated = optional(row.invalidated_at_ms);
  const r = restored(
    Challenge.restore({
      id: uuid(row.id),
      principalId: uuid(row.principal_id),
      tokenDigest: digest.value,
      passwordVersion: row.password_version,
      issuedAtMs: ms(row.issued_at_ms),
      expiresAtMs: ms(row.expires_at_ms),
      ...(consumed === undefined ? {} : { consumedAtMs: consumed }),
      ...(invalidated === undefined ? {} : { invalidatedAtMs: invalidated }),
    }),
  );
  return r.ok ? ok(r.value.snapshot()) : r;
}
function upgradeTicketOf(row: UpgradeTicketRow): Result<UpgradeTicketSnapshot, Failure> {
  const digest = digestOf('websocket_upgrade', row.token_digest);
  if (!digest.ok) return digest;
  const consumed = optional(row.consumed_at_ms);
  const r = restored(
    UpgradeTicket.restore({
      id: uuid(row.id),
      sessionId: uuid(row.session_id),
      tokenDigest: digest.value,
      issuedAtMs: ms(row.issued_at_ms),
      expiresAtMs: ms(row.expires_at_ms),
      ...(consumed === undefined ? {} : { consumedAtMs: consumed }),
    }),
  );
  return r.ok ? ok(r.value.snapshot()) : r;
}

type Locked = {
  epoch: number;
  principal: PrincipalSnapshot;
  credential?: CredentialSnapshot;
};
/** Locks auth state, principal and credential in the S04 order; undefined when the principal is unknown. */
async function lock(
  tx: Client,
  principalId: ID,
): Promise<Result<Locked | undefined, Failure>> {
  const state = await tx.query<{ auth_epoch: number }>(
    'SELECT auth_epoch FROM public.n2f_identity_auth_states WHERE principal_id=$1::uuid FOR UPDATE',
    [principalId],
  );
  if (state.rowCount !== 1) return ok(undefined);
  const principalRow = await tx.query<PrincipalRow>(
    `SELECT ${PRINCIPAL} FROM public.n2f_identity_principals WHERE id=$1::uuid FOR UPDATE`,
    [principalId],
  );
  if (principalRow.rowCount !== 1) return ok(undefined);
  const principal = principalOf(principalRow.rows[0]);
  if (!principal.ok) return principal;
  const credentialRow = await tx.query<CredentialRow>(
    `SELECT ${CREDENTIAL} FROM public.n2f_identity_credentials WHERE principal_id=$1::uuid FOR UPDATE`,
    [principalId],
  );
  if (credentialRow.rowCount !== 1)
    return ok({ epoch: state.rows[0].auth_epoch, principal: principal.value });
  const credential = credentialOf(credentialRow.rows[0]);
  if (!credential.ok) return credential;
  return ok({
    epoch: state.rows[0].auth_epoch,
    principal: principal.value,
    credential: credential.value,
  });
}
async function publish(
  tx: Client,
  events: readonly Envelope[],
): Promise<Result<void, Failure>> {
  for (const event of events) {
    const queued = await enqueue(tx, event);
    if (!queued.ok) return queued;
  }
  return ok(undefined);
}
async function guarded(
  tx: Client,
  text: string,
  params: unknown[],
): Promise<Result<void, Failure>> {
  const r = await tx.query(text, params);
  return r.rowCount === 1 ? ok(undefined) : err(guardFailed());
}
/** Invalidates every outstanding challenge of the principal; a purpose narrows it. */
const invalidateOutstanding = (
  tx: Client,
  principalId: ID,
  at: number,
  purpose?: TokenPurpose,
) =>
  tx.query(
    'UPDATE public.n2f_identity_challenges SET invalidated_at_ms=$2 WHERE principal_id=$1::uuid AND consumed_at_ms IS NULL AND invalidated_at_ms IS NULL' +
      (purpose ? ' AND purpose=$3' : ''),
    purpose ? [principalId, at, purpose] : [principalId, at],
  );
/** Consumes one challenge under the S12 guard; false when no row qualified. */
async function consume(
  tx: Client,
  challengeId: ID,
  principalId: ID,
  purpose: TokenPurpose,
  at: number,
): Promise<boolean> {
  const r = await tx.query(
    'UPDATE public.n2f_identity_challenges SET consumed_at_ms=$3 WHERE id=$1::uuid AND principal_id=$2::uuid AND purpose=$4 AND consumed_at_ms IS NULL AND invalidated_at_ms IS NULL AND issued_at_ms<=$3 AND $3<expires_at_ms',
    [challengeId, principalId, at, purpose],
  );
  return r.rowCount === 1;
}
/** Replaces the hash and increments version and epoch; the caller has locked and rechecked. */
async function replacePassword(
  tx: Client,
  locked: Locked,
  hash: SecretString,
  changedAt: number,
  verifiedAt?: number,
): Promise<Result<void, Failure>> {
  const credential = locked.credential!;
  if (credential.passwordVersion >= MAX_VERSION)
    return err(
      failure('conflict', 'password version exhausted', {
        type: 'identity.version_exhausted',
      }),
    );
  const state = AuthState.create(locked.principal.id, locked.epoch);
  if (!state.ok) return err(corrupt(state.error.type));
  const next = state.value.invalidate(locked.epoch);
  if (!next.ok) return next;
  const updated = await guarded(
    tx,
    'UPDATE public.n2f_identity_credentials SET password_hash=$2, password_version=password_version+1, changed_at_ms=$3, verified_at_ms=CASE WHEN $4::bigint IS NULL THEN verified_at_ms ELSE COALESCE(verified_at_ms,$4::bigint) END WHERE principal_id=$1::uuid AND password_version=$5',
    [
      locked.principal.id,
      hash.reveal(),
      changedAt,
      verifiedAt ?? null,
      credential.passwordVersion,
    ],
  );
  if (!updated.ok) return updated;
  const epoch = await guarded(
    tx,
    'UPDATE public.n2f_identity_auth_states SET auth_epoch=$2 WHERE principal_id=$1::uuid AND auth_epoch=$3',
    [locked.principal.id, next.value.epoch(), locked.epoch],
  );
  if (!epoch.ok) return epoch;
  await invalidateOutstanding(tx, locked.principal.id, changedAt);
  return ok(undefined);
}

export class Store implements StorePorts, SessionResolver {
  constructor(readonly database: Database) {}

  private read<T>(
    fn: (tx: Client) => Promise<Result<T, Failure>>,
  ): Promise<Result<T, Failure>> {
    return this.database.transaction(fn);
  }
  private async mutate<O extends string>(
    fn: (tx: Client) => Promise<Result<O, Failure>>,
  ): Promise<Result<O, Failure>> {
    return settle(await this.database.transaction(fn));
  }

  register(
    record: RegisterRecord,
  ): Promise<Result<'created' | 'duplicate_email', Failure>> {
    return this.mutate(async (tx) => {
      const p = record.principal,
        c = record.credential,
        ch = record.challenge;
      await tx.query(
        `INSERT INTO public.n2f_identity_principals(${PRINCIPAL}) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
        [
          p.id,
          p.kind,
          p.displayName,
          p.status,
          p.createdAtMs,
          p.updatedAtMs,
          p.version,
        ],
      );
      await tx.query(
        'INSERT INTO public.n2f_identity_auth_states(principal_id, auth_epoch) VALUES ($1::uuid,$2)',
        [p.id, record.authEpoch],
      );
      try {
        await tx.query(
          `INSERT INTO public.n2f_identity_credentials(${CREDENTIAL}) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
          [
            c.principalId,
            c.email.reveal(),
            c.passwordHash.reveal(),
            c.verifiedAtMs ?? null,
            c.passwordVersion,
            c.createdAtMs,
            c.changedAtMs,
          ],
        );
      } catch (e) {
        if (
          e instanceof pg.DatabaseError &&
          e.code === '23505' &&
          e.constraint === 'n2f_identity_credentials_canonical_email_key'
        )
          return rollbackWith('duplicate_email');
        throw e;
      }
      await tx.query(
        `INSERT INTO public.n2f_identity_challenges(${CHALLENGE}) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ch.id,
          ch.principalId,
          ch.tokenDigest.purpose(),
          Buffer.from(ch.tokenDigest.bytes()),
          ch.passwordVersion,
          ch.issuedAtMs,
          ch.expiresAtMs,
          ch.consumedAtMs ?? null,
          ch.invalidatedAtMs ?? null,
        ],
      );
      const published = await publish(tx, record.events);
      return published.ok ? ok('created' as const) : published;
    });
  }

  private credentialRecord(
    where: string,
    param: string,
  ): Promise<Result<CredentialRecord | undefined, Failure>> {
    return this.read(async (tx) => {
      const r = await tx.query<
        PrincipalRow & {
          auth_epoch: number;
          canonical_email: string;
          password_hash: string;
          verified_at_ms: string | null;
          password_version: number;
          c_created_at_ms: string;
          changed_at_ms: string;
          principal_id: string;
        }
      >(
        `SELECT p.id, p.kind, p.display_name, p.status, p.created_at_ms, p.updated_at_ms, p.version, a.auth_epoch, c.principal_id, c.canonical_email, c.password_hash, c.verified_at_ms, c.password_version, c.created_at_ms AS c_created_at_ms, c.changed_at_ms FROM public.n2f_identity_credentials c JOIN public.n2f_identity_principals p ON p.id=c.principal_id JOIN public.n2f_identity_auth_states a ON a.principal_id=c.principal_id WHERE ${where}`,
        [param],
      );
      if (r.rowCount !== 1) return ok(undefined);
      const row = r.rows[0];
      const principal = principalOf(row);
      if (!principal.ok) return principal;
      const credential = credentialOf({
        ...row,
        created_at_ms: row.c_created_at_ms,
      });
      if (!credential.ok) return credential;
      return ok({
        principal: principal.value,
        credential: credential.value,
        authEpoch: row.auth_epoch,
      });
    });
  }
  findByEmail(
    email: Email,
  ): Promise<Result<CredentialRecord | undefined, Failure>> {
    return this.credentialRecord('c.canonical_email=$1', email.reveal());
  }
  findByPrincipal(
    principalId: ID,
  ): Promise<Result<CredentialRecord | undefined, Failure>> {
    return this.credentialRecord('c.principal_id=$1::uuid', principalId);
  }

  commitLogin(
    record: LoginRecord,
  ): Promise<Result<'committed' | 'stale', Failure>> {
    return this.mutate(async (tx) => {
      const s = record.session;
      const locked = await lock(tx, s.principalId);
      if (!locked.ok) return locked;
      const l = locked.value;
      if (
        !l ||
        !l.credential ||
        l.principal.status !== 'active' ||
        l.credential.verifiedAtMs === undefined ||
        l.credential.passwordVersion !== record.expectedPasswordVersion ||
        l.epoch !== record.expectedAuthEpoch
      )
        return rollbackWith('stale');
      await tx.query(
        `INSERT INTO public.n2f_identity_sessions(${SESSION}) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
        [
          s.id,
          s.principalId,
          Buffer.from(s.tokenDigest.bytes()),
          s.authEpoch,
          s.issuedAtMs,
          s.lastSeenAtMs,
          s.absoluteExpiresAtMs,
          s.idleExpiresAtMs,
          s.revokedAtMs ?? null,
        ],
      );
      const published = await publish(tx, record.events);
      return published.ok ? ok('committed' as const) : published;
    });
  }

  issueUpgradeTicket(
    record: UpgradeTicketRecord,
  ): Promise<Result<'committed' | 'stale', Failure>> {
    return this.mutate(async (tx) => {
      const peek = await tx.query<{ principal_id: string }>(
        'SELECT principal_id FROM public.n2f_identity_sessions WHERE id=$1::uuid',
        [record.ticket.sessionId],
      );
      if (peek.rowCount !== 1) return rollbackWith('stale');
      const principalId = uuid(peek.rows[0].principal_id);
      const locked = await lock(tx, principalId);
      if (!locked.ok) return locked;
      const l = locked.value;
      if (!l?.credential || l.epoch !== record.expectedAuthEpoch || l.principal.status !== 'active' || l.credential.verifiedAtMs === undefined) return rollbackWith('stale');
      const row = await tx.query<SessionRow>(
        `SELECT ${SESSION} FROM public.n2f_identity_sessions WHERE id=$1::uuid AND principal_id=$2::uuid FOR UPDATE`,
        [record.ticket.sessionId, principalId],
      );
      if (row.rowCount !== 1) return rollbackWith('stale');
      const session = sessionOf(row.rows[0]);
      if (!session.ok) return session;
      if (session.value.snapshot().authEpoch !== l.epoch) return rollbackWith('stale');
      const usable = session.value.check(record.ticket.issuedAtMs);
      if (!usable.ok) return usable.error.type === 'identity.session_rejected' ? rollbackWith('stale') : err(corrupt(usable.error.type));
      const ticket = UpgradeTicket.restore(record.ticket);
      if (!ticket.ok) return err(corrupt(ticket.error.type));
      await tx.query(
        `INSERT INTO public.n2f_identity_upgrade_tickets(${UPGRADE_TICKET}) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6)`,
        [record.ticket.id, record.ticket.sessionId, Buffer.from(record.ticket.tokenDigest.bytes()), record.ticket.issuedAtMs, record.ticket.expiresAtMs, record.ticket.consumedAtMs ?? null],
      );
      return ok('committed' as const);
    });
  }

  consumeUpgradeTicket(
    digest: TokenDigest,
    nowMs: number,
  ): Promise<Result<UpgradeTicketAdmission | undefined, Failure>> {
    return this.database
      .transaction(async (tx): Promise<Result<UpgradeTicketAdmission | undefined, Failure>> => {
        const bytes = Buffer.from(digest.bytes());
        const peek = await tx.query<{ principal_id: string }>(
          'SELECT s.principal_id FROM public.n2f_identity_upgrade_tickets ut JOIN public.n2f_identity_sessions s ON s.id=ut.session_id WHERE ut.token_digest=$1',
          [bytes],
        );
        if (peek.rowCount !== 1) return rollbackWith('rejected') as never;
        const principalId = uuid(peek.rows[0].principal_id);
        const locked = await lock(tx, principalId);
        if (!locked.ok) return locked;
        const l = locked.value;
        if (!l?.credential || l.principal.status !== 'active' || l.credential.verifiedAtMs === undefined) return rollbackWith('rejected') as never;
        const sessionRow = await tx.query<SessionRow>(
          `SELECT ${SESSION_JOIN} FROM public.n2f_identity_sessions s JOIN public.n2f_identity_upgrade_tickets ut ON ut.session_id=s.id WHERE ut.token_digest=$1 FOR UPDATE`,
          [bytes],
        );
        if (sessionRow.rowCount !== 1) return rollbackWith('rejected') as never;
        const session = sessionOf(sessionRow.rows[0]);
        if (!session.ok) return session;
        const sessionSnapshot = session.value.snapshot();
        if (sessionSnapshot.authEpoch !== l.epoch || !session.value.check(nowMs).ok) return rollbackWith('rejected') as never;
        const ticketRow = await tx.query<UpgradeTicketRow>(
          `SELECT ${UPGRADE_TICKET} FROM public.n2f_identity_upgrade_tickets WHERE token_digest=$1 FOR UPDATE`,
          [bytes],
        );
        if (ticketRow.rowCount !== 1) return rollbackWith('rejected') as never;
        const ticket = upgradeTicketOf(ticketRow.rows[0]);
        if (!ticket.ok) return ticket;
        const restoredTicket = UpgradeTicket.restore(ticket.value);
        if (!restoredTicket.ok) return err(corrupt(restoredTicket.error.type));
        const used = restoredTicket.value.consume(nowMs);
        if (!used.ok) return rollbackWith('rejected') as never;
        const updated = await guarded(
          tx,
          'UPDATE public.n2f_identity_upgrade_tickets SET consumed_at_ms=$2 WHERE id=$1::uuid AND consumed_at_ms IS NULL',
          [ticket.value.id, nowMs],
        );
        if (!updated.ok) return updated;
        return ok({ principalId, sessionId: sessionSnapshot.id, authEpoch: sessionSnapshot.authEpoch });
      })
      .then((r) => (!r.ok && r.error.type === ROLLBACK ? ok(undefined) : r));
  }

  resolve(
    digest: TokenDigest,
    nowMs: number,
    idleTtlMs: number,
  ): Promise<Result<Resolution, Failure>> {
    return this.database
      .transaction(async (tx): Promise<Result<Resolution, Failure>> => {
        const bytes = Buffer.from(digest.bytes());
        const peek = await tx.query<{ principal_id: string }>(
          'SELECT principal_id FROM public.n2f_identity_sessions WHERE token_digest=$1',
          [bytes],
        );
        if (peek.rowCount !== 1) return rollbackWith('absent') as never;
        const locked = await lock(tx, uuid(peek.rows[0].principal_id));
        if (!locked.ok) return locked;
        const row = await tx.query<SessionRow>(
          `SELECT ${SESSION} FROM public.n2f_identity_sessions WHERE token_digest=$1 FOR UPDATE`,
          [bytes],
        );
        if (row.rowCount !== 1) return rollbackWith('absent') as never;
        const session = sessionOf(row.rows[0]);
        if (!session.ok) return session;
        const snapshot = session.value.snapshot();
        const usable = session.value.check(nowMs);
        if (!usable.ok) {
          if (usable.error.type !== 'identity.session_rejected')
            return err(corrupt(usable.error.type));
          if (
            nowMs < snapshot.lastSeenAtMs ||
            snapshot.revokedAtMs !== undefined
          )
            return rollbackWith('rejected') as never;
          // Observed expiry is latched (S08) before the refusal commits.
          const revoked = session.value.revoke(nowMs);
          if (!revoked.ok) return revoked;
          const latched = await guarded(
            tx,
            'UPDATE public.n2f_identity_sessions SET revoked_at_ms=$2 WHERE id=$1::uuid AND revoked_at_ms IS NULL',
            [snapshot.id, revoked.value.snapshot().revokedAtMs],
          );
          return latched.ok ? ok({ outcome: 'rejected' } as const) : latched;
        }
        const l = locked.value;
        if (
          !l ||
          !l.credential ||
          l.principal.status !== 'active' ||
          l.credential.verifiedAtMs === undefined ||
          snapshot.authEpoch !== l.epoch
        )
          return rollbackWith('rejected') as never;
        const touched = session.value.touch(nowMs, idleTtlMs);
        if (!touched.ok) return touched;
        const next = touched.value.snapshot();
        const updated = await guarded(
          tx,
          'UPDATE public.n2f_identity_sessions SET last_seen_at_ms=$2, idle_expires_at_ms=$3 WHERE id=$1::uuid AND last_seen_at_ms=$4 AND revoked_at_ms IS NULL',
          [
            snapshot.id,
            next.lastSeenAtMs,
            next.idleExpiresAtMs,
            snapshot.lastSeenAtMs,
          ],
        );
        if (!updated.ok) return updated;
        return ok({
          outcome: 'admitted',
          principalId: snapshot.principalId,
          sessionId: snapshot.id,
          authEpoch: snapshot.authEpoch,
        } as const);
      })
      .then((r) =>
        !r.ok && r.error.type === ROLLBACK
          ? ok({ outcome: r.error.fields!.outcome as 'rejected' | 'absent' })
          : r,
      );
  }

  revokeSession(
    sessionId: ID,
    principalId: ID,
    nowMs: number,
    event: Envelope,
  ): Promise<Result<'revoked' | 'already_inactive' | 'absent', Failure>> {
    return this.mutate(async (tx) => {
      const locked = await lock(tx, principalId);
      if (!locked.ok) return locked;
      if (!locked.value) return rollbackWith('absent');
      const row = await tx.query<SessionRow>(
        `SELECT ${SESSION} FROM public.n2f_identity_sessions WHERE id=$1::uuid AND principal_id=$2::uuid FOR UPDATE`,
        [sessionId, principalId],
      );
      if (row.rowCount !== 1) return rollbackWith('absent');
      const session = sessionOf(row.rows[0]);
      if (!session.ok) return session;
      if (session.value.snapshot().revokedAtMs !== undefined)
        return rollbackWith('already_inactive');
      const revoked = session.value.revoke(nowMs);
      if (!revoked.ok) return revoked;
      const updated = await guarded(
        tx,
        'UPDATE public.n2f_identity_sessions SET revoked_at_ms=$2 WHERE id=$1::uuid AND revoked_at_ms IS NULL',
        [sessionId, revoked.value.snapshot().revokedAtMs],
      );
      if (!updated.ok) return updated;
      const published = await publish(tx, [event]);
      return published.ok ? ok('revoked' as const) : published;
    });
  }

  revokeAll(
    principalId: ID,
    expectedEpoch: number,
    nowMs: number,
    event: Envelope,
  ): Promise<Result<'committed' | 'stale', Failure>> {
    void nowMs;
    return this.mutate(async (tx) => {
      const locked = await lock(tx, principalId);
      if (!locked.ok) return locked;
      if (!locked.value || locked.value.epoch !== expectedEpoch)
        return rollbackWith('stale');
      const state = AuthState.create(principalId, locked.value.epoch);
      if (!state.ok) return err(corrupt(state.error.type));
      const next = state.value.invalidate(expectedEpoch);
      if (!next.ok) return next;
      const updated = await guarded(
        tx,
        'UPDATE public.n2f_identity_auth_states SET auth_epoch=$2 WHERE principal_id=$1::uuid AND auth_epoch=$3',
        [principalId, next.value.epoch(), expectedEpoch],
      );
      if (!updated.ok) return updated;
      const published = await publish(tx, [event]);
      return published.ok ? ok('committed' as const) : published;
    });
  }

  findByDigest(
    purpose: TokenPurpose,
    digest: TokenDigest,
  ): Promise<Result<ChallengeRecord | undefined, Failure>> {
    return this.read(async (tx) => {
      const r = await tx.query<
        ChallengeRow & {
          status: string;
          auth_epoch: number;
          canonical_email: string;
          password_hash: string;
          verified_at_ms: string | null;
          c_password_version: number;
          c_created_at_ms: string;
          changed_at_ms: string;
        }
      >(
        `SELECT ch.id, ch.principal_id, ch.purpose, ch.token_digest, ch.password_version, ch.issued_at_ms, ch.expires_at_ms, ch.consumed_at_ms, ch.invalidated_at_ms, p.status, a.auth_epoch, c.canonical_email, c.password_hash, c.verified_at_ms, c.password_version AS c_password_version, c.created_at_ms AS c_created_at_ms, c.changed_at_ms FROM public.n2f_identity_challenges ch JOIN public.n2f_identity_credentials c ON c.principal_id=ch.principal_id JOIN public.n2f_identity_principals p ON p.id=ch.principal_id JOIN public.n2f_identity_auth_states a ON a.principal_id=ch.principal_id WHERE ch.purpose=$1 AND ch.token_digest=$2`,
        [purpose, Buffer.from(digest.bytes())],
      );
      if (r.rowCount !== 1) return ok(undefined);
      const row = r.rows[0];
      const challenge = challengeOf(row);
      if (!challenge.ok) return challenge;
      const credential = credentialOf({
        ...row,
        password_version: row.c_password_version,
        created_at_ms: row.c_created_at_ms,
      });
      if (!credential.ok) return credential;
      if (row.status !== 'active' && row.status !== 'suspended')
        return err(corrupt('identity.principal_invalid'));
      return ok({
        challenge: challenge.value,
        credential: credential.value,
        principalStatus: row.status,
        authEpoch: row.auth_epoch,
      });
    });
  }

  issueChallenge(
    record: IssueChallengeRecord,
  ): Promise<Result<'issued' | 'stale', Failure>> {
    return this.mutate(async (tx) => {
      const ch = record.challenge;
      const locked = await lock(tx, ch.principalId);
      if (!locked.ok) return locked;
      if (
        !locked.value?.credential ||
        locked.value.credential.passwordVersion !==
          record.expectedPasswordVersion
      )
        return rollbackWith('stale');
      await invalidateOutstanding(
        tx,
        ch.principalId,
        ch.issuedAtMs,
        ch.tokenDigest.purpose(),
      );
      await tx.query(
        `INSERT INTO public.n2f_identity_challenges(${CHALLENGE}) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ch.id,
          ch.principalId,
          ch.tokenDigest.purpose(),
          Buffer.from(ch.tokenDigest.bytes()),
          ch.passwordVersion,
          ch.issuedAtMs,
          ch.expiresAtMs,
          ch.consumedAtMs ?? null,
          ch.invalidatedAtMs ?? null,
        ],
      );
      return ok('issued' as const);
    });
  }

  verifyEmail(
    record: VerifyRecord,
  ): Promise<Result<'committed' | 'stale', Failure>> {
    return this.mutate(async (tx) => {
      const locked = await lock(tx, record.principalId);
      if (!locked.ok) return locked;
      if (
        !locked.value?.credential ||
        locked.value.credential.passwordVersion !==
          record.expectedPasswordVersion
      )
        return rollbackWith('stale');
      if (
        !(await consume(
          tx,
          record.challengeId,
          record.principalId,
          'email_verification',
          record.consumedAtMs,
        ))
      )
        return rollbackWith('stale');
      const verified = await guarded(
        tx,
        'UPDATE public.n2f_identity_credentials SET verified_at_ms=COALESCE(verified_at_ms,$2) WHERE principal_id=$1::uuid',
        [record.principalId, record.consumedAtMs],
      );
      if (!verified.ok) return verified;
      const published = await publish(tx, record.events);
      return published.ok ? ok('committed' as const) : published;
    });
  }

  changePassword(
    record: ChangePasswordRecord,
  ): Promise<Result<'committed' | 'stale', Failure>> {
    return this.mutate(async (tx) => {
      const locked = await lock(tx, record.principalId);
      if (!locked.ok) return locked;
      const l = locked.value;
      if (
        !l?.credential ||
        l.credential.passwordVersion !== record.expectedPasswordVersion ||
        l.epoch !== record.expectedAuthEpoch
      )
        return rollbackWith('stale');
      const replaced = await replacePassword(
        tx,
        l,
        record.passwordHash,
        record.changedAtMs,
      );
      if (!replaced.ok) return replaced;
      const published = await publish(tx, record.events);
      return published.ok ? ok('committed' as const) : published;
    });
  }

  resetPassword(
    record: ResetPasswordRecord,
  ): Promise<Result<'committed' | 'stale', Failure>> {
    return this.mutate(async (tx) => {
      const locked = await lock(tx, record.principalId);
      if (!locked.ok) return locked;
      const l = locked.value;
      if (
        !l?.credential ||
        l.credential.passwordVersion !== record.expectedPasswordVersion ||
        l.epoch !== record.expectedAuthEpoch
      )
        return rollbackWith('stale');
      if (
        !(await consume(
          tx,
          record.challengeId,
          record.principalId,
          'password_reset',
          record.consumedAtMs,
        ))
      )
        return rollbackWith('stale');
      const replaced = await replacePassword(
        tx,
        l,
        record.passwordHash,
        record.changedAtMs,
        record.setVerified ? record.consumedAtMs : undefined,
      );
      if (!replaced.ok) return replaced;
      const published = await publish(tx, record.events);
      return published.ok ? ok('committed' as const) : published;
    });
  }
}
