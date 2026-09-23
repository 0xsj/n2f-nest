import {
  err,
  failure,
  ok,
  type Result,
} from '../../../../shared/errors/index.js';
import { Envelope } from '../../../../shared/events/index.js';
import type { WallClock } from '../../../../shared/clock/index.js';
import type { ID, IDGenerator } from '../../../../shared/id/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import {
  MEMBERSHIP_EVENT_TYPES,
  type MembershipRole,
} from '../../domain/index.js';
import type {
  CurrentActorReader,
  MembershipReader,
  MembershipWriter,
} from '../ports/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export type ChangeMembershipRoleCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  membershipId: ID;
  role: unknown;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type ChangeMembershipRoleDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  memberships: MembershipReader;
  writer: MembershipWriter;
}>;

export type ChangeMembershipRoleResult = Readonly<{
  membershipId: ID;
  role: MembershipRole;
}>;

function nextId(ids: IDGenerator): Result<ID, OrganizationApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error, 'organization.membership.id_generation'));
}

function operationFailure(work: WorkContext): OrganizationApplicationFailure | undefined {
  return work.snapshot().operation === 'organization.membership.role.change'
    ? undefined
    : failure('invalid', 'membership role change operation is invalid', {
        type: 'organization.membership.invalid_operation',
      });
}

function notFound(): OrganizationApplicationFailure {
  return failure('not_found', 'membership was not found', {
    type: 'organization.membership.not_found',
  });
}

function forbidden(): OrganizationApplicationFailure {
  return failure('forbidden', 'only an organization owner can change roles', {
    type: 'organization.membership.role_forbidden',
  });
}

export class ChangeMembershipRole {
  constructor(
    private readonly dependencies: ChangeMembershipRoleDependencies,
  ) {}

  async execute(
    command: ChangeMembershipRoleCommand,
  ): Promise<Result<ChangeMembershipRoleResult, OrganizationApplicationFailure>> {
    const operation = operationFailure(command.work);
    if (operation) return err(operation);

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

    // Authorize before looking the target up, so a non-owner cannot tell
    // which IDs exist in another organization.
    const actorMembership =
      await this.dependencies.memberships.findActiveForIdentity(
        command.organizationId,
        actor.value.identityId,
        command.signal,
      );
    if (!actorMembership.ok) return err(dependencyFailure(actorMembership.error, 'membership.findActiveForIdentity'));
    if (
      actorMembership.value === null ||
      actorMembership.value.role !== 'owner'
    ) {
      return err(forbidden());
    }

    const membership = await this.dependencies.memberships.findById(
      command.membershipId,
      command.signal,
    );
    if (!membership.ok) return err(dependencyFailure(membership.error, 'membership.findById'));
    if (
      membership.value === null ||
      membership.value.organizationId !== command.organizationId
    ) {
      return err(notFound());
    }

    if (membership.value.role === 'owner') {
      return err(
        failure(
          'forbidden',
          'the owner membership cannot be changed by this command',
          {
            type: 'organization.membership.owner_locked',
          },
        ),
      );
    }

    const changedAt = this.dependencies.clock.now();
    const changed = membership.value.changeRole(command.role, changedAt);
    if (!changed.ok) return changed;

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;

    const event = Envelope.create(
      eventId.value,
      MEMBERSHIP_EVENT_TYPES.roleChanged,
      changedAt.getTime(),
      command.work,
      {
        organization_id: changed.value.organizationId,
        identity_id: changed.value.identityId,
        membership_id: changed.value.id,
        previous_role: membership.value.role,
        role: changed.value.role,
      },
      { kind: 'membership', id: changed.value.id },
      changed.value.organizationId,
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      membership: changed.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'membership.commit'));

    return ok({
      membershipId: changed.value.id,
      role: changed.value.role,
    });
  }
}
