import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import { Factory as ProvenanceFactory } from '../../../shared/provenance/index.js';
import {
  DATABASE,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../../platform/runtime/index.js';
import {
  AddMembership,
  AcceptInvitation,
  ChangeMembershipRole,
  CreateOrganization,
  GetOrganizationMembership,
  InviteIdentity,
  ListCurrentOrganizations,
  RevokeInvitation,
  RevokeMembership,
  type CurrentActorReader,
  type IdentityReferenceReader,
  type InvitationReader,
  type InvitationAcceptanceWriter,
  type InvitationWriter,
  type MembershipReader,
  type MembershipWriter,
  type OrganizationReader,
  type OrganizationWriter,
} from '../app/index.js';
import {
  IdentityCurrentActorReader,
  IdentityReferenceReaderAdapter,
  InMemoryInvitationReader,
  InMemoryInvitationAcceptanceWriter,
  InMemoryInvitationWriter,
  InMemoryMembershipReader,
  InMemoryMembershipWriter,
  InMemoryOrganizationReader,
  InMemoryOrganizationStore,
  InMemoryOrganizationWriter,
} from './in-memory/index.js';
import {
  PostgresMembershipReader,
  PostgresMembershipWriter,
  PostgresInvitationReader,
  PostgresInvitationAcceptanceWriter,
  PostgresInvitationWriter,
  PostgresOrganizationReader,
  PostgresOrganizationWriter,
} from './postgres/index.js';

const PORTS = {
  currentActorReader: Symbol('organization.currentActorReader'),
  identityReferenceReader: Symbol('organization.identityReferenceReader'),
  membershipReader: Symbol('organization.membershipReader'),
  membershipWriter: Symbol('organization.membershipWriter'),
  invitationReader: Symbol('organization.invitationReader'),
  invitationWriter: Symbol('organization.invitationWriter'),
  invitationAcceptanceWriter: Symbol('organization.invitationAcceptanceWriter'),
  reader: Symbol('organization.reader'),
  writer: Symbol('organization.writer'),
} as const;

function databaseOrThrow(database: Database | undefined): Database {
  if (!database) {
    throw new Error('PostgreSQL Organization storage was not initialized');
  }
  return database;
}

export const organizationProviders: Provider[] = [
  SystemClock,
  {
    provide: V7,
    useFactory: (clock: SystemClock) => new V7(clock),
    inject: [SystemClock],
  },
  {
    provide: ProvenanceFactory,
    useFactory: (clock: SystemClock, ids: V7) => new ProvenanceFactory(clock, ids),
    inject: [SystemClock, V7],
  },
  InMemoryOrganizationStore,
  InMemoryOrganizationWriter,
  IdentityCurrentActorReader,
  IdentityReferenceReaderAdapter,
  InMemoryMembershipReader,
  InMemoryMembershipWriter,
  InMemoryInvitationReader,
  InMemoryInvitationWriter,
  InMemoryInvitationAcceptanceWriter,
  InMemoryOrganizationReader,
  {
    provide: PORTS.currentActorReader,
    useExisting: IdentityCurrentActorReader,
  },
  {
    provide: PORTS.identityReferenceReader,
    useExisting: IdentityReferenceReaderAdapter,
  },
  {
    provide: PORTS.membershipReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryOrganizationStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresMembershipReader(databaseOrThrow(database))
        : new InMemoryMembershipReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryOrganizationStore],
  },
  {
    provide: PORTS.membershipWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryMembershipWriter,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresMembershipWriter(databaseOrThrow(database))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryMembershipWriter],
  },
  {
    provide: PORTS.invitationReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryOrganizationStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresInvitationReader(databaseOrThrow(database))
        : new InMemoryInvitationReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryOrganizationStore],
  },
  {
    provide: PORTS.invitationWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryInvitationWriter,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresInvitationWriter(databaseOrThrow(database))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryInvitationWriter],
  },
  {
    provide: PORTS.invitationAcceptanceWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryInvitationAcceptanceWriter,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresInvitationAcceptanceWriter(databaseOrThrow(database))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryInvitationAcceptanceWriter],
  },
  {
    provide: PORTS.reader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryOrganizationStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresOrganizationReader(databaseOrThrow(database))
        : new InMemoryOrganizationReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryOrganizationStore],
  },
  {
    provide: PORTS.writer,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      inMemory: InMemoryOrganizationWriter,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresOrganizationWriter(databaseOrThrow(database))
        : inMemory,
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryOrganizationWriter],
  },
  {
    provide: AddMembership,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      identities: IdentityReferenceReader,
      memberships: MembershipReader,
      writer: MembershipWriter,
    ) => new AddMembership({ clock, ids, actors, identities, memberships, writer }),
    inject: [
      SystemClock,
      V7,
      PORTS.currentActorReader,
      PORTS.identityReferenceReader,
      PORTS.membershipReader,
      PORTS.membershipWriter,
    ],
  },
  {
    provide: InviteIdentity,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      identities: IdentityReferenceReader,
      memberships: MembershipReader,
      invitations: InvitationReader,
      writer: InvitationWriter,
    ) => new InviteIdentity({ clock, ids, actors, identities, memberships, invitations, writer }),
    inject: [
      SystemClock,
      V7,
      PORTS.currentActorReader,
      PORTS.identityReferenceReader,
      PORTS.membershipReader,
      PORTS.invitationReader,
      PORTS.invitationWriter,
    ],
  },
  {
    provide: AcceptInvitation,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      invitations: InvitationReader,
      memberships: MembershipReader,
      writer: InvitationAcceptanceWriter,
    ) => new AcceptInvitation({ clock, ids, actors, invitations, memberships, writer }),
    inject: [
      SystemClock,
      V7,
      PORTS.currentActorReader,
      PORTS.invitationReader,
      PORTS.membershipReader,
      PORTS.invitationAcceptanceWriter,
    ],
  },
  {
    provide: RevokeInvitation,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      invitations: InvitationReader,
      memberships: MembershipReader,
      writer: InvitationWriter,
    ) => new RevokeInvitation({ clock, ids, actors, invitations, memberships, writer }),
    inject: [
      SystemClock,
      V7,
      PORTS.currentActorReader,
      PORTS.invitationReader,
      PORTS.membershipReader,
      PORTS.invitationWriter,
    ],
  },
  {
    provide: ChangeMembershipRole,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      memberships: MembershipReader,
      writer: MembershipWriter,
    ) => new ChangeMembershipRole({ clock, ids, actors, memberships, writer }),
    inject: [
      SystemClock,
      V7,
      PORTS.currentActorReader,
      PORTS.membershipReader,
      PORTS.membershipWriter,
    ],
  },
  {
    provide: RevokeMembership,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      memberships: MembershipReader,
      writer: MembershipWriter,
    ) => new RevokeMembership({ clock, ids, actors, memberships, writer }),
    inject: [
      SystemClock,
      V7,
      PORTS.currentActorReader,
      PORTS.membershipReader,
      PORTS.membershipWriter,
    ],
  },
  {
    provide: ListCurrentOrganizations,
    useFactory: (
      actors: CurrentActorReader,
      organizations: OrganizationReader,
    ) => new ListCurrentOrganizations({ actors, organizations }),
    inject: [PORTS.currentActorReader, PORTS.reader],
  },
  {
    provide: GetOrganizationMembership,
    useFactory: (
      actors: CurrentActorReader,
      organizations: OrganizationReader,
    ) => new GetOrganizationMembership({ actors, organizations }),
    inject: [PORTS.currentActorReader, PORTS.reader],
  },
  {
    provide: CreateOrganization,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      actors: CurrentActorReader,
      writer: OrganizationWriter,
    ) => new CreateOrganization({ clock, ids, actors, writer }),
    inject: [SystemClock, V7, PORTS.currentActorReader, PORTS.writer],
  },
];
