import { err, failure, ok, type Failure, type Result } from '../../../shared/errors/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import { TokenDigest } from './token.js';
import { isOptionalTime, isRecord, isTime } from './bounds.js';

export type UpgradeTicketSnapshot = Readonly<{
  id: ID;
  sessionId: ID;
  tokenDigest: TokenDigest;
  issuedAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
}>;

const MAX_TTL_MS = 30_000;
const invalid = () => failure('invalid', 'invalid websocket upgrade ticket', { type: 'identity.upgrade_ticket_invalid' });
const rejected = () => failure('unauthenticated', 'websocket upgrade ticket rejected', { type: 'identity.upgrade_ticket_rejected' });
const normalize = (s: UpgradeTicketSnapshot): UpgradeTicketSnapshot | undefined => {
  if (!isRecord(s)) return undefined;
  const id = parse(s.id), session = parse(s.sessionId);
  if (!id.ok || !session.ok || !TokenDigest.valid(s.tokenDigest) || s.tokenDigest.purpose() !== 'websocket_upgrade' || !isTime(s.issuedAtMs) || !isTime(s.expiresAtMs) || s.expiresAtMs <= s.issuedAtMs || s.expiresAtMs - s.issuedAtMs > MAX_TTL_MS || !isOptionalTime(s.consumedAtMs) || (s.consumedAtMs !== undefined && (s.consumedAtMs < s.issuedAtMs || s.consumedAtMs >= s.expiresAtMs))) return undefined;
  return { id: id.value, sessionId: session.value, tokenDigest: s.tokenDigest, issuedAtMs: s.issuedAtMs, expiresAtMs: s.expiresAtMs, ...(s.consumedAtMs === undefined ? {} : { consumedAtMs: s.consumedAtMs }) };
};

export class UpgradeTicket {
  readonly #state: Readonly<UpgradeTicketSnapshot>;
  private constructor(state: UpgradeTicketSnapshot) { this.#state = Object.freeze({ ...state }); }
  static issue(id: ID, sessionId: ID, tokenDigest: TokenDigest, issuedAtMs: number, expiresAtMs: number): Result<UpgradeTicket, Failure> {
    return UpgradeTicket.restore({ id, sessionId, tokenDigest, issuedAtMs, expiresAtMs });
  }
  static restore(s: UpgradeTicketSnapshot): Result<UpgradeTicket, Failure> {
    const state = normalize(s);
    return state === undefined ? err(invalid()) : ok(new UpgradeTicket(state));
  }
  snapshot(): UpgradeTicketSnapshot { return { ...this.#state }; }
  consume(nowMs: number): Result<UpgradeTicket, Failure> {
    const state = normalize(this.#state);
    if (state === undefined || !isTime(nowMs)) return err(invalid());
    if (state.consumedAtMs !== undefined || nowMs < state.issuedAtMs || nowMs >= state.expiresAtMs) return err(rejected());
    return ok(new UpgradeTicket({ ...state, consumedAtMs: nowMs }));
  }
}
