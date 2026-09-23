import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { map } from '../../../../shared/postgres/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import type {
  CredentialAuthenticationRecord,
  CredentialAuthenticatorReader,
  IdentityReader,
  IdentityView,
  IdentityViewReader,
  VerificationChallengeReader,
  VerificationChallengeRecord,
} from '../../app/ports/index.js';
import {
  Credential,
  Identity,
  VerificationChallenge,
} from '../../domain/index.js';
import { type TransactionDatabase } from './database.js';

type IdentityRow = {
  id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  verified_at: Date | null;
  version: number;
};

type CredentialRow = {
  id: string;
  identity_id: string;
  method: string;
  email: string;
  status: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
};

type CredentialAuthenticationRow = IdentityRow & {
  credential_id: string;
  credential_identity_id: string;
  credential_method: string;
  credential_email: string;
  credential_status: string;
  password_hash: string;
  credential_created_at: Date;
  credential_updated_at: Date;
  credential_revoked_at: Date | null;
};

type ChallengeRow = {
  id: string;
  identity_id: string;
  purpose: string;
  status: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  token_digest: string;
  version: number;
};

function storedId(value: unknown): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('internal', 'stored identity ID is invalid', {
        type: 'identity.persistence_invalid',
      }),
    );
  }
  return parse(value);
}

function storedSecret(value: unknown): Result<SecretString, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('internal', 'stored secret is invalid', {
        type: 'identity.persistence_invalid',
      }),
    );
  }
  return ok(new SecretString(value));
}

function identityFrom(row: IdentityRow): Result<Identity, Failure> {
  const id = storedId(row.id);
  if (!id.ok) return id;
  return Identity.restore({
    id: id.value,
    status: row.status as Identity['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    version: row.version,
  });
}

function credentialFrom(row: CredentialRow): Result<Credential, Failure> {
  const id = storedId(row.id);
  if (!id.ok) return id;
  const identityId = storedId(row.identity_id);
  if (!identityId.ok) return identityId;
  return Credential.restore({
    id: id.value,
    identityId: identityId.value,
    method: row.method as Credential['method'],
    email: row.email,
    status: row.status as Credential['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
}

function challengeFrom(
  row: ChallengeRow,
): Result<VerificationChallenge, Failure> {
  const id = storedId(row.id);
  if (!id.ok) return id;
  const identityId = storedId(row.identity_id);
  if (!identityId.ok) return identityId;
  return VerificationChallenge.restore({
    id: id.value,
    identityId: identityId.value,
    purpose: row.purpose as VerificationChallenge['purpose'],
    status: row.status as VerificationChallenge['status'],
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    version: row.version,
  });
}

export class PostgresIdentityReader implements IdentityReader {
  constructor(private readonly database: TransactionDatabase) {}

  find(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Identity | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<IdentityRow>(
          `SELECT id,status,created_at,updated_at,verified_at,version
             FROM public.n2f_identity_identities
            WHERE id=$1::uuid`,
          [identityId],
        );
        const row = result.rows[0];
        return row === undefined ? ok(null) : identityFrom(row);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresIdentityViewReader implements IdentityViewReader {
  constructor(private readonly database: TransactionDatabase) {}

  findById(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<IdentityView | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<IdentityRow>(
          `SELECT id,status,created_at,updated_at,verified_at,version
             FROM public.n2f_identity_identities
            WHERE id=$1::uuid`,
          [identityId],
        );
        const row = result.rows[0];
        if (row === undefined) return ok(null);
        const identity = identityFrom(row);
        if (!identity.ok) return identity;
        return ok({
          identityId: identity.value.id,
          status: identity.value.status,
          verifiedAt: identity.value.verifiedAt,
        });
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresCredentialAuthenticatorReader
  implements CredentialAuthenticatorReader
{
  constructor(private readonly database: TransactionDatabase) {}

  findByEmail(
    email: CredentialAuthenticationRecord['credential']['email'],
    signal?: AbortSignal,
  ): Promise<Result<CredentialAuthenticationRecord | null, Failure>> {
    return this.find('c.email=$1', email, signal);
  }

  findByIdentity(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<CredentialAuthenticationRecord | null, Failure>> {
    return this.find('c.identity_id=$1::uuid', identityId, signal);
  }

  private find(
    where: 'c.email=$1' | 'c.identity_id=$1::uuid',
    value: string,
    signal?: AbortSignal,
  ): Promise<Result<CredentialAuthenticationRecord | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<CredentialAuthenticationRow>(
          `SELECT
             i.id,i.status,i.created_at,i.updated_at,i.verified_at,i.version,
             c.id AS credential_id,
             c.identity_id AS credential_identity_id,
             c.method AS credential_method,
             c.email AS credential_email,
             c.status AS credential_status,
             c.password_hash,
             c.created_at AS credential_created_at,
             c.updated_at AS credential_updated_at,
             c.revoked_at AS credential_revoked_at
           FROM public.n2f_identity_credentials c
           JOIN public.n2f_identity_identities i ON i.id=c.identity_id
          WHERE ${where} AND c.status='active'`,
          [value],
        );
        const row = result.rows[0];
        if (row === undefined) return ok(null);

        const identity = identityFrom(row);
        if (!identity.ok) return identity;
        const credential = credentialFrom({
          id: row.credential_id,
          identity_id: row.credential_identity_id,
          method: row.credential_method,
          email: row.credential_email,
          status: row.credential_status,
          password_hash: row.password_hash,
          created_at: row.credential_created_at,
          updated_at: row.credential_updated_at,
          revoked_at: row.credential_revoked_at,
        });
        if (!credential.ok) return credential;
        const passwordHash = storedSecret(row.password_hash);
        if (!passwordHash.ok) return passwordHash;
        return ok({
          identity: identity.value,
          credential: credential.value,
          passwordHash: passwordHash.value,
        });
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}

export class PostgresVerificationChallengeReader
  implements VerificationChallengeReader
{
  constructor(private readonly database: TransactionDatabase) {}

  find(
    challengeId: ID,
    signal?: AbortSignal,
  ): Promise<Result<VerificationChallengeRecord | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<ChallengeRow>(
          `SELECT id,identity_id,purpose,status,issued_at,expires_at,
                  consumed_at,token_digest,version
             FROM public.n2f_identity_verification_challenges
            WHERE id=$1::uuid`,
          [challengeId],
        );
        const row = result.rows[0];
        if (row === undefined) return ok(null);
        const challenge = challengeFrom(row);
        if (!challenge.ok) return challenge;
        const tokenDigest = storedSecret(row.token_digest);
        if (!tokenDigest.ok) return tokenDigest;
        return ok({ challenge: challenge.value, tokenDigest: tokenDigest.value });
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
