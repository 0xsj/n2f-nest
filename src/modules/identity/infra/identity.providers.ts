import type { Provider } from '@nestjs/common';
import { SystemClock } from '../../../shared/clock/index.js';
import { V7 } from '../../../shared/id/index.js';
import type { Database } from '../../../shared/postgres/index.js';
import { Factory as ProvenanceFactory } from '../../../shared/provenance/index.js';
import { EVENT_BUS, type EventBus } from '../../../platform/events/event-bus.js';
import { MAILER, type Mailer } from '../../../platform/mail/index.js';
import {
  DATABASE,
  requireDatabase,
  RUNTIME_CONFIG,
  type RuntimeConfig,
  usesPostgres,
} from '../../../platform/runtime/index.js';
import {
  AuthenticateIdentity,
  GetIdentity,
  GetCurrentIdentity,
  IssueVerificationChallenge,
  PruneSessions,
  RegisterIdentity,
  ResendVerification,
  SignUp,
  RevokeSession,
  VerifyIdentity,
} from '../app/index.js';
import type {
  ActiveSessionReader,
  CredentialAuthenticatorReader,
  CurrentSessionReader,
  IdentityReader,
  IdentityViewReader,
  RegistrationWriter,
  SessionActivityWriter,
  SessionPruner,
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
  InMemoryActiveSessionReader,
  InMemorySessionActivityWriter,
  InMemorySessionPruner,
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
  PostgresActiveSessionReader,
  PostgresCredentialAuthenticatorReader,
  PostgresCurrentSessionReader,
  PostgresSessionActivityWriter,
  PostgresSessionPruner,
  PostgresIdentityReader,
  PostgresIdentityViewReader,
  PostgresRegistrationWriter,
  PostgresSessionRevocationWriter,
  PostgresSessionWriter,
  PostgresVerificationChallengeReader,
  PostgresVerificationChallengeWriter,
  PostgresVerificationWriter,
} from './postgres/index.js';
import { SESSION_SETTINGS, sessionSettings, type SessionSettings } from './session-settings.js';
import { SessionPruning } from './session-pruning.js';
import { PlatformIdentityMailer } from './mail.js';

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
  sessionActivityWriter: Symbol('identity.sessionActivityWriter'),
  activeSessionReader: Symbol('identity.activeSessionReader'),
  sessionPruner: Symbol('identity.sessionPruner'),
  identityViewReader: Symbol('identity.identityViewReader'),
} as const;

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
  { provide: SESSION_SETTINGS, useFactory: () => sessionSettings() },
  {
    provide: DefaultSessionPolicy,
    useFactory: (settings: SessionSettings) => new DefaultSessionPolicy(settings),
    inject: [SESSION_SETTINGS],
  },
  DefaultVerificationPolicy,
  {
    provide: PORTS.sessionActivityWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      usesPostgres(config)
        ? new PostgresSessionActivityWriter(requireDatabase(database, 'Identity'))
        : new InMemorySessionActivityWriter(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.activeSessionReader,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      usesPostgres(config)
        ? new PostgresActiveSessionReader(requireDatabase(database, 'Identity'))
        : new InMemoryActiveSessionReader(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.sessionPruner,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      usesPostgres(config)
        ? new PostgresSessionPruner(requireDatabase(database, 'Identity'))
        : new InMemorySessionPruner(store),
    inject: [RUNTIME_CONFIG, DATABASE, InMemoryIdentityStore],
  },
  {
    provide: PORTS.registrationWriter,
    useFactory: (
      config: RuntimeConfig,
      database: Database | undefined,
      store: InMemoryIdentityStore,
    ) =>
      usesPostgres(config)
        ? new PostgresRegistrationWriter(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresIdentityReader(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresCredentialAuthenticatorReader(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresVerificationChallengeReader(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresVerificationChallengeWriter(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresVerificationWriter(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresSessionWriter(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresCurrentSessionReader(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresSessionRevocationWriter(requireDatabase(database, 'Identity'))
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
      usesPostgres(config)
        ? new PostgresIdentityViewReader(requireDatabase(database, 'Identity'))
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
      active: ActiveSessionReader,
      tokens: NodeTokenCodec,
      writer: SessionWriter,
    ) => new AuthenticateIdentity({ clock, ids, credentials, passwords, sessions, active, tokens, writer }),
    inject: [SystemClock, V7, PORTS.credentialReader, NodePasswordCodec, DefaultSessionPolicy, PORTS.activeSessionReader, NodeTokenCodec, PORTS.sessionWriter],
  },
  {
    provide: GetCurrentIdentity,
    useFactory: (
      clock: SystemClock,
      sessions: CurrentSessionReader,
      identities: IdentityViewReader,
      policy: DefaultSessionPolicy,
      activity: SessionActivityWriter,
    ) => new GetCurrentIdentity({ clock, sessions, identities, policy, activity }),
    inject: [SystemClock, PORTS.sessionReader, PORTS.identityViewReader, DefaultSessionPolicy, PORTS.sessionActivityWriter],
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
  {
    provide: PruneSessions,
    useFactory: (clock: SystemClock, policy: DefaultSessionPolicy, pruner: SessionPruner) =>
      new PruneSessions({ clock, policy, pruner }),
    inject: [SystemClock, DefaultSessionPolicy, PORTS.sessionPruner],
  },
  SessionPruning,
  {
    provide: PlatformIdentityMailer,
    useFactory: (mailer: Mailer, config: RuntimeConfig) =>
      new PlatformIdentityMailer(mailer, config.mail.appUrl),
    inject: [MAILER, RUNTIME_CONFIG],
  },
  {
    provide: SignUp,
    useFactory: (
      register: RegisterIdentity,
      challenges: IssueVerificationChallenge,
      mailer: PlatformIdentityMailer,
    ) => new SignUp({ register, challenges, mailer }),
    inject: [RegisterIdentity, IssueVerificationChallenge, PlatformIdentityMailer],
  },
  {
    provide: ResendVerification,
    useFactory: (
      credentials: CredentialAuthenticatorReader,
      challenges: IssueVerificationChallenge,
      mailer: PlatformIdentityMailer,
    ) => new ResendVerification({ credentials, challenges, mailer }),
    inject: [PORTS.credentialReader, IssueVerificationChallenge, PlatformIdentityMailer],
  },
];
