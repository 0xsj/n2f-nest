import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { EmailAddress } from '../../domain/index.js';
import type { Credential, Identity } from '../../domain/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type CredentialAuthenticationRecord = Readonly<{
  identity: Identity;
  credential: Credential;
  passwordHash: SecretString;
}>;

export interface CredentialAuthenticatorReader {
  findByEmail(
    email: EmailAddress,
    signal?: AbortSignal,
  ): Promise<Result<CredentialAuthenticationRecord | null, Failure>>;
}
