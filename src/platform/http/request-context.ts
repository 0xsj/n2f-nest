import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { ID } from '../../shared/id/index.js';
import type { TraceRef } from '../../shared/telemetry/index.js';

type RequestState = Readonly<{
  requestId: ID;
  trace: TraceRef;
}>;

/** Keeps request-bound transport metadata available without polluting app ports. */
@Injectable()
export class RequestContext {
  readonly #storage = new AsyncLocalStorage<RequestState>();

  run<T>(requestId: ID, trace: TraceRef, callback: () => T): T {
    return this.#storage.run(Object.freeze({ requestId, trace }), callback);
  }

  requestId(): ID | undefined {
    return this.#storage.getStore()?.requestId;
  }

  trace(): TraceRef | undefined {
    return this.#storage.getStore()?.trace;
  }
}
