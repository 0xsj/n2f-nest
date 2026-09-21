import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { VerificationChallenge } from '../../domain/index.js';

export type VerificationChallengeRecord = Readonly<{
  challenge: VerificationChallenge;
  tokenDigest: SecretString;
}>;

export interface VerificationChallengeReader {
  find(
    challengeId: ID,
    signal?: AbortSignal,
  ): Promise<Result<VerificationChallengeRecord | null, Failure>>;
}
