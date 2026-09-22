import { err, failure, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordPolicy,
  type SessionPolicy,
  type VerificationPolicy,
} from '../../app/ports/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';

export class DefaultPasswordPolicy implements PasswordPolicy {
  validate(password: SecretString): Result<void, Failure> {
    const length = password.reveal().length;

    if (length < PASSWORD_MIN_LENGTH) {
      return err(failure('invalid', `password must be at least ${PASSWORD_MIN_LENGTH} characters`, {
        type: 'identity.password_too_short',
      }));
    }

    if (length > PASSWORD_MAX_LENGTH) {
      return err(failure('invalid', `password must be at most ${PASSWORD_MAX_LENGTH} characters`, {
        type: 'identity.password_too_long',
      }));
    }

    return ok(undefined);
  }
}

class FixedDurationPolicy {
  constructor(
    private readonly durationMs: number,
    private readonly type: string,
    private readonly label: string,
  ) {}

  expiresAt(start: Date): Result<Date, Failure> {
    const startMs = start.getTime();
    const expires = startMs + this.durationMs;
    if (!Number.isFinite(startMs) || !Number.isSafeInteger(expires)) {
      return err(failure('invalid', `${this.label} start time is invalid`, {
        type: this.type,
      }));
    }
    return ok(new Date(expires));
  }
}

export class DefaultSessionPolicy extends FixedDurationPolicy implements SessionPolicy {
  constructor() {
    super(24 * 60 * 60 * 1000, 'identity.invalid_session_expiry', 'session');
  }
}

export class DefaultVerificationPolicy
  extends FixedDurationPolicy
  implements VerificationPolicy
{
  constructor() {
    super(24 * 60 * 60 * 1000, 'identity.invalid_verification_expiry', 'verification');
  }
}
