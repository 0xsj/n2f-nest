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

const DEFAULT_SESSION_LIMITS = Object.freeze({
  lifetimeMs: 24 * 60 * 60 * 1000,
  idleTimeoutMs: 60 * 60 * 1000,
  maxActivePerIdentity: 10,
});

export class DefaultSessionPolicy extends FixedDurationPolicy implements SessionPolicy {
  readonly idleTimeoutMs: number;
  /** Often enough that recorded activity lags real use by under a quarter of the idle timeout. */
  readonly activityIntervalMs: number;
  readonly maxActivePerIdentity: number;

  constructor(
    limits: Readonly<{
      lifetimeMs: number;
      idleTimeoutMs: number;
      maxActivePerIdentity: number;
    }> = DEFAULT_SESSION_LIMITS,
  ) {
    super(limits.lifetimeMs, 'identity.invalid_session_expiry', 'session');
    this.idleTimeoutMs = limits.idleTimeoutMs;
    this.activityIntervalMs = Math.min(60 * 1000, Math.floor(limits.idleTimeoutMs / 4));
    this.maxActivePerIdentity = limits.maxActivePerIdentity;
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

/** Password-reset links are short-lived: an hour. */
export class DefaultPasswordResetPolicy
  extends FixedDurationPolicy
  implements VerificationPolicy
{
  constructor() {
    super(60 * 60 * 1000, 'identity.invalid_verification_expiry', 'password reset');
  }
}
