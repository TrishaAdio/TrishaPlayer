/**
 * Cancellation. Every skill takes a Task and checks it often, so "trisha come here"
 * can interrupt a mining run mid-swing instead of queueing behind it.
 */
export class AbortError extends Error {
  constructor(msg = 'aborted') {
    super(msg);
    this.name = 'AbortError';
    this.aborted = true;
  }
}

export class Task {
  constructor(label = 'task') {
    this.label = label;
    this.aborted = false;
    this.reason = null;
    this.startedAt = Date.now();
  }

  cancel(reason = 'cancelled') {
    this.aborted = true;
    this.reason = reason;
  }

  check() {
    if (this.aborted) throw new AbortError(this.reason || 'aborted');
  }

  get elapsed() {
    return Date.now() - this.startedAt;
  }

  /** Sleep that wakes early if the task gets cancelled. */
  async sleep(ms) {
    const step = 60;
    let waited = 0;
    while (waited < ms) {
      this.check();
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
    }
  }
}

export const NOOP_TASK = new Task('noop');
