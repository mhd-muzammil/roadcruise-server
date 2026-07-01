import { Queue } from "./Queue.js";

/**
 * BullMQ + Redis adapter. DORMANT by default. Activates only when REDIS_URL is
 * set AND `bullmq` + `ioredis` are installed (lazy-imported so they are never
 * hard dependencies in the zero-infra path).
 *
 * Implemented as a thin shim over the same contract; the Dispatcher is unchanged.
 */
export class BullMQQueue extends Queue {
  constructor({ redisUrl, concurrency = 8, queueName = "rc-notifications" }) {
    super();
    this.redisUrl = redisUrl;
    this.concurrency = concurrency;
    this.queueName = queueName;
    this._queue = null;
    this._worker = null;
  }

  async _lib() {
    try {
      return await import("bullmq");
    } catch {
      throw new Error(
        "REDIS_URL is set but 'bullmq' is not installed. Run: npm i bullmq ioredis"
      );
    }
  }

  async start(processor) {
    const { Queue: BQ, Worker } = await this._lib();
    const connection = { url: this.redisUrl };
    this._queue = new BQ(this.queueName, { connection });
    this._worker = new Worker(
      this.queueName,
      async (job) => processor(job.data.notificationId),
      { connection, concurrency: this.concurrency }
    );
    this._worker.on("failed", (job, err) =>
      console.error(`[notifications] bullmq job failed:`, err?.message)
    );
  }

  async enqueue(notificationId) {
    if (!this._queue) throw new Error("BullMQQueue not started");
    await this._queue.add("notify", { notificationId }, { removeOnComplete: true });
  }

  async stop() {
    await this._worker?.close();
    await this._queue?.close();
  }
}

export default BullMQQueue;
