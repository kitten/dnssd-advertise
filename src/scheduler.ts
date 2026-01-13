import { SCHEDULER_MIN, SCHEDULER_WINDOW } from './constants';

export const enum TaskKind {
  SEND,
  PROBE,
  ANNOUNCE,
  REOPEN,
}

interface Timer {
  time: number;
  tasks: Set<() => unknown>;
  timeout: ReturnType<typeof setTimeout>;
}

const timersByKind = new Map<TaskKind, Set<Timer>>();

const randomDelay = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (max - min + 1));

const shouldRetry = (kind: TaskKind, attempt: number): boolean => {
  switch (kind) {
    case TaskKind.SEND:
      return attempt < 4;
    case TaskKind.PROBE:
      return attempt < 4;
    case TaskKind.ANNOUNCE:
      return attempt < 3;
    case TaskKind.REOPEN:
      return true;
  }
};

const getDelay = (kind: TaskKind, attempt: number): number => {
  switch (kind) {
    case TaskKind.SEND:
      return randomDelay(20, 120);
    case TaskKind.PROBE:
      return attempt ? 250 : randomDelay(0, 250);
    case TaskKind.ANNOUNCE:
      return attempt ? 1000 * 2 ** (Math.min(attempt, 3) - 1) : 0;
    case TaskKind.REOPEN:
      return 6000;
  }
};

const runTimer = (
  kind: TaskKind,
  delay: number,
  task: () => void
): (() => void) => {
  const time = Date.now() + delay;
  let timers = timersByKind.get(kind);
  let timer: Timer | undefined;
  if (timers) {
    for (const scheduledTimer of timers) {
      if (
        kind === TaskKind.REOPEN ||
        Math.abs(scheduledTimer.time - time) <= SCHEDULER_WINDOW
      ) {
        timer = scheduledTimer;
        break;
      }
    }
  } else {
    timers = new Set();
    timersByKind.set(kind, timers);
  }
  if (!timer) {
    const timeout = setTimeout(() => {
      timers.delete(timer!);
      for (const task of timer!.tasks) task();
    }, delay);
    if ('unref' in timeout) {
      timeout.unref();
    }
    timers.add(
      (timer = {
        time,
        tasks: new Set(),
        timeout,
      })
    );
  }
  timer.tasks.add(task);
  return () => {
    timer.tasks.delete(task);
    if (!timer.tasks.size) {
      clearTimeout(timer.timeout);
      timers.delete(timer);
    }
  };
};

export interface TaskInfo<T> {
  readonly attempt: number;
  retry(delay?: number): Promise<T>;
}

export interface Task<T> {
  (info: TaskInfo<T>): PromiseLike<T> | T;
}

export interface Scheduler {
  schedule<T>(kind: TaskKind, task?: Task<T>): Promise<T>;
  cancel(): void;
}

export class AbortError extends Error {
  static isAbortError(input: any): input is AbortError {
    return input && typeof input === 'object' && input.name === 'AbortError';
  }

  constructor() {
    super('Operation cancelled');
    this.name = 'AbortError';
  }
}

export function createScheduler(): Scheduler {
  const cancelFns = new Set<() => void>();
  async function schedule<T>(kind: TaskKind, task?: Task<T>): Promise<T> {
    async function schedule(attempt: number, delay?: number) {
      if (!delay) delay = getDelay(kind, attempt);
      return new Promise<T>(async (resolve, reject) => {
        const delayMin = Math.max(delay, SCHEDULER_MIN);
        const cancelTimer = runTimer(kind, delayMin, async () => {
          cancelFns.delete(onCancel);
          let isRetrying = false;
          try {
            let result: T;
            if (task) {
              result = await task({
                attempt,
                async retry(delay) {
                  isRetrying = true;
                  return schedule(attempt + 1, delay);
                },
              });
            }
            resolve(result!);
          } catch (error) {
            if (!isRetrying && shouldRetry(kind, attempt)) {
              schedule(attempt + 1, delay).then(resolve, reject);
            } else {
              reject(error);
            }
          }
        });
        function onCancel() {
          reject(new AbortError());
          cancelTimer();
        }
        cancelFns.add(onCancel);
      });
    }
    return await schedule(0);
  }
  return {
    schedule,
    cancel() {
      for (const cancel of cancelFns) cancel();
      cancelFns.clear();
    },
  };
}

export function cancelAll() {
  for (const timers of timersByKind.values()) {
    for (const timer of timers) {
      clearTimeout(timer.timeout);
    }
  }
  timersByKind.clear();
}
