import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  HttpCode,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  err,
  failure,
  publicInfo,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { problemOf } from '../../../../shared/http/index.js';
import { parse } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { RateLimit } from '../../../../platform/ratelimit/index.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../../../platform/runtime/index.js';
import {
  AuthenticateIdentity,
  GetCurrentIdentity,
  ResendVerification,
  RevokeSession,
  SignUp,
  VerifyIdentity,
} from '../../app/index.js';
import { IdentityHttpWork } from './work.js';

type BodyObject = Record<string, unknown>;

function clientKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

/**
 * Digest caller-supplied body fields so a rate-limit key stays within the
 * store's length bound whatever the client sends.
 */
function bodyKey(request: Request, field: string): string {
  const value = request.body?.[field];
  if (typeof value !== 'string') return 'unknown';
  return createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('base64url');
}

const REGISTER_LIMIT = {
  name: 'identity.register',
  limit: 5,
  windowMs: 10 * 60 * 1000,
  key: clientKey,
} as const;

const LOGIN_LIMIT = {
  name: 'identity.login',
  limit: 10,
  windowMs: 60 * 1000,
  key: (request: Request) => `${clientKey(request)}:${bodyKey(request, 'email')}`,
} as const;

/** Bounds password spraying: one client trying many accounts. */
const LOGIN_CLIENT_LIMIT = {
  name: 'identity.login_client',
  limit: 30,
  windowMs: 10 * 60 * 1000,
  key: clientKey,
} as const;

/**
 * Bounds distributed guessing against one account. It is deliberately looser
 * than the per-client limit because anyone can spend it to lock the account.
 */
const LOGIN_ACCOUNT_LIMIT = {
  name: 'identity.login_account',
  limit: 50,
  windowMs: 15 * 60 * 1000,
  key: (request: Request) => bodyKey(request, 'email'),
} as const;

const CHALLENGE_LIMIT = {
  name: 'identity.verification_challenge',
  limit: 5,
  windowMs: 10 * 60 * 1000,
  key: clientKey,
} as const;

/** Bounds how often one address is mailed, whoever asks. */
const CHALLENGE_EMAIL_LIMIT = {
  name: 'identity.verification_challenge_email',
  limit: 3,
  windowMs: 60 * 60 * 1000,
  key: (request: Request) => bodyKey(request, 'email'),
} as const;

/** Resolves no sooner than `floorMs` after `startedAt`, hiding how long the work took. */
async function notBefore(startedAt: number, floorMs: number): Promise<void> {
  const remaining = startedAt + floorMs - performance.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/** The one answer to sign-up and resend, whatever happened. */
const ACCEPTED = Object.freeze({
  status: 'accepted',
  detail: 'If the address can receive it, a message is on its way.',
});

const VERIFY_LIMIT = {
  name: 'identity.verify',
  limit: 10,
  windowMs: 10 * 60 * 1000,
  key: (request: Request) => `${clientKey(request)}:${bodyKey(request, 'challengeId')}`,
} as const;

function objectBody(value: unknown): Result<BodyObject, Failure> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: value as BodyObject };
}

function exactStrings(
  value: unknown,
  names: readonly string[],
): Result<Record<string, string>, Failure> {
  const body = objectBody(value);
  if (!body.ok || Object.keys(body.value).length !== names.length) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  const output: Record<string, string> = {};
  for (const name of names) {
    const field = body.value[name];
    if (typeof field !== 'string' || field.length > 4096) {
      return err(failure('invalid', `request field ${name} is invalid`, {
        type: 'http.invalid_body',
        fields: { [name]: 'must be a string' },
      }));
    }
    output[name] = field;
  }
  return { ok: true, value: output };
}

function bearer(value: string | undefined): Result<SecretString, Failure> {
  if (!value || !/^Bearer [^\s]+$/.test(value)) {
    return err(failure('unauthenticated', 'bearer token is required', {
      type: 'identity.missing_token',
    }));
  }
  return { ok: true, value: new SecretString(value.slice(7)) };
}

