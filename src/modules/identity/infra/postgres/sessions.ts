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
import { map } from '../../../../shared/postgres/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type {
  CurrentSessionReader,
  SessionRevocationWriter,
  SessionWriter,
} from '../../app/ports/index.js';
import { Session } from '../../domain/index.js';
import { digestToken } from '../in-memory/crypto.js';
import type { TransactionDatabase } from './database.js';

type SessionRow = {
  id: string;
  identity_id: string;
  status: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

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
    revokedAt: row.revoked_at,
  });
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
      tokenDigest: SecretString;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;

      try {
        await transaction.query(
          `INSERT INTO public.n2f_identity_sessions
            (id,identity_id,status,created_at,expires_at,revoked_at,token_digest)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`,
          [
            input.session.id,
            input.session.identityId,
            input.session.status,
            input.session.createdAt,
            input.session.expiresAt,
            input.session.revokedAt,
            input.tokenDigest.reveal(),
          ],
        );
        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(map(cause));
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
          `SELECT id,identity_id,status,created_at,expires_at,revoked_at
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
        const session = await transaction.query(
          `UPDATE public.n2f_identity_sessions
              SET status=$2,revoked_at=$3
            WHERE id=$1::uuid`,
          [input.session.id, input.session.status, input.session.revokedAt],
        );
        if (session.rowCount !== 1) return err(notFound());
        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
