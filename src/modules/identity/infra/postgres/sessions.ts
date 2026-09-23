import type pg from 'pg';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import {
  map,
  missingOrStale,
  violatedUnique,
} from '../../../../shared/postgres/index.js';
import { sessionExists, staleWrite } from '../failures.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type {
  ActiveSessionReader,
  CurrentSessionReader,
  SessionActivityWriter,
  SessionEviction,
  SessionPruner,
  SessionRevocationWriter,
  SessionWriter,
} from '../../app/ports/index.js';
import { Session, type Credential } from '../../domain/index.js';
import { digestToken } from '../in-memory/crypto.js';
import type { TransactionDatabase } from './database.js';

type SessionRow = {
  id: string;
  identity_id: string;
  status: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  version: number;
};

const SESSION_COLUMNS = 'id,identity_id,status,created_at,expires_at,last_seen_at,revoked_at,version';

function storedId(value: unknown): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('internal', 'stored session ID is invalid', {
        type: 'identity.persistence_invalid',
      }),
    );
  }
  return parse(value);
}

function sessionFrom(row: SessionRow): Result<Session, Failure> {
  const id = storedId(row.id);
  if (!id.ok) return id;
  const identityId = storedId(row.identity_id);
  if (!identityId.ok) return identityId;
  return Session.restore({
    id: id.value,
    identityId: identityId.value,
    status: row.status as Session['status'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    version: row.version,
  });
}

/** A version-checked revocation; the failure when the row moved or vanished. */
async function revoke(
  transaction: pg.PoolClient,
  session: Session,
): Promise<Failure | null> {
  const updated = await transaction.query(
    `UPDATE public.n2f_identity_sessions
        SET status=$2,revoked_at=$3,version=version+1
      WHERE id=$1::uuid AND version=$4`,
    [session.id, session.status, session.revokedAt, session.version],
  );
  if (updated.rowCount === 1) return null;
  return (await missingOrStale(transaction, 'public.n2f_identity_sessions', session.id)) === 'missing'
    ? notFound()
    : staleWrite();
}

const notFound = (): Failure =>
  failure('not_found', 'session was not found', {
    type: 'identity.session_not_found',
  });

export class PostgresSessionWriter implements SessionWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(
    input: Readonly<{
      session: Session;
      credential: Credential;
      tokenDigest: SecretString;
      event: Envelope;
      evicted: readonly SessionEviction[];
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      for (const event of [input.event, ...input.evicted.map((eviction) => eviction.event)]) {
        const provenance = assertEventWork(event, input.work);
        if (!provenance.ok) return provenance;
      }

      try {
        // The password this login checked must still be the credential's: a
        // reset committed meanwhile changes updated_at. FOR SHARE makes a
        // concurrent reset wait for this login, which it then revokes.
        const unchanged = await transaction.query(
          `SELECT 1 FROM public.n2f_identity_credentials
            WHERE id=$1::uuid AND status='active' AND updated_at=$2
            FOR SHARE`,
          [input.credential.id, input.credential.updatedAt],
        );
        if (unchanged.rowCount !== 1) return err(staleWrite());
        for (const eviction of input.evicted) {
          const refused = await revoke(transaction, eviction.session);
          if (refused) return err(refused);
          const queued = await enqueue(transaction, eviction.event);
          if (!queued.ok) return queued;
        }
        await transaction.query(
          `INSERT INTO public.n2f_identity_sessions
            (id,identity_id,status,created_at,expires_at,last_seen_at,revoked_at,token_digest)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8)`,
          [
            input.session.id,
            input.session.identityId,
            input.session.status,
            input.session.createdAt,
            input.session.expiresAt,
            input.session.lastSeenAt,
            input.session.revokedAt,
            input.tokenDigest.reveal(),
          ],
        );
        return enqueue(transaction, input.event);
      } catch (cause) {
        const constraint = violatedUnique(cause);
        return err(
          constraint === 'n2f_identity_sessions_pkey' ||
            constraint === 'n2f_identity_sessions_token_digest_key'
            ? sessionExists()
            : map(cause),
        );
      }
    }, signal);
  }
}

export class PostgresCurrentSessionReader implements CurrentSessionReader {
  constructor(private readonly database: TransactionDatabase) {}

  findByToken(
    token: SecretString,
    signal?: AbortSignal,
  ): Promise<Result<Session | null, Failure>> {
    return this.database.transaction<Session | null>(async (transaction) => {
      try {
        const result = await transaction.query<SessionRow>(
          `SELECT ${SESSION_COLUMNS}
             FROM public.n2f_identity_sessions
            WHERE token_digest=$1`,
          [digestToken(token).reveal()],
        );
        const row = result.rows[0];
        return row === undefined ? ok(null) : sessionFrom(row);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresSessionRevocationWriter
  implements SessionRevocationWriter
{
  constructor(private readonly database: TransactionDatabase) {}

  commit(
    input: Readonly<{
      session: Session;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;

      try {
        const refused = await revoke(transaction, input.session);
        if (refused) return err(refused);
        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresSessionActivityWriter implements SessionActivityWriter {
  constructor(private readonly database: TransactionDatabase) {}

  record(sessionId: ID, at: Date, signal?: AbortSignal): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        // Forward only and outside the version: concurrent requests may each
        // record, and none overwrites a revocation.
        await transaction.query(
          `UPDATE public.n2f_identity_sessions
              SET last_seen_at=$2
            WHERE id=$1::uuid AND last_seen_at<$2`,
          [sessionId, at],
        );
        return ok(undefined);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresActiveSessionReader implements ActiveSessionReader {
  constructor(private readonly database: TransactionDatabase) {}

  listActive(identityId: ID, signal?: AbortSignal): Promise<Result<readonly Session[], Failure>> {
    return this.database.transaction<readonly Session[]>(async (transaction) => {
      try {
        const result = await transaction.query<SessionRow>(
          `SELECT ${SESSION_COLUMNS}
             FROM public.n2f_identity_sessions
            WHERE identity_id=$1::uuid AND status='active'
            ORDER BY created_at DESC, id DESC`,
          [identityId],
        );
        const sessions: Session[] = [];
        for (const row of result.rows) {
          const session = sessionFrom(row);
          if (!session.ok) return session;
          sessions.push(session.value);
        }
        return ok(sessions);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresSessionPruner implements SessionPruner {
  constructor(private readonly database: TransactionDatabase) {}

  prune(
    input: Readonly<{ endedBefore: Date; idleBefore: Date; limit: number }>,
    signal?: AbortSignal,
  ): Promise<Result<number, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query(
          `DELETE FROM public.n2f_identity_sessions
            WHERE id IN (
              SELECT id FROM public.n2f_identity_sessions
               WHERE revoked_at<$1 OR expires_at<$1 OR last_seen_at<$2
               LIMIT $3
               FOR UPDATE SKIP LOCKED)`,
          [input.endedBefore, input.idleBefore, input.limit],
        );
        return ok(result.rowCount ?? 0);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
