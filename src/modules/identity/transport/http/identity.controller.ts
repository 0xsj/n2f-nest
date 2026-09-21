import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  HttpCode,
  Post,
} from '@nestjs/common';
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
import {
  AuthenticateIdentity,
  GetCurrentIdentity,
  IssueVerificationChallenge,
  RegisterIdentity,
  RevokeSession,
  VerifyIdentity,
} from '../../app/index.js';
import { IdentityHttpWork } from './work.js';

type BodyObject = Record<string, unknown>;

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
  constructor(
    private readonly register: RegisterIdentity,
    private readonly issueChallenge: IssueVerificationChallenge,
    private readonly verify: VerifyIdentity,
    private readonly authenticate: AuthenticateIdentity,
    private readonly current: GetCurrentIdentity,
    private readonly revoke: RevokeSession,
    private readonly workFactory: IdentityHttpWork,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async registerIdentity(@Body() rawBody: unknown) {
    const body = respond(exactStrings(rawBody, ['email', 'password']));
    const result = await this.register.execute({
      email: body.email,
      password: new SecretString(body.password),
      work: workOrThrow(this.workFactory, 'identity.register'),
    });
    return respond(result);
  }

  @Post('verification-challenges')
  @HttpCode(HttpStatus.CREATED)
  async issueVerificationChallenge(@Body() rawBody: unknown) {
    const body = respond(exactStrings(rawBody, ['identityId']));
    const identityId = respond(parse(body.identityId));
    const result = await this.issueChallenge.execute({
      identityId,
      work: workOrThrow(this.workFactory, 'identity.verification-challenge.issue'),
    });
    const value = respond(result);
    return {
      identityId: value.identityId,
      challengeId: value.challengeId,
      token: value.token.reveal(),
      expiresAt: value.expiresAt.toISOString(),
    };
  }

  @Post('verify')
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
