import type { Document } from '../../domain/index.js';

export class InMemoryDocumentStore {
  readonly #documents = new Map<string, Document>();

  documentById(id: string): Document | undefined {
    return this.#documents.get(id);
  }

  documentsForOrganization(organizationId: string): readonly Document[] {
    return [...this.#documents.values()]
      .filter((document) => document.organizationId === organizationId)
      .sort((left, right) => {
        const time = left.createdAt.getTime() - right.createdAt.getTime();
        return time === 0 ? left.id.localeCompare(right.id) : time;
      });
  }

  add(document: Document): void {
    this.#documents.set(document.id, document);
  }

  replace(document: Document): void {
    this.#documents.set(document.id, document);
  }

  remove(id: string): void {
    this.#documents.delete(id);
  }
}
