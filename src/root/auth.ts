/**
 * Authentication composition (AUTH_BUILD.md): settings, adapters wrapped into
 * the application ports, the operations and the identity HTTP routes. Root owns
 * this wiring; no module imports it.
 */
import { randomFillSync } from 'node:crypto';
import type { Lookup, Reader, Var } from '../shared/env/index.js';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../shared/errors/index.js';
import {
  migration as eventsMigration,
  receiptsMigration as eventsReceiptsMigration,
} from '../shared/events/postgres/store.js';
import type { Route } from '../shared/http/nest/server.js';
import type { Entropy, ID, V7 } from '../shared/id/index.js';
import { Digest } from '../shared/keyed/index.js';
import type { Logger } from '../shared/logger/index.js';
import type { Database, Migration } from '../shared/postgres/index.js';
import type { SecretString } from '../shared/secret/index.js';
import {
  ChangePassword,
  Login,
  Logout,
  LogoutAll,
  Register,
  RequestReset,
  RequestVerification,
  ResetPassword,
  VerifyEmail,
  WebSocketTicket,
  type Config as OperationConfig,
  type MailDelivery,
  type Ports,
} from '../modules/identity/app/command/index.js';
import { Authenticate } from '../modules/identity/app/query/index.js';
import {
  createLimiter,
  loadBlocklist,
  undeliveredMail,
} from '../modules/identity/infra/local/index.js';
import {
  RedisLimiter,
  type RedisLimiterConfig,
} from '../modules/identity/infra/redis/index.js';
import {
  migration as identityMigration,
  Store,
  upgradeTicketMigration,
} from '../modules/identity/infra/postgres/index.js';
import { invitationMigration as orgInvitationMigration, migration as orgMigration } from '../modules/org/infra/postgres/index.js';
import {
  createMailer,
  type MailerConfig,
  type Security,
} from '../modules/identity/infra/smtp/index.js';
import {
  PasswordHasher,
  type Limits,
} from '../modules/identity/password-hash/index.js';
import { TokenCodec } from '../modules/identity/token-codec/index.js';
import {
  createTransport,
  principalIdOf,
  type TransportConfig,
  type SessionAdmission,
  type Transport,
} from '../modules/identity/transport/http/index.js';
import { AcceptInvitation, ChangeMembershipRole, CreateOrganization, InviteMember, ListOrganizations } from '../modules/org/app/index.js';
import { Store as OrganizationStore } from '../modules/org/infra/postgres/index.js';
import { createTransport as createOrganizationTransport } from '../modules/org/transport/http/index.js';

export interface AuthConfig {
  cookieSecure: boolean;
  devInsecureCookies: boolean;
  sessionCookie: string;
  csrfCookie: string;
  allowedOrigins: string[];
  csrfKey: SecretString;
  csrfTtlMs: number;
  operations: OperationConfig;
  hash: Limits;
  blocklistPath: string;
  limiterMode: 'local' | 'redis';
  redisLimiter?: RedisLimiterConfig;
  /** Present when AUTH_SMTP_HOST is set; absent keeps mail disabled. */
  mail?: MailerConfig;
  /** AUTH_SMTP_PASSWORD was supplied without AUTH_SMTP_USERNAME. */
  strayMailPassword: boolean;
}
/**
 * Reads AUTH_* once through the shared reader; call only when AUTH_ENABLED.
 * The SMTP password is read as a secret only alongside a username; a stray
 * password is detected through the raw lookup so its value is never recorded.
 */
