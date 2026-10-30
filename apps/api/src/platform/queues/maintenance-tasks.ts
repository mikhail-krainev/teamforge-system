import { Injectable } from '@nestjs/common';
import type { QueueName } from './queue-definitions.js';

/** A periodic job of the `maintenance` queue owned by a module (e.g. `deletion-scheduler`). */
export interface MaintenanceTask {
  /** Job name and scheduler key; also what a manual run enqueues. */
  readonly name: string;
  readonly everyMs: number;
  /** Returns the number of things it handled (logged). Must be safe to run twice in a row. */
  run(): Promise<number>;
}

/** Registry that modules fill in `onModuleInit`; the MaintenanceProcessor schedules and runs them. */
@Injectable()
export class MaintenanceTasks {
  private readonly tasks = new Map<string, MaintenanceTask>();

  register(task: MaintenanceTask): void {
    if (this.tasks.has(task.name)) throw new Error(`Maintenance task ${task.name} already exists`);
    this.tasks.set(task.name, task);
  }

  get(name: string): MaintenanceTask | undefined {
    return this.tasks.get(name);
  }

  all(): MaintenanceTask[] {
    return [...this.tasks.values()];
  }
}

/** A repeating job of a queue of its own (not `maintenance`); the schedule is registered by the worker only. */
export interface RepeatingJob {
  readonly queue: QueueName;
  /** Fixed scheduler key: registering it again on every start is idempotent. */
  readonly key: string;
  readonly jobName: string;
  readonly everyMs: number;
}

/**
 * Registry that modules fill in `onModuleInit`; the MaintenanceProcessor (worker process only) upserts the
 * schedules at start. The API process never touches Redis at boot, so it starts while Redis is down.
 */
@Injectable()
export class RepeatingJobs {
  private readonly jobs = new Map<string, RepeatingJob>();

  register(job: RepeatingJob): void {
    const id = `${job.queue}:${job.key}`;
    if (this.jobs.has(id)) throw new Error(`Repeating job ${id} already exists`);
    this.jobs.set(id, job);
  }

  all(): RepeatingJob[] {
    return [...this.jobs.values()];
  }
}

/** A handler of one job name of the `timers` queue that a module owns (e.g. `rewards-cooling-end`). */
export type TimerHandler = (data: Record<string, unknown>) => Promise<unknown>;

/**
 * Registry of the `timers` jobs of the modules. One queue has one worker (`TeamsTimersProcessor`), which asks
 * this registry for every job name it does not handle itself; a module registers its names in `onModuleInit`.
 */
@Injectable()
export class TimerHandlers {
  private readonly handlers = new Map<string, TimerHandler>();

  register(name: string, handler: TimerHandler): void {
    if (this.handlers.has(name)) throw new Error(`Timer job ${name} already exists`);
    this.handlers.set(name, handler);
  }

  get(name: string): TimerHandler | undefined {
    return this.handlers.get(name);
  }
}
