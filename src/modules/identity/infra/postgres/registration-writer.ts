import {
  err,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { map, violatedUnique } from '../../../../shared/postgres/index.js';
import { alreadyExists, emailTaken } from '../failures.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { Credential, Identity } from '../../domain/index.js';
import type { RegistrationWriter } from '../../app/ports/index.js';
import type { TransactionDatabase } from './database.js';

function secret(value: SecretString): string {
  return value.reveal();
}

/**
 * Persists registration state and its outbox envelope in one transaction.
 * The publisher is intentionally absent: delivery happens after commit.
 */
export class PostgresRegistrationWriter implements RegistrationWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(
    input: Readonly<{
      identity: Identity;
      credential: Credential;
      passwordHash: SecretString;
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
          `INSERT INTO public.n2f_identity_identities
            (id,status,created_at,updated_at,verified_at)
           VALUES ($1::uuid,$2,$3,$4,$5)`,
          [
            input.identity.id,
            input.identity.status,
            input.identity.createdAt,
            input.identity.updatedAt,
            input.identity.verifiedAt,
          ],
        );

        await transaction.query(
          `INSERT INTO public.n2f_identity_credentials
            (id,identity_id,method,email,status,password_hash,created_at,updated_at,revoked_at)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.credential.id,
            input.credential.identityId,
            input.credential.method,
            input.credential.email,
            input.credential.status,
            secret(input.passwordHash),
            input.credential.createdAt,
            input.credential.updatedAt,
            input.credential.revokedAt,
          ],
        );

        return enqueue(transaction, input.event);
      } catch (cause) {
        switch (violatedUnique(cause)) {
          case 'n2f_identity_credentials_email_key':
            return err(emailTaken());
          case 'n2f_identity_identities_pkey':
            return err(alreadyExists());
          default:
            return err(map(cause));
        }
      }
    }, signal);
  }
}
