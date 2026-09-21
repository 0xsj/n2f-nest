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
import type {
  CurrentActorReader,
  MembershipReader,
  MembershipWriter,
} from '../ports/index.js';
import { MEMBERSHIP_EVENT_TYPES } from '../../domain/index.js';
import {
  dependencyFailure,
  idGenerationFailure,
  type OrganizationApplicationFailure,
} from '../failures.js';

export type RevokeMembershipCommand = Readonly<{
  sessionToken: SecretString;
  organizationId: ID;
  membershipId: ID;
  work: WorkContext;
  signal?: AbortSignal;
}>;

export type RevokeMembershipDependencies = Readonly<{
  clock: WallClock;
  ids: IDGenerator;
  actors: CurrentActorReader;
  memberships: MembershipReader;
  writer: MembershipWriter;
}>;

export type RevokeMembershipResult = Readonly<{
  membershipId: ID;
  status: 'revoked';
}>;

function nextId(ids: IDGenerator): Result<ID, OrganizationApplicationFailure> {
  const generated = ids.newId();
  return generated.ok
    ? generated
    : err(idGenerationFailure(generated.error, 'organization.membership.id_generation'));
}

function operationFailure(work: WorkContext): OrganizationApplicationFailure | undefined {
  return work.snapshot().operation === 'organization.membership.revoke'
    ? undefined
    : failure('invalid', 'membership revocation operation is invalid', {
        type: 'organization.membership.invalid_operation',
      });
}

function notFound(): OrganizationApplicationFailure {
  return failure('not_found', 'membership was not found', {
    type: 'organization.membership.not_found',
  });
}

function forbidden(): OrganizationApplicationFailure {
  return failure(
    'forbidden',
    'only an organization owner can revoke memberships',
    {
      type: 'organization.membership.revoke_forbidden',
    },
  );
}

export class RevokeMembership {
  constructor(private readonly dependencies: RevokeMembershipDependencies) {}

  async execute(
    command: RevokeMembershipCommand,
  ): Promise<Result<RevokeMembershipResult, OrganizationApplicationFailure>> {
    const operation = operationFailure(command.work);
    if (operation) return err(operation);

    const actor = await this.dependencies.actors.findCurrent(
      command.sessionToken,
      command.signal,
    );
    if (!actor.ok) return err(dependencyFailure(actor.error, 'identity.current.find'));

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

    if (membership.value.role === 'owner') {
      return err(
        failure(
          'forbidden',
          'the owner membership cannot be revoked by this command',
          {
            type: 'organization.membership.owner_locked',
          },
        ),
      );
    }

    const revokedAt = this.dependencies.clock.now();
    const revoked = membership.value.revoke(revokedAt);
    if (!revoked.ok) return revoked;

    const eventId = nextId(this.dependencies.ids);
    if (!eventId.ok) return eventId;

    const event = Envelope.create(
      eventId.value,
      MEMBERSHIP_EVENT_TYPES.revoked,
      revokedAt.getTime(),
      command.work,
      {
        organization_id: revoked.value.organizationId,
        identity_id: revoked.value.identityId,
        membership_id: revoked.value.id,
        role: revoked.value.role,
      },
    );
    if (!event.ok) return err(dependencyFailure(event.error, 'event.create'));

    const committed = await this.dependencies.writer.commit({
      membership: revoked.value,
      event: event.value,
      work: command.work,
      signal: command.signal,
    });
    if (!committed.ok) return err(dependencyFailure(committed.error, 'membership.commit'));

    return ok({
      membershipId: revoked.value.id,
      status: 'revoked',
    });
  }
}
