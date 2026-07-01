import { randomUUID } from "crypto";
import { Provider } from "../Provider.js";

/**
 * Default email provider. Records the send to the console and returns success
 * without contacting any external service — so the engine runs end-to-end with
 * zero credentials. Honors a deterministic failure hook for testing retry:
 * any recipient containing "fail@" throws.
 */
export class MockEmailProvider extends Provider {
  get name() {
    return "mock-email";
  }
  async send({ to, subject, body }) {
    if (String(to).includes("fail@")) {
      throw new Error("MockEmailProvider: simulated delivery failure");
    }
    console.log(`[notifications][mock-email] -> ${to} | ${subject} | ${body.length} bytes`);
    return {
      providerMessageId: `mock-email-${randomUUID()}`,
      status: "sent",
      raw: { accepted: [to], mock: true },
    };
  }
}

export default MockEmailProvider;
