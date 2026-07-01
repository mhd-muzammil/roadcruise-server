import { randomUUID } from "crypto";
import { Provider } from "../Provider.js";

export class MockSmsProvider extends Provider {
  get name() {
    return "mock-sms";
  }
  async send({ to, body }) {
    if (String(to).includes("000000")) {
      throw new Error("MockSmsProvider: simulated delivery failure");
    }
    console.log(`[notifications][mock-sms] -> ${to} | ${body}`);
    return { providerMessageId: `mock-sms-${randomUUID()}`, status: "sent", raw: { mock: true } };
  }
}

export default MockSmsProvider;
