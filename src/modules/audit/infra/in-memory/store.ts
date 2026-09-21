import type { AuditEntry } from '../../domain/index.js';

/** Process-local audit projection for the integration harness. */
export class InMemoryAuditStore {
  readonly #byEventId = new Map<string, AuditEntry>();
  readonly #entries: AuditEntry[] = [];

  findByEventId(eventId: string): AuditEntry | undefined {
    return this.#byEventId.get(eventId);
  }

  add(entry: AuditEntry): void {
    this.#byEventId.set(entry.eventId, entry);
    this.#entries.push(entry);
  }

  list(): readonly AuditEntry[] {
    return [...this.#entries];
  }
}
