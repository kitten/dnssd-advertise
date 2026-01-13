import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createScheduler, cancelAll, TaskKind, AbortError } from '../scheduler';

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cancelAll();
    vi.useRealTimers();
  });

  describe('createScheduler', () => {
    it('schedules and executes a task', async () => {
      const scheduler = createScheduler();
      const task = vi.fn().mockReturnValue('result');

      const promise = scheduler.schedule(TaskKind.SEND, task);
      await vi.runAllTimersAsync();

      expect(await promise).toBe('result');
      expect(task).toHaveBeenCalledTimes(1);
      expect(task).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 0 })
      );
    });

    it('provides attempt count to task', async () => {
      const scheduler = createScheduler();
      const attempts: number[] = [];

      const promise = scheduler.schedule(TaskKind.PROBE, async info => {
        attempts.push(info.attempt);
        if (info.attempt < 2) {
          return info.retry();
        }
        return 'done';
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(attempts).toEqual([0, 1, 2]);
    });

    it('retries on error up to max attempts for SEND tasks', async () => {
      const scheduler = createScheduler();
      let attempts = 0;

      const promise = scheduler.schedule(TaskKind.SEND, () => {
        attempts++;
        if (attempts < 4) {
          throw new Error('fail');
        }
        return 'success';
      });

      await vi.runAllTimersAsync();

      expect(await promise).toBe('success');
      expect(attempts).toBe(4);
    });

    it('retries on error up to max attempts for PROBE tasks', async () => {
      const scheduler = createScheduler();
      let attempts = 0;

      const promise = scheduler.schedule(TaskKind.PROBE, () => {
        attempts++;
        if (attempts < 4) {
          throw new Error('fail');
        }
        return 'success';
      });

      await vi.runAllTimersAsync();

      expect(await promise).toBe('success');
      expect(attempts).toBe(4);
    });

    it('stops retrying ANNOUNCE tasks after max attempts', async () => {
      const scheduler = createScheduler();
      let attempts = 0;
      await Promise.all([
        expect(
          scheduler.schedule(TaskKind.ANNOUNCE, () => {
            attempts++;
            throw new Error('fail');
          })
        ).rejects.toThrow('fail'),
        vi.runAllTimersAsync(),
      ]);
      expect(attempts).toBeGreaterThanOrEqual(3);
    });

    it('always retries REOPEN tasks', async () => {
      const scheduler = createScheduler();
      let attempts = 0;
      await Promise.all([
        expect(
          scheduler.schedule(TaskKind.REOPEN, _info => {
            attempts++;
            if (attempts < 10) {
              throw new Error('fail');
            }
            return 'recovered';
          })
        ).resolves.toBe('recovered'),
        vi.runAllTimersAsync(),
      ]);
      expect(attempts).toBe(10);
    });

    it('allows manual retry with custom delay', async () => {
      const scheduler = createScheduler();
      const startTime = Date.now();
      let resolvedTime = 0;
      await Promise.all([
        expect(
          scheduler.schedule(TaskKind.SEND, async info => {
            if (info.attempt === 0) {
              return info.retry(500);
            }
            resolvedTime = Date.now();
            return 'done';
          })
        ).resolves.toBe('done'),
        vi.runAllTimersAsync(),
      ]);
      expect(resolvedTime - startTime).toBeGreaterThanOrEqual(500);
    });
  });

  describe('cancel', () => {
    it('cancels pending tasks with AbortError', async () => {
      const scheduler = createScheduler();
      const task = vi.fn().mockReturnValue('result');

      const promise = scheduler.schedule(TaskKind.REOPEN, task);
      scheduler.cancel();

      await expect(promise).rejects.toThrow(AbortError);
      expect(task).not.toHaveBeenCalled();
    });

    it('cancels multiple pending tasks', async () => {
      const scheduler = createScheduler();
      const task1 = vi.fn();
      const task2 = vi.fn();

      const promise1 = scheduler.schedule(TaskKind.SEND, task1);
      const promise2 = scheduler.schedule(TaskKind.PROBE, task2);

      scheduler.cancel();

      await expect(promise1).rejects.toThrow(AbortError);
      await expect(promise2).rejects.toThrow(AbortError);
    });

    it('allows scheduling new tasks after cancel', async () => {
      const scheduler = createScheduler();

      const promise1 = scheduler.schedule(TaskKind.SEND, () => 'first');
      scheduler.cancel();

      await expect(promise1).rejects.toThrow(AbortError);

      const promise2 = scheduler.schedule(TaskKind.SEND, () => 'second');
      await vi.runAllTimersAsync();

      expect(await promise2).toBe('second');
    });
  });

  describe('AbortError', () => {
    it('has correct name property', () => {
      const error = new AbortError();
      expect(error.name).toBe('AbortError');
      expect(error.message).toBe('Operation cancelled');
    });

    it('is detected by isAbortError', () => {
      const error = new AbortError();
      expect(AbortError.isAbortError(error)).toBe(true);
    });

    it('returns false for regular errors', () => {
      expect(AbortError.isAbortError(new Error('test'))).toBe(false);
    });

    it('returns false for non-objects', () => {
      expect(AbortError.isAbortError(null)).toBeFalsy();
      expect(AbortError.isAbortError(undefined)).toBeFalsy();
      expect(AbortError.isAbortError(42)).toBeFalsy();
    });

    it('returns true for duck-typed AbortError', () => {
      const fakeAbort = { name: 'AbortError' };
      expect(AbortError.isAbortError(fakeAbort)).toBe(true);
    });
  });

  describe('cancelAll', () => {
    it('clears all global timers across schedulers', async () => {
      const scheduler1 = createScheduler();
      const scheduler2 = createScheduler();

      const task1 = vi.fn();
      const task2 = vi.fn();

      scheduler1.schedule(TaskKind.REOPEN, task1);
      scheduler2.schedule(TaskKind.REOPEN, task2);
      cancelAll();

      await vi.advanceTimersByTimeAsync(60000);

      expect(task1).not.toHaveBeenCalled();
      expect(task2).not.toHaveBeenCalled();
    });
  });

  describe('timer coalescing', () => {
    it('coalesces tasks scheduled within the time window', async () => {
      const scheduler = createScheduler();
      const executionTimes: number[] = [];

      const promises = [
        scheduler.schedule(TaskKind.SEND, () => {
          executionTimes.push(Date.now());
          return 1;
        }),
        scheduler.schedule(TaskKind.SEND, () => {
          executionTimes.push(Date.now());
          return 2;
        }),
        scheduler.schedule(TaskKind.SEND, () => {
          executionTimes.push(Date.now());
          return 3;
        }),
      ];

      await vi.runAllTimersAsync();
      await Promise.all(promises);

      const [first, ...rest] = executionTimes;
      for (const time of rest) {
        expect(Math.abs(time - first)).toBeLessThanOrEqual(100);
      }
    });

    it('REOPEN tasks always coalesce regardless of timing', async () => {
      const scheduler1 = createScheduler();
      const scheduler2 = createScheduler();

      let task1Ran = false;
      let task2Ran = false;
      let timeDiff = 0;
      let task1Time = 0;

      const promise1 = scheduler1.schedule(TaskKind.REOPEN, () => {
        task1Ran = true;
        task1Time = Date.now();
      });

      await vi.advanceTimersByTimeAsync(1000);

      const promise2 = scheduler2.schedule(TaskKind.REOPEN, () => {
        task2Ran = true;
        timeDiff = Date.now() - task1Time;
      });

      await Promise.all([vi.runAllTimersAsync(), promise1, promise2]);

      expect(task1Ran).toBe(true);
      expect(task2Ran).toBe(true);
      expect(timeDiff).toBe(0);
    });
  });

  describe('delay configuration', () => {
    it('uses random delay between 20-120ms for SEND tasks', async () => {
      const scheduler = createScheduler();
      const startTime = Date.now();
      let endTime = 0;

      const promise = scheduler.schedule(TaskKind.SEND, () => {
        endTime = Date.now();
        return 'done';
      });

      await vi.runAllTimersAsync();
      await promise;

      const delay = endTime - startTime;
      expect(delay).toBeGreaterThanOrEqual(20);
      expect(delay).toBeLessThanOrEqual(120);
    });

    it('uses 250ms delay for PROBE retries', async () => {
      const scheduler = createScheduler();
      let firstAttemptTime = 0;
      let secondAttemptTime = 0;

      const promise = scheduler.schedule(TaskKind.PROBE, info => {
        if (info.attempt === 0) {
          firstAttemptTime = Date.now();
          return info.retry();
        }
        secondAttemptTime = Date.now();
        return 'done';
      });

      await vi.runAllTimersAsync();
      await promise;

      const delay = secondAttemptTime - firstAttemptTime;
      expect(delay).toBe(250);
    });

    it('uses exponential backoff for ANNOUNCE retries', async () => {
      const scheduler = createScheduler();
      const attemptTimes: number[] = [];

      const promise = scheduler.schedule(TaskKind.ANNOUNCE, info => {
        attemptTimes.push(Date.now());
        if (info.attempt < 3) {
          return info.retry();
        }
        return 'done';
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(attemptTimes[1] - attemptTimes[0]).toBe(1000);
      expect(attemptTimes[2] - attemptTimes[1]).toBe(2000);
      expect(attemptTimes[3] - attemptTimes[2]).toBe(4000);
    });

    it('uses 6000ms delay for REOPEN tasks', async () => {
      const scheduler = createScheduler();
      const startTime = Date.now();
      let endTime = 0;

      const promise = scheduler.schedule(TaskKind.REOPEN, () => {
        endTime = Date.now();
        return 'done';
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(endTime - startTime).toBe(6000);
    });
  });

  describe('async task handling', () => {
    it('handles async tasks correctly', async () => {
      const scheduler = createScheduler();

      const promise = scheduler.schedule(TaskKind.SEND, async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'async result';
      });

      await vi.runAllTimersAsync();

      expect(await promise).toBe('async result');
    });

    it('handles rejected async tasks', async () => {
      const scheduler = createScheduler();
      let attempts = 0;
      await Promise.all([
        expect(
          scheduler.schedule(TaskKind.ANNOUNCE, async () => {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 50));
            throw new Error('async error');
          })
        ).rejects.toThrow('async error'),
        vi.runAllTimersAsync(),
      ]);
      expect(attempts).toBeGreaterThanOrEqual(3);
    });
  });
});