export function loadAuthConfig(r: Reader, lookup: Lookup): AuthConfig {
  const cookieSecure = r.boolean('AUTH_COOKIE_SECURE', true);
  const smtpHost = r.string('AUTH_SMTP_HOST', '');
  const limiterMode = r.enumeration('AUTH_LIMITER', 'local', [
    'local',
    'redis',
  ]) as 'local' | 'redis';
  const redisLimiter =
    limiterMode === 'redis'
      ? {
          url: r.secret('AUTH_LIMITER_REDIS_URL'),
          timeoutMs: r.int('AUTH_LIMITER_TIMEOUT_MS', 500, 1, 10_000),
          maxKeys: r.int('AUTH_LIMITER_MAX_KEYS', 100_000, 1, 1_000_000),
        }
      : undefined;
  let mail: MailerConfig | undefined;
  let strayMailPassword = false;
  if (smtpHost !== '') {
    const username = r.string('AUTH_SMTP_USERNAME', '');
    strayMailPassword =
      username === '' && (lookup('AUTH_SMTP_PASSWORD') ?? '') !== '';
    mail = {
      host: smtpHost,
      port: r.int('AUTH_SMTP_PORT', 587, 1, 65535),
      security: r.enumeration('AUTH_SMTP_SECURITY', 'starttls', [
        'none',
        'starttls',
        'tls',
      ]) as Security,
      ...(username !== ''
        ? { username, password: r.secret('AUTH_SMTP_PASSWORD') }
        : {}),
      timeoutMs: r.int('AUTH_SMTP_TIMEOUT_MS', 5000, 1, 30_000),
      from: r.required('AUTH_MAIL_FROM'),
      fromName: r.string('AUTH_MAIL_FROM_NAME', 'n2f'),
      linkOrigin: r.required('AUTH_LINK_ORIGIN'),
      verifyPath: r.string('AUTH_VERIFY_PATH', '/verify-email'),
      resetPath: r.string('AUTH_RESET_PATH', '/reset-password'),
    };
  }
  return {
    ...(mail ? { mail } : {}),
    strayMailPassword,
    cookieSecure,
    devInsecureCookies: r.boolean('AUTH_DEV_INSECURE_COOKIES', false),
    sessionCookie: r.string(
      'AUTH_SESSION_COOKIE',
      cookieSecure ? '__Host-n2f_session' : 'n2f_session',
    ),
    csrfCookie: r.string(
      'AUTH_CSRF_COOKIE',
      cookieSecure ? '__Host-n2f_csrf' : 'n2f_csrf',
    ),
    allowedOrigins: r
      .required('AUTH_ALLOWED_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== ''),
    csrfKey: r.secret('AUTH_CSRF_KEY'),
    csrfTtlMs: r.int('AUTH_CSRF_TTL_MS', 3_600_000, 1, 3_600_000),
    operations: {
      sessionAbsoluteMs: r.int(
        'AUTH_SESSION_ABSOLUTE_MS',
        43_200_000,
        1000,
        253402300799999,
      ),
      sessionIdleMs: r.int(
        'AUTH_SESSION_IDLE_MS',
        1_800_000,
        1000,
        253402300799999,
      ),
      verificationTtlMs: r.int(
        'AUTH_VERIFICATION_TTL_MS',
        86_400_000,
        1000,
        253402300799999,
      ),
      resetTtlMs: r.int('AUTH_RESET_TTL_MS', 900_000, 1000, 253402300799999),
    },
    hash: {
      maxConcurrent: r.int('AUTH_HASH_MAX_CONCURRENT', 2, 1, 64),
      maxQueued: r.int('AUTH_HASH_MAX_QUEUED', 16, 0, 4096),
      queueWaitMs: r.int('AUTH_HASH_QUEUE_WAIT_MS', 2000, 1, 60_000),
    },
    blocklistPath: r.required('AUTH_BLOCKLIST_PATH'),
    limiterMode,
    ...(redisLimiter ? { redisLimiter } : {}),
  };
}
export interface Composed {
  routes: Route[];
  requireSession: SessionAdmission;
  socketAuthorize: Transport['authorizeWebSocket'];
  socketRevalidate: Transport['revalidateWebSocket'];
  /** Safe manifest additions: mail mode and blocklist size, never contents. */
  manifest: Readonly<Record<string, string | number>>;
}
export const osEntropy: Entropy = (bytes) => {
  randomFillSync(bytes);
};
const composition = (detail: string): Failure =>
  failure('invalid', 'invalid authentication composition: ' + detail, {
    type: 'identity.auth_configuration',
  });
/** Wiring order 1–4 of AUTH_BUILD.md; the caller registers the routes and logs the manifest. */
export async function composeAuth(
  auth: AuthConfig,
  deps: {
    database: Database;
    clock: { now(): Date };
    ids: V7;
    host: string;
    log: Logger;
    entropy?: Entropy;
    auditSchema?: Migration;
  },
): Promise<Result<Composed, Failure>> {
  const entropy = deps.entropy ?? osEntropy;
  const migrations: Migration[] = [
    eventsMigration(1),
    identityMigration(2),
    eventsReceiptsMigration(3),
  ];
  if (deps.auditSchema) migrations.push(deps.auditSchema);
  migrations.push(upgradeTicketMigration(5));
  migrations.push(orgMigration(6));
  migrations.push(orgInvitationMigration(7));
  const migrated = await deps.database.migrate(migrations);
  if (!migrated.ok) return migrated;
  const store = new Store(deps.database);
  const hasher = PasswordHasher.create(entropy, auth.hash);
  if (!hasher.ok) return hasher;
  const codec = TokenCodec.create(entropy);
  if (!codec.ok) return codec;
  const keyed = Digest.create(auth.csrfKey);
  if (!keyed.ok) return err(composition('AUTH_CSRF_KEY'));
  const limiter = auth.redisLimiter
    ? RedisLimiter.create(keyed.value, deps.clock, auth.redisLimiter)
    : createLimiter(keyed.value, deps.clock);
  if (!limiter.ok) return limiter;
  const blocklist = loadBlocklist(auth.blocklistPath);
  if (!blocklist.ok) return blocklist;
  if (auth.strayMailPassword)
    return err(composition('AUTH_SMTP_PASSWORD requires AUTH_SMTP_USERNAME'));
  let mail: MailDelivery = undeliveredMail();
  if (auth.mail) {
    const mailer = createMailer(auth.mail, deps.log);
    if (!mailer.ok) return mailer;
    mail = mailer.value;
  }
  const h = hasher.value,
    c = codec.value;
  const ports: Ports = {
    clock: deps.clock,
    ids: deps.ids,
    hasher: {
      hash: (password) => h.hash(password),
      verify: async (input, record) => {
        const outcome = await h.verify(input, record);
        return outcome.ok ? ok(outcome.value === 'match') : outcome;
      },
      verifyAbsent: async (input) => {
        const outcome = await h.verifyAbsent(input);
        return outcome.ok ? ok(false) : outcome;
      },
    },
    codec: {
      issue: (purpose) => c.issue(purpose),
      digest: (purpose, secret) => c.digest(purpose, secret),
    },
    policy: blocklist.value,
    limiter: limiter.value,
    mail,
    store,
  };
  const oc = auth.operations;
  const first = <T>(r: Result<T, Failure>): T | Failure =>
    r.ok ? r.value : r.error;
  const created = {
    register: first(Register.create(ports, oc)),
    requestVerification: first(RequestVerification.create(ports, oc)),
    verifyEmail: first(VerifyEmail.create(ports, oc)),
    login: first(Login.create(ports, oc)),
    authenticate: first(
      Authenticate.create(
        { clock: deps.clock, digester: ports.codec, resolver: store },
        { sessionIdleMs: oc.sessionIdleMs },
      ),
    ),
    logout: first(Logout.create(ports, oc)),
    logoutAll: first(LogoutAll.create(ports, oc)),
    changePassword: first(ChangePassword.create(ports, oc)),
    requestReset: first(RequestReset.create(ports, oc)),
    resetPassword: first(ResetPassword.create(ports, oc)),
    websocketTicket: first(WebSocketTicket.create({ clock: deps.clock, ids: deps.ids, codec: ports.codec, store }, oc)),
  };
  for (const v of Object.values(created))
    if (v && typeof v === 'object' && 'kind' in v && 'message' in v)
      return err(v as Failure);
  const transportConfig: TransportConfig = {
    sessionCookie: auth.sessionCookie,
    csrfCookie: auth.csrfCookie,
    secureCookies: auth.cookieSecure,
    devInsecureCookies: auth.devInsecureCookies,
    bindHost: deps.host,
    allowedOrigins: auth.allowedOrigins,
    csrfTtlMs: auth.csrfTtlMs,
    sessionAbsoluteMs: oc.sessionAbsoluteMs,
  };
  const transport = createTransport(transportConfig, {
    keyed: keyed.value,
    entropy,
    clock: deps.clock,
    digester: ports.codec,
    upgradeConsumer: store,
    operations: created as never,
  });
  if (!transport.ok) return transport;
  const organizationStore = new OrganizationStore(deps.database);
  const eligibility = {
    checkActive: async (principalId: ID) => {
      const record = await store.findByPrincipal(principalId);
      return record.ok
        ? ok({ eligible: record.value?.principal.status === 'active' })
        : record;
    },
  };
  const organization = CreateOrganization.create({
    clock: deps.clock,
    ids: deps.ids,
    eligibility,
    store: organizationStore,
  });
  if (!organization.ok) return organization;
  const organizationList = ListOrganizations.create(organizationStore);
  if (!organizationList.ok) return organizationList;
  const organizationInvite = InviteMember.create({ clock: deps.clock, ids: deps.ids, eligibility, store: organizationStore });
  if (!organizationInvite.ok) return organizationInvite;
  const organizationAccept = AcceptInvitation.create({ clock: deps.clock, ids: deps.ids, eligibility, store: organizationStore });
  if (!organizationAccept.ok) return organizationAccept;
  const organizationRole = ChangeMembershipRole.create(organizationStore);
  if (!organizationRole.ok) return organizationRole;
  const organizationTransport = createOrganizationTransport(
    { admission: transport.value.requireSessionPost, readAdmission: transport.value.requireSession, principalId: principalIdOf },
    { create: organization.value, list: organizationList.value, invite: organizationInvite.value, accept: organizationAccept.value, role: organizationRole.value },
  );
  if (!organizationTransport.ok) return organizationTransport;
  return ok({
    routes: [...transport.value.routes, ...organizationTransport.value.routes],
    requireSession: transport.value.requireSession,
    socketAuthorize: transport.value.authorizeWebSocket,
    socketRevalidate: transport.value.revalidateWebSocket,
    manifest: {
      'auth.mail': auth.mail ? 'smtp' : 'disabled',
      'auth.blocklist_entries': blocklist.value.size,
      'auth.limiter': auth.limiterMode === 'redis' ? 'redis' : 'process_local',
    },
  });
}
export const manifestVars = (vars: Var[]) => vars.map((v) => ({ ...v }));
