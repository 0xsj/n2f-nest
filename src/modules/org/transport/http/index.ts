/** Organization HTTP projection; see CONTRACT.md. */
import { err, failure, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { Refuse, Reply, type FeatureRequest } from '../../../../shared/http/feature.js';
import type { RequestContext, Route } from '../../../../shared/http/nest/server.js';
import { stringFields } from '../../../../shared/http/json.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { AcceptInvitation, ChangeMembershipRole, CreateOrganization, InviteMember, ListOrganizations } from '../../app/index.js';
import type { Role } from '../../domain/index.js';

export type Config = Readonly<{
  admission: NonNullable<Route['admission']>;
  readAdmission: NonNullable<Route['admission']>;
  principalId: (admitted: unknown) => Result<ID, Failure>;
}>;
export type Transport = Readonly<{ routes: readonly Route[] }>;

const configuration = () => failure('invalid', 'invalid organization HTTP configuration', { type: 'org.transport_configuration' });
const refused = (error: Failure): Result<never, unknown> => {
  const wrapped = Refuse.create(error, { headers: { 'Cache-Control': 'no-store' } });
  return err(wrapped.ok ? wrapped.value : error);
};
const reply = (body: unknown, status: 200 | 201 = 201): Result<Reply, Failure> => Reply.create({
  status,
  body,
  headers: { 'Cache-Control': 'no-store' },
});
const body = (request: FeatureRequest): Result<{ name: string }, Failure> => {
  const fields = stringFields(request.body, ['name']);
  return fields.ok ? ok({ name: fields.value.name }) : err(fields.error);
};
const queryLimit = (raw: string): Result<number, Failure> => {
  const params = new URLSearchParams(raw);
  const values = params.getAll('limit');
  if (values.length > 1) return err(failure('invalid', 'invalid organization query', { type: 'org.invalid_query' }));
  const limit = values.length === 1 ? Number(values[0]) : 50;
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    ? ok(limit)
    : err(failure('invalid', 'invalid organization query', { type: 'org.invalid_query' }));
};

export function createTransport(
  config: Config,
  deps: { create: CreateOrganization; list: ListOrganizations; invite: InviteMember; accept: AcceptInvitation; role: ChangeMembershipRole },
): Result<Transport, Failure> {
  if (!config?.admission || !config.readAdmission || !config.principalId || !deps?.create || !deps.list || !deps.invite || !deps.accept || !deps.role) return err(configuration());
  const createRoute: Route = {
    path: '/v1/org/organizations',
    method: 'POST',
    operation: 'org.http.create',
    admission: config.admission,
    handler: async (context: RequestContext) => {
      const decoded = body(context.request);
      if (!decoded.ok) return refused(decoded.error);
      const principal = config.principalId(context.request.admitted);
      if (!principal.ok) return refused(principal.error);
      const result = await deps.create.execute({ name: decoded.value.name, ownerPrincipalId: principal.value });
      if (!result.ok) return refused(result.error);
      return reply({
        organization: {
          id: result.value.organization.id,
          name: result.value.organization.name,
          created_at_ms: result.value.organization.createdAtMs,
        },
        owner: {
          id: result.value.owner.id,
          organization_id: result.value.owner.organizationId,
          principal_id: result.value.owner.principalId,
          role: result.value.owner.role,
          created_at_ms: result.value.owner.createdAtMs,
        },
      });
    },
  };
  const listRoute: Route = {
    path: '/v1/org/organizations',
    method: 'GET',
    operation: 'org.http.list',
    admission: config.readAdmission,
    handler: async (context: RequestContext) => {
      const limit = queryLimit(context.request.query);
      if (!limit.ok) return refused(limit.error);
      const principal = config.principalId(context.request.admitted);
      if (!principal.ok) return refused(principal.error);
      const result = await deps.list.execute(principal.value, limit.value);
      if (!result.ok) return refused(result.error);
      return reply({
        organizations: result.value.map((item) => ({
          organization: {
            id: item.organization.id,
            name: item.organization.name,
            created_at_ms: item.organization.createdAtMs,
          },
          membership: {
            id: item.membership.id,
            organization_id: item.membership.organizationId,
            principal_id: item.membership.principalId,
            role: item.membership.role,
            created_at_ms: item.membership.createdAtMs,
          },
        })),
        limit: limit.value,
      }, 200);
    },
  };
  const invitationBody = (request: FeatureRequest): Result<{ organizationId: ID; principalId: ID; role: Role }, Failure> => {
    const fields = stringFields(request.body, ['organization_id', 'principal_id', 'role']);
    if (!fields.ok) return fields;
    const organizationId = parse(fields.value.organization_id), principalId = parse(fields.value.principal_id);
    if (!organizationId.ok || !principalId.ok || !['admin', 'member'].includes(fields.value.role)) return err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
    return ok({ organizationId: organizationId.value, principalId: principalId.value, role: fields.value.role as Role });
  };
  const acceptBody = (request: FeatureRequest): Result<ID, Failure> => {
    const fields = stringFields(request.body, ['invitation_id']);
    if (!fields.ok) return fields;
    const invitationId = parse(fields.value.invitation_id);
    return invitationId.ok ? ok(invitationId.value) : err(failure('invalid', 'invalid request body', { type: 'http.invalid_body' }));
  };
  const roleBody = (request: FeatureRequest): Result<{ organizationId: ID; principalId: ID; role: Role }, Failure> => invitationBody(request);
  const projection = (s: { id: ID; organizationId: ID; inviterPrincipalId: ID; inviteePrincipalId: ID; role: Exclude<Role, 'owner'>; status: string; createdAtMs: number; expiresAtMs: number; resolvedAtMs?: number }) => ({
    id: s.id, organization_id: s.organizationId, inviter_principal_id: s.inviterPrincipalId, invitee_principal_id: s.inviteePrincipalId,
    role: s.role, status: s.status, created_at_ms: s.createdAtMs, expires_at_ms: s.expiresAtMs,
    ...(s.resolvedAtMs === undefined ? {} : { resolved_at_ms: s.resolvedAtMs }),
  });
  const membershipProjection = (s: { id: ID; organizationId: ID; principalId: ID; role: Role; createdAtMs: number }) => ({ id: s.id, organization_id: s.organizationId, principal_id: s.principalId, role: s.role, created_at_ms: s.createdAtMs });
  const inviteRoute: Route = {
    path: '/v1/org/invitations', method: 'POST', operation: 'org.http.invite', admission: config.admission,
    handler: async (context: RequestContext) => {
      const decoded = invitationBody(context.request);
      if (!decoded.ok) return refused(decoded.error);
      const principal = config.principalId(context.request.admitted);
      if (!principal.ok) return refused(principal.error);
      const result = await deps.invite.execute({ organizationId: decoded.value.organizationId, inviterId: principal.value, inviteeId: decoded.value.principalId, role: decoded.value.role });
      if (!result.ok) return refused(result.error);
      return reply({ invitation: projection(result.value.invitation) });
    },
  };
  const acceptRoute: Route = {
    path: '/v1/org/invitations/accept', method: 'POST', operation: 'org.http.invitation_accept', admission: config.admission,
    handler: async (context: RequestContext) => {
      const decoded = acceptBody(context.request);
      if (!decoded.ok) return refused(decoded.error);
      const principal = config.principalId(context.request.admitted);
      if (!principal.ok) return refused(principal.error);
      const result = await deps.accept.execute({ invitationId: decoded.value, inviteeId: principal.value });
      if (!result.ok) return refused(result.error);
      return reply({ invitation: projection(result.value.invitation), membership: membershipProjection(result.value.membership) }, 200);
    },
  };
  const roleRoute: Route = {
    path: '/v1/org/memberships/role', method: 'POST', operation: 'org.http.role_change', admission: config.admission,
    handler: async (context: RequestContext) => {
      const decoded = roleBody(context.request);
      if (!decoded.ok) return refused(decoded.error);
      const principal = config.principalId(context.request.admitted);
      if (!principal.ok) return refused(principal.error);
      const result = await deps.role.execute({ organizationId: decoded.value.organizationId, actorId: principal.value, targetId: decoded.value.principalId, role: decoded.value.role });
      if (!result.ok) return refused(result.error);
      return reply({ membership: membershipProjection(result.value.membership) }, 200);
    },
  };
  return ok({ routes: Object.freeze([listRoute, createRoute, inviteRoute, acceptRoute, roleRoute]) });
}
