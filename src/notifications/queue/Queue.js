/**
 * Queue contract. The engine enqueues a notification id and starts a worker
 * with a processor function. Any backend (in-process, BullMQ/Redis, SQS)
 * implements these three methods.
 *
 *   start(processor: async (notificationId) => void): void
 *   enqueue(notificationId: string): Promise<void>   // hint to process soon
 *   stop(): Promise<void>
 *
 * Retry/backoff scheduling is owned by the Dispatcher (it sets nextAttemptAt on
 * the record); the queue is only responsible for *delivering due records to the
 * processor* without blocking the request path and without losing them across
 * restarts.
 */
export class Queue {
  // eslint-disable-next-line no-unused-vars
  start(processor) {
    throw new Error("Queue.start not implemented");
  }
  // eslint-disable-next-line no-unused-vars
  async enqueue(notificationId) {
    throw new Error("Queue.enqueue not implemented");
  }
  async stop() {}
}

export default Queue;
