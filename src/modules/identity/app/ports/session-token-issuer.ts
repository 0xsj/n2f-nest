import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export type SessionTokenMaterial = Readonly<{
  token: SecretString;
  digest: SecretString;
}>;

export interface SessionTokenIssuer {
  issue(signal?: AbortSignal): Promise<Result<SessionTokenMaterial, Failure>>;
}
