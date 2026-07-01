import { randomUUID } from "crypto";
import { Provider } from "../Provider.js";

export class MockWhatsAppProvider extends Provider {
  get name() {
    return "mock-whatsapp";
  }
  async send({ to, body, meta = {} }) {
    if (String(to).includes("000000")) {
      throw new Error("MockWhatsAppProvider: simulated delivery failure");
    }
    const btns = meta.buttons ? ` [buttons:${meta.buttons.length}]` : "";
    console.log(`[notifications][mock-whatsapp] -> ${to} | ${body}${btns}`);
    return { providerMessageId: `mock-wa-${randomUUID()}`, status: "sent", raw: { mock: true } };
  }
}

export default MockWhatsAppProvider;
