import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ok, type Failure, type Result } from '../../../shared/errors/index.js';
import { EVENT_BUS, type EventBus } from '../../../platform/events/event-bus.js';
import { Envelope } from '../../../shared/events/index.js';
import {
  actor,
  Factory as ProvenanceFactory,
  operation,
  type WorkContext,
} from '../../../shared/provenance/index.js';
import {
  CompleteDocumentProcessing,
  FailDocumentProcessing,
  RetryDocumentProcessing,
} from '../../../modules/document/commands.js';
import { decodeJobEvent } from './job-events.js';

function childWork(
  factory: ProvenanceFactory,
  parent: WorkContext,
  operationName: string,
): Result<WorkContext, Failure> {
  const operationValue = operation(operationName);
  if (!operationValue.ok) return operationValue;
  const executor = actor('service', 'n2f-nest-document-processing');
  if (!executor.ok) return executor;
  const execution = factory.execute(parent, { executor: executor.value, attempt: 1 });
  if (!execution.ok) return execution;
  const child = factory.child(execution.value, {
    operation: operationValue.value,
    executor: executor.value,
  });
  return child.ok ? { ok: true, value: child.value.workContext() } : child;
}

@Injectable()
export class DocumentProcessingJobEventSubscription
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('DocumentProcessingWorkflow');
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly factory: ProvenanceFactory,
    private readonly retry: RetryDocumentProcessing,
    private readonly complete: CompleteDocumentProcessing,
    private readonly fail: FailDocumentProcessing,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe('document-processing', (event, signal) =>
      this.handle(event, signal),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private async handle(
    event: Envelope,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    const decoded = decodeJobEvent(event);
    if (!decoded.ok) return decoded;
    const outcome = decoded.value;
    if (!outcome) return ok(undefined);

    const operationName =
      outcome.action === 'retry'
        ? 'document.processing.retry'
        : outcome.action === 'complete'
          ? 'document.processing.complete'
          : 'document.processing.fail';
    const work = childWork(this.factory, event.work, operationName);
    if (!work.ok) return work;

    // The job is the document's processing run; the document ignores outcomes
    // of any other run and of older attempts, so redelivered, late or
    // superseded events are harmless no-ops.
    const command = {
      organizationId: outcome.organizationId,
      documentId: outcome.documentId,
      processingRun: outcome.jobId,
      attempt: outcome.attempt,
      work: work.value,
      signal,
    };
    const result =
      outcome.action === 'fail'
        ? await this.fail.execute({ ...command, failureCode: outcome.failureCode })
        : outcome.action === 'retry'
          ? await this.retry.execute(command)
          : await this.complete.execute(command);
    if (!result.ok) {
      this.logger.warn(`document ${outcome.action} projection failed: ${result.error.type}`);
      return result;
    }
    return ok(undefined);
  }
}
