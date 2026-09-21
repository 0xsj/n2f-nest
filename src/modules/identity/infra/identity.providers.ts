import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import { Factory as ProvenanceFactory } from '../../../shared/provenance/index.js';
import { EVENT_BUS, type EventBus } from '../../../platform/events/event-bus.js';
import {
  DATABASE,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../../platform/runtime/index.js';
import {
  AuthenticateIdentity,
  GetIdentity,
  GetCurrentIdentity,
  IssueVerificationChallenge,
  RegisterIdentity,
  RevokeSession,
  VerifyIdentity,
} from '../app/index.js';
import type {
  CredentialAuthenticatorReader,
  CurrentSessionReader,
  IdentityReader,
  IdentityViewReader,
  RegistrationWriter,
  SessionRevocationWriter,
  SessionWriter,
  VerificationChallengeReader,
  VerificationChallengeWriter,
  VerificationWriter,
} from '../app/ports/index.js';
import {
  DefaultPasswordPolicy,
  DefaultSessionPolicy,
  DefaultVerificationPolicy,
  InMemoryCredentialAuthenticatorReader,
  InMemoryCurrentSessionReader,
  InMemoryIdentityReader,
  InMemoryIdentityStore,
  InMemoryIdentityViewReader,
  InMemoryRegistrationWriter,
  InMemorySessionRevocationWriter,
  InMemorySessionWriter,
  InMemoryVerificationChallengeReader,
  InMemoryVerificationChallengeWriter,
  InMemoryVerificationWriter,
  NodePasswordCodec,
  NodeTokenCodec,
} from './in-memory/index.js';
import {
  PostgresCredentialAuthenticatorReader,
  PostgresCurrentSessionReader,
  PostgresIdentityReader,
  PostgresIdentityViewReader,
  PostgresRegistrationWriter,
  PostgresSessionRevocationWriter,
  PostgresSessionWriter,
  PostgresVerificationChallengeReader,
  PostgresVerificationChallengeWriter,
  PostgresVerificationWriter,
} from './postgres/index.js';

const PORTS = {
  registrationWriter: Symbol('identity.registrationWriter'),
  identityReader: Symbol('identity.identityReader'),
  credentialReader: Symbol('identity.credentialReader'),
  challengeReader: Symbol('identity.challengeReader'),
  challengeWriter: Symbol('identity.challengeWriter'),
  verificationWriter: Symbol('identity.verificationWriter'),
  sessionWriter: Symbol('identity.sessionWriter'),
  sessionReader: Symbol('identity.sessionReader'),
  sessionRevocationWriter: Symbol('identity.sessionRevocationWriter'),
  identityViewReader: Symbol('identity.identityViewReader'),
} as const;

function databaseOrThrow(database: Database | undefined) {
  if (!database) {
    throw new Error('PostgreSQL Identity storage was not initialized');
  }
  return database;
}

export const identityProviders: Provider[] = [
  {
    provide: InMemoryIdentityStore,
    useFactory: (publisher: EventBus) => new InMemoryIdentityStore(publisher),
    inject: [EVENT_BUS],
  },
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
  NodePasswordCodec,
  NodeTokenCodec,
  DefaultPasswordPolicy,
  DefaultSessionPolicy,
  DefaultVerificationPolicy,
  {
    provide: PORTS.registrationWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresRegistrationWriter(databaseOrThrow(database))
        : new InMemoryRegistrationWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.identityReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresIdentityReader(databaseOrThrow(database))
        : new InMemoryIdentityReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.credentialReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresCredentialAuthenticatorReader(databaseOrThrow(database))
        : new InMemoryCredentialAuthenticatorReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.challengeReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresVerificationChallengeReader(databaseOrThrow(database))
        : new InMemoryVerificationChallengeReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.challengeWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresVerificationChallengeWriter(databaseOrThrow(database))
        : new InMemoryVerificationChallengeWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.verificationWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresVerificationWriter(databaseOrThrow(database))
        : new InMemoryVerificationWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.sessionWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresSessionWriter(databaseOrThrow(database))
        : new InMemorySessionWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.sessionReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresCurrentSessionReader(databaseOrThrow(database))
        : new InMemoryCurrentSessionReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.sessionRevocationWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresSessionRevocationWriter(databaseOrThrow(database))
        : new InMemorySessionRevocationWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.identityViewReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      config.identityStorage === 'postgres'
        ? new PostgresIdentityViewReader(databaseOrThrow(database))
        : new InMemoryIdentityViewReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: RegisterIdentity,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      passwordPolicy: DefaultPasswordPolicy,
      passwordHasher: NodePasswordCodec,
      writer: RegistrationWriter,
    ) => new RegisterIdentity({ clock, ids, passwordPolicy, passwordHasher, writer }),
    inject: [SystemClock, V7, DefaultPasswordPolicy, NodePasswordCodec, PORTS.registrationWriter],
  },
  {
    provide: IssueVerificationChallenge,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      identities: IdentityReader,
      policy: DefaultVerificationPolicy,
      tokens: NodeTokenCodec,
      writer: VerificationChallengeWriter,
    ) => new IssueVerificationChallenge({ clock, ids, identities, policy, tokens, writer }),
    inject: [SystemClock, V7, PORTS.identityReader, DefaultVerificationPolicy, NodeTokenCodec, PORTS.challengeWriter],
  },
  {
    provide: VerifyIdentity,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      identities: IdentityReader,
      challenges: VerificationChallengeReader,
      tokens: NodeTokenCodec,
      writer: VerificationWriter,
    ) => new VerifyIdentity({ clock, ids, identities, challenges, tokens, writer }),
    inject: [SystemClock, V7, PORTS.identityReader, PORTS.challengeReader, NodeTokenCodec, PORTS.verificationWriter],
  },
  {
    provide: AuthenticateIdentity,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      credentials: CredentialAuthenticatorReader,
      passwords: NodePasswordCodec,
      sessions: DefaultSessionPolicy,
      tokens: NodeTokenCodec,
      writer: SessionWriter,
    ) => new AuthenticateIdentity({ clock, ids, credentials, passwords, sessions, tokens, writer }),
    inject: [SystemClock, V7, PORTS.credentialReader, NodePasswordCodec, DefaultSessionPolicy, NodeTokenCodec, PORTS.sessionWriter],
  },
  {
    provide: GetCurrentIdentity,
    useFactory: (
      clock: SystemClock,
      sessions: CurrentSessionReader,
      identities: IdentityViewReader,
    ) => new GetCurrentIdentity({ clock, sessions, identities }),
    inject: [SystemClock, PORTS.sessionReader, PORTS.identityViewReader],
  },
  {
    provide: GetIdentity,
    useFactory: (identities: IdentityViewReader) => new GetIdentity({ identities }),
    inject: [PORTS.identityViewReader],
  },
  {
    provide: RevokeSession,
    useFactory: (
      clock: SystemClock,
      ids: V7,
      sessions: CurrentSessionReader,
      writer: SessionRevocationWriter,
    ) => new RevokeSession({ clock, ids, sessions, writer }),
    inject: [SystemClock, V7, PORTS.sessionReader, PORTS.sessionRevocationWriter],
  },
];
