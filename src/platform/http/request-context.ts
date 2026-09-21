import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { ID } from '../../shared/id/index.js';

type RequestState = Readonly<{
  requestId: ID;
}>;

/** Keeps request-bound transport metadata available without polluting app ports. */
@Injectable()
export class RequestContext {
  readonly #storage = new AsyncLocalStorage<RequestState>();

  run<T>(requestId: ID, callback: () => T): T {
    return this.#storage.run(Object.freeze({ requestId }), callback);
  }

  requestId(): ID | undefined {
    return this.#storage.getStore()?.requestId;
  }
}
