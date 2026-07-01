import config from "../config/notification.config.js";
import { InProcessQueue } from "./InProcessQueue.js";
import { BullMQQueue } from "./BullMQQueue.js";

/**
 * Queue factory. REDIS_URL present => BullMQ/Redis. Otherwise the zero-infra
 * in-process worker. The engine never knows or cares which is active.
 */
export function createQueue({ repository }) {
  if (config.redisUrl) {
    console.log("[notifications] using BullMQ/Redis queue");
    return new BullMQQueue({ redisUrl: config.redisUrl, concurrency: config.concurrency });
  }
  console.log("[notifications] using in-process queue (zero-infra default)");
  return new InProcessQueue({ repository, concurrency: config.concurrency });
}

export default createQueue;
