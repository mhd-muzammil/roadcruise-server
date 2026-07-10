import { Queue } from "./Queue.js";

/**
 * Zero-infra default queue. A non-blocking background worker that:
 *   - polls the repository for due records (QUEUED or FAILED with nextAttemptAt
 *     in the past), so nothing is lost across process restarts;
 *   - processes up to `concurrency` records at a time;
 *   - never blocks the HTTP request path (booking creation returns instantly).
 *
 * Drop-in replaceable by BullMQQueue when REDIS_URL is set.
 */
export class InProcessQueue extends Queue {
  constructor({ repository, concurrency = 4, pollMs = 1000, recoverEveryMs = 60000 }) {
    super();
    this.repository = repository;
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    // How often to sweep for records orphaned in PROCESSING (crash/restart mid-send).
    this.recoverEveryMs = recoverEveryMs;
    this._lastRecover = 0;
    this.inFlight = new Set();
    this.processor = null;
    this.timer = null;
    this.running = false;
  }

  start(processor) {
    this.processor = processor;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this._recoverStale();
        await this._drain();
      } catch (err) {
        console.error("[notifications] queue tick error:", err.message);
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.pollMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Throttled sweep: return records stuck in PROCESSING to the retry path. */
  async _recoverStale() {
    if (typeof this.repository.recoverStale !== "function") return;
    const now = Date.now();
    if (now - this._lastRecover < this.recoverEveryMs) return;
    this._lastRecover = now;
    const n = await this.repository.recoverStale();
    if (n) console.log(`[notifications] queue recovered ${n} stale record(s) from PROCESSING`);
  }

  async _drain() {
    if (this.inFlight.size >= this.concurrency) return;
    const due = await this.repository.findDue();
    for (const record of due) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.inFlight.has(record.id)) continue;
      this.inFlight.add(record.id);
      // fire concurrently; do not await in the loop
      Promise.resolve(this.processor(record.id))
        .catch((err) =>
          console.error(`[notifications] processor error (${record.id}):`, err.message)
        )
        .finally(() => this.inFlight.delete(record.id));
    }
  }

  async enqueue() {
    // Hint: wake the loop immediately rather than waiting for the next poll.
    if (this.running && this.inFlight.size < this.concurrency) {
      setImmediate(() => this._drain().catch(() => {}));
    }
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

export default InProcessQueue;
