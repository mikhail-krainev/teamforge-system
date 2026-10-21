import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobProcessor, ProcessorRegistry } from '../../../../platform/queues/queue-workers.js';
import type { QueueJob } from '../../../../platform/queues/queues.service.js';
import {
  COMPLETION_CHECK_QUEUE,
  CompletionCheckService,
} from '../services/completion-check.service.js';

function checkIdOf(job: QueueJob): string {
  const id = job.data['checkId'];
  if (typeof id !== 'string' || id === '') throw new Error('completion-check job without checkId');
  return id;
}

/** BullMQ processor of the checks of readiness to complete (`auto-checks`, FR-WORK-13): one job per check. */
@Injectable()
export class CompletionCheckProcessor implements JobProcessor, OnModuleInit {
  readonly queue = COMPLETION_CHECK_QUEUE;

  constructor(
    @Inject(ProcessorRegistry) private readonly registry: ProcessorRegistry,
    @Inject(CompletionCheckService) private readonly checks: CompletionCheckService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  process(job: QueueJob): Promise<void> {
    return this.checks.run(checkIdOf(job));
  }

  onExhausted(job: QueueJob): Promise<void> {
    return this.checks.fail(checkIdOf(job));
  }
}
