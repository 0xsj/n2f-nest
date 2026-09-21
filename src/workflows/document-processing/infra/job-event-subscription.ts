import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../shared/errors/index.js';
import { EVENT_BUS, type EventBus } from '../../../platform/events/event-bus.js';
import { Envelope } from '../../../shared/events/index.js';
import { parse, type ID } from '../../../shared/id/index.js';
import {
  actor,
  Factory as ProvenanceFactory,
  operation,
  type WorkContext,
} from '../../../shared/provenance/index.js';
import {
  BeginDocumentProcessing,
  CompleteDocumentProcessing,
  FailDocumentProcessing,
} from '../../../modules/document/app/index.js';

type JobEventAction = 'retry' | 'complete' | 'fail';

function id(value: unknown, field: string): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(failure('invalid', `event ${field} is invalid`, { type: 'workflow.invalid_event' }));
  }
  return parse(value);
}

function subject(value: unknown): Result<{ type: string; id: ID } | null, Failure> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'object' || Array.isArray(value)) {
    return err(failure('invalid', 'job event subject is invalid', { type: 'workflow.invalid_event' }));
  }
  const input = value as { type?: unknown; id?: unknown };
  if (typeof input.type !== 'string') {
    return err(failure('invalid', 'job event subject is invalid', { type: 'workflow.invalid_event' }));
  }
  const subjectId = id(input.id, 'subject.id');
  if (!subjectId.ok) return subjectId;
  return ok({ type: input.type, id: subjectId.value });
}

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

function actionFor(type: string): JobEventAction | null {
  switch (type) {
    case 'job.retried.v1':
      return 'retry';
    case 'job.completed.v1':
      return 'complete';
    case 'job.failed.v1':
    case 'job.canceled.v1':
      return 'fail';
    default:
      return null;
  }
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
    private readonly begin: BeginDocumentProcessing,
    private readonly complete: CompleteDocumentProcessing,
    private readonly fail: FailDocumentProcessing,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((event, signal) =>
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
    const action = actionFor(event.type);
    if (!action) return ok(undefined);

    const payload = event.payload();
    const jobSubject = subject(payload.subject);
    if (!jobSubject.ok) return jobSubject;
    if (jobSubject.value === null || jobSubject.value.type !== 'document') {
      return ok(undefined);
    }

    const organizationId = id(payload.organization_id, 'organization_id');
    if (!organizationId.ok) return organizationId;
    const operationName =
      action === 'retry'
        ? 'document.processing.start'
        : action === 'complete'
          ? 'document.processing.complete'
          : 'document.processing.fail';
    const work = childWork(this.factory, event.work, operationName);
    if (!work.ok) return work;

    if (action === 'retry') {
      const result = await this.begin.execute({
        organizationId: organizationId.value,
        documentId: jobSubject.value.id,
        work: work.value,
        signal,
      });
      if (!result.ok) this.logger.warn(`document retry projection failed: ${result.error.type}`);
      return result.ok ? ok(undefined) : result;
    }

    if (action === 'complete') {
      const result = await this.complete.execute({
        organizationId: organizationId.value,
        documentId: jobSubject.value.id,
        work: work.value,
        signal,
      });
      if (!result.ok) this.logger.warn(`document completion projection failed: ${result.error.type}`);
      return result.ok ? ok(undefined) : result;
    }

    const failureCode =
      typeof payload.failure_code === 'string'
        ? payload.failure_code
        : 'job.canceled';
    const result = await this.fail.execute({
      organizationId: organizationId.value,
      documentId: jobSubject.value.id,
      failureCode,
      work: work.value,
      signal,
    });
    if (!result.ok) this.logger.warn(`document failure projection failed: ${result.error.type}`);
    return result.ok ? ok(undefined) : result;
  }
}
