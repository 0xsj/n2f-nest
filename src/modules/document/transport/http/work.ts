import { Injectable } from '@nestjs/common';
import {
  actor,
  anonymous,
  attribution,
  Factory as ProvenanceFactory,
  operation,
  type WorkContext,
} from '../../../../shared/provenance/index.js';
import type { Failure, Result } from '../../../../shared/errors/index.js';
import type { ID } from '../../../../shared/id/index.js';
import { RequestContext } from '../../../../platform/http/request-context.js';

@Injectable()
export class DocumentHttpWork {
  constructor(
    private readonly factory: ProvenanceFactory,
    private readonly requestContext: RequestContext,
  ) {}

  open(operationName: string): Result<WorkContext, Failure> {
    const operationValue = operation(operationName);
    if (!operationValue.ok) return operationValue;

    const attributionValue = attribution({ initiator: anonymous() });
    if (!attributionValue.ok) return attributionValue;

    const executor = actor('service', 'n2f-nest-http');
    if (!executor.ok) return executor;

    const requestId: ID | undefined = this.requestContext.requestId();
    const scope = this.factory.open({
      workId: requestId,
      origin: 'request',
      operation: operationValue.value,
      attribution: attributionValue.value,
      executor: executor.value,
    });
    return scope.ok ? { ok: true, value: scope.value.workContext() } : scope;
  }
}
