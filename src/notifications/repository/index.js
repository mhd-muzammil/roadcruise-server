import config from "../config/notification.config.js";
import { JsonNotificationRepository } from "./NotificationRepository.js";

/**
 * Repository factory. Zero-infra default = JSON. When DATABASE_URL is present,
 * a Postgres adapter (same interface) can be loaded here. The rest of the
 * engine is agnostic to which one is active.
 */
let instance = null;

export function getRepository() {
  if (instance) return instance;
  if (config.databaseUrl) {
    // Extension point: implement PostgresNotificationRepository with the same
    // contract and activate it here. Kept lazy so pg is never a hard dependency.
    console.warn(
      "[notifications] DATABASE_URL set but PostgresNotificationRepository is not bundled in this pass — " +
        "falling back to JSON store. Implement repository/PostgresNotificationRepository.js to enable."
    );
  }
  instance = new JsonNotificationRepository();
  return instance;
}

export default getRepository;
