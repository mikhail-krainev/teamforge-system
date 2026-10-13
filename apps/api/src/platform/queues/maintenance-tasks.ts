import { Injectable } from '@nestjs/common';

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
