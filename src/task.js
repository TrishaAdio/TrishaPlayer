/**
 * Cancellation. Every skill takes a Task and checks it often, so "trisha come here"
 * can interrupt a mining run mid-swing instead of queueing behind it.
 */
import { log } from './util/log.js';
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
    /** Last time this task did something real. Drives the stuck watchdog. */
    this.progressAt = Date.now();
    this._lastBeatLog = 0;
  }

  /**
   * "I am still getting somewhere."
   *
   * The stuck watchdog cannot distinguish a frozen action from a slow one by watching
   * her position: chopping means walking between trees, smelting means deliberately
   * standing still. A live run had `craft` cancelled one second after it started
   * because it inherited the previous action's staleness.
   *
   * A skill that is genuinely progressing says so. That resets the watchdog AND emits a
   * throttled heartbeat, so a hung task can never masquerade as work in the log.
   */
  beat(text = null, { everyMs = 12000 } = {}) {
    this.progressAt = Date.now();
    if (!text) return;
    if (this.progressAt - this._lastBeatLog < everyMs) return;
    this._lastBeatLog = this.progressAt;
    log.act(`[${this.label}] ${text}`);
  }

  /** Milliseconds since this task last reported real progress. */
  get sinceProgress() {
    return Date.now() - this.progressAt;
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