function respond<T>(result: Result<T, Failure>): T {
  if (result.ok) return result.value;
  const problem = problemOf(result);
  throw new HttpException(problem ?? { ...publicInfo(result.error) }, problem?.status ?? HttpStatus.INTERNAL_SERVER_ERROR);
}

function workOrThrow(
  workFactory: IdentityHttpWork,
  operationName: string,
) {
  return respond(workFactory.open(operationName));
}

@Controller('identity')
export class IdentityController {
  private readonly logger = new Logger('IdentityController');

  constructor(
    private readonly signUp: SignUp,
    private readonly resend: ResendVerification,
    private readonly verify: VerifyIdentity,
    private readonly authenticate: AuthenticateIdentity,
    private readonly current: GetCurrentIdentity,
    private readonly revoke: RevokeSession,
    private readonly workFactory: IdentityHttpWork,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  /**
   * Answers 202 alike for a new and a taken email (hardening item S2): the
   * verification link, or a notice to the existing owner, goes by mail.
   */
  @Post('register')
  @RateLimit(REGISTER_LIMIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async registerIdentity(@Body() rawBody: unknown) {
    const startedAt = performance.now();
    const body = respond(exactStrings(rawBody, ['email', 'password']));
    const result = respond(await this.signUp.execute({
      email: body.email,
      password: new SecretString(body.password),
      work: workOrThrow(this.workFactory, 'identity.register'),
    }));
    if (!result.mailed) this.logger.warn('sign-up accepted but its message was not handed to the mailer');
    await notBefore(startedAt, this.config.http.signupFloorMs);
    return ACCEPTED;
  }

  /** Mails a new verification link to an unverified address; 202 alike for any address. */
  @Post('verification-challenges')
  @RateLimit(CHALLENGE_LIMIT, CHALLENGE_EMAIL_LIMIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(@Body() rawBody: unknown) {
    const startedAt = performance.now();
    const body = respond(exactStrings(rawBody, ['email']));
    respond(await this.resend.execute({
      email: body.email,
      work: workOrThrow(this.workFactory, 'identity.verification-challenge.issue'),
    }));
    await notBefore(startedAt, this.config.http.signupFloorMs);
    return ACCEPTED;
  }

  @Post('verify')
  @RateLimit(VERIFY_LIMIT)
  async verifyIdentity(@Body() rawBody: unknown) {
    const body = respond(exactStrings(rawBody, ['challengeId', 'token']));
    const challengeId = respond(parse(body.challengeId));
    return respond(await this.verify.execute({
      challengeId,
      token: new SecretString(body.token),
      work: workOrThrow(this.workFactory, 'identity.verify'),
    }));
  }

  @Post('login')
  @RateLimit(LOGIN_LIMIT, LOGIN_CLIENT_LIMIT, LOGIN_ACCOUNT_LIMIT)
  async login(@Body() rawBody: unknown) {
    const body = respond(exactStrings(rawBody, ['email', 'password']));
    const value = respond(await this.authenticate.execute({
      email: body.email,
      password: new SecretString(body.password),
      work: workOrThrow(this.workFactory, 'identity.authenticate'),
    }));
    return {
      identityId: value.identityId,
      sessionId: value.sessionId,
      token: value.token.reveal(),
      expiresAt: value.expiresAt.toISOString(),
    };
  }

  @Get('me')
  async currentIdentity(@Headers('authorization') authorization?: string) {
    const token = respond(bearer(authorization));
    const value = respond(await this.current.execute({
      sessionToken: token,
    }));
    return {
      identityId: value.identityId,
      status: value.status,
      verifiedAt: value.verifiedAt?.toISOString() ?? null,
    };
  }

  @Post('logout')
  async logout(@Headers('authorization') authorization?: string) {
    const token = respond(bearer(authorization));
    return respond(await this.revoke.execute({
      sessionToken: token,
      work: workOrThrow(this.workFactory, 'identity.logout'),
    }));
  }
}
