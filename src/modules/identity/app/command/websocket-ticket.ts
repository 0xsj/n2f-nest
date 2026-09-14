import { err, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import type * as p from '../../../../shared/provenance/index.js';
import { SecretString } from '../../../../shared/secret/index.js';
import { UpgradeTicket } from '../../domain/upgrade-ticket.js';
import type { AuthenticatedPrincipal } from '../query/index.js';
import { validateConfig, type Config } from './config.js';
import type { Clock, IDSource, TokenCodecPort, UpgradeTicketStore } from './ports.js';
import { newId, nowMs, sessionRejected } from './shared.js';

export type WebSocketTicketPorts = Readonly<{ clock: Clock; ids: IDSource; codec: TokenCodecPort; store: UpgradeTicketStore }>;
export type WebSocketTicketInput = Readonly<{ caller: AuthenticatedPrincipal; work: p.WorkContext }>;
export type WebSocketTicketResult = Readonly<{ ticket: SecretString; expiresAtMs: number }>;

export class WebSocketTicket {
  readonly #ports: WebSocketTicketPorts;
  private constructor(ports: WebSocketTicketPorts) { this.#ports = ports; Object.freeze(this); }
  static create(ports: WebSocketTicketPorts, config: Config): Result<WebSocketTicket, Failure> {
    const c = validateConfig(config);
    return c.ok ? ok(new WebSocketTicket(ports)) : c;
  }
  async execute(input: WebSocketTicketInput): Promise<Result<WebSocketTicketResult, Failure>> {
    const { caller } = input;
    if (!caller || !caller.principalId || !caller.sessionId || caller.authEpoch < 1) return err(sessionRejected());
    const now = nowMs(this.#ports.clock);
    if (!now.ok) return now;
    const token = this.#ports.codec.issue('websocket_upgrade');
    if (!token.ok) return token;
    const id = newId(this.#ports.ids);
    if (!id.ok) return id;
    const expiresAtMs = now.value + 30_000;
    const ticket = UpgradeTicket.issue(id.value, caller.sessionId, token.value.digest, now.value, expiresAtMs);
    if (!ticket.ok) return ticket;
    const stored = await this.#ports.store.issueUpgradeTicket({ ticket: ticket.value.snapshot(), expectedAuthEpoch: caller.authEpoch });
    if (!stored.ok) return stored;
    return stored.value === 'committed' ? ok({ ticket: token.value.secret, expiresAtMs }) : err(sessionRejected());
  }
}
