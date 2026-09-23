import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { perClient, RateLimit } from '../../../../platform/ratelimit/index.js';
import {
  err,
  failure,
  publicInfo,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { problemOf } from '../../../../shared/http/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import {
  AddMembership,
  AcceptInvitation,
  ChangeMembershipRole,
  CreateOrganization,
  InviteIdentity,
  ListCurrentOrganizations,
  RevokeInvitation,
  RevokeMembership,
} from '../../app/index.js';
import { OrganizationHttpWork } from './work.js';

type BodyObject = Record<string, unknown>;

function objectBody(value: unknown): Result<BodyObject, Failure> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: value as BodyObject };
}

function body(value: unknown): Result<{ name: unknown; slug: unknown }, Failure> {
  const object = objectBody(value);
  if (!object.ok || Object.keys(object.value).length !== 2) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return {
    ok: true,
    value: { name: object.value.name, slug: object.value.slug },
  };
}

function roleBody(value: unknown): Result<{ role: unknown }, Failure> {
  const object = objectBody(value);
  if (!object.ok || Object.keys(object.value).length !== 1) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return { ok: true, value: { role: object.value.role } };
}

function membershipBody(
  value: unknown,
): Result<{ identityId: string; role: unknown }, Failure> {
  const object = objectBody(value);
  if (
    !object.ok ||
    Object.keys(object.value).length !== 2 ||
    typeof object.value.identityId !== 'string'
  ) {
    return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  }
  return {
    ok: true,
    value: { identityId: object.value.identityId, role: object.value.role },
  };
}

function invitationBody(
  value: unknown,
): Result<{ identityId: string; role: unknown }, Failure> {
  return membershipBody(value);
}

function parameter(value: string | undefined): Result<ID, Failure> {
  if (value === undefined) {
    return err(
      failure('invalid', 'required route parameter is missing', {
        type: 'http.invalid_parameter',
      }),
    );
  }
  return parse(value);
}

function bearer(value: string | undefined): Result<SecretString, Failure> {
  if (!value || !/^Bearer [^\s]+$/.test(value)) {
    return err(
      failure('unauthenticated', 'bearer token is required', {
        type: 'organization.missing_token',
      }),
    );
  }
  return { ok: true, value: new SecretString(value.slice(7)) };
}

function respond<T>(result: Result<T, Failure>): T {
  if (result.ok) return result.value;
  const problem = problemOf(result);
  throw new HttpException(
    problem ?? { ...publicInfo(result.error) },
    problem?.status ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** Per-client bound on this controller's requests; see platform/ratelimit. */
@RateLimit(perClient('organization', 120, 60_000))
@Controller('organizations')
export class OrganizationController {
  constructor(
    private readonly addMembership: AddMembership,
    private readonly acceptInvitation: AcceptInvitation,
    private readonly changeRole: ChangeMembershipRole,
    private readonly create: CreateOrganization,
    private readonly inviteIdentity: InviteIdentity,
    private readonly list: ListCurrentOrganizations,
    private readonly revokeMembership: RevokeMembership,
    private readonly revokeInvitation: RevokeInvitation,
    private readonly work: OrganizationHttpWork,
  ) {}

  @Get()
  async listOrganizations(
    @Headers('authorization') authorization?: string,
  ) {
    const sessionToken = respond(bearer(authorization));
    const result = await this.list.execute({ sessionToken });
    return respond(result).map(({ organization, membership }) => ({
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      membershipId: membership.id,
      role: membership.role,
      membershipStatus: membership.status,
    }));
  }

  // Creating organizations is the one write that mints new tenants.
  @RateLimit(perClient('organization.create', 20, 10 * 60_000))
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrganization(
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const input = respond(body(rawBody));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.create'));
    const result = await this.create.execute({
      sessionToken,
      name: input.name,
      slug: input.slug,
      work,
    });
    return respond(result);
  }

  @Post(':organizationId/memberships')
  @HttpCode(HttpStatus.CREATED)
  async addOrganizationMembership(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const input = respond(membershipBody(rawBody));
    const identityId = respond(parse(input.identityId));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.membership.add'));
    const result = await this.addMembership.execute({
      sessionToken,
      organizationId,
      identityId,
      role: input.role,
      work,
    });
    return respond(result);
  }

  @Post(':organizationId/invitations')
  @HttpCode(HttpStatus.CREATED)
  async inviteOrganizationIdentity(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const input = respond(invitationBody(rawBody));
    const identityId = respond(parse(input.identityId));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.invitation.create'));
    const result = await this.inviteIdentity.execute({
      sessionToken,
      organizationId,
      identityId,
      role: input.role,
      work,
    });
    return respond(result);
  }

  @Post(':organizationId/invitations/:invitationId/accept')
  async acceptOrganizationInvitation(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('invitationId') invitationIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const invitationId = respond(parameter(invitationIdValue));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.invitation.accept'));
    const result = await this.acceptInvitation.execute({
      sessionToken,
      organizationId,
      invitationId,
      work,
    });
    return respond(result);
  }

  @Delete(':organizationId/invitations/:invitationId')
  async revokeOrganizationInvitation(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('invitationId') invitationIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const invitationId = respond(parameter(invitationIdValue));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.invitation.revoke'));
    const result = await this.revokeInvitation.execute({
      sessionToken,
      organizationId,
      invitationId,
      work,
    });
    return respond(result);
  }

  @Patch(':organizationId/memberships/:membershipId/role')
  async changeMembershipRole(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('membershipId') membershipIdValue: string | undefined,
    @Body() rawBody: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const membershipId = respond(parameter(membershipIdValue));
    const input = respond(roleBody(rawBody));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.membership.role.change'));
    const result = await this.changeRole.execute({
      sessionToken,
      organizationId,
      membershipId,
      role: input.role,
      work,
    });
    return respond(result);
  }

  @Delete(':organizationId/memberships/:membershipId')
  async revokeOrganizationMembership(
    @Param('organizationId') organizationIdValue: string | undefined,
    @Param('membershipId') membershipIdValue: string | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const organizationId = respond(parameter(organizationIdValue));
    const membershipId = respond(parameter(membershipIdValue));
    const sessionToken = respond(bearer(authorization));
    const work = respond(this.work.open('organization.membership.revoke'));
    const result = await this.revokeMembership.execute({
      sessionToken,
      organizationId,
      membershipId,
      work,
    });
    return respond(result);
  }
}
