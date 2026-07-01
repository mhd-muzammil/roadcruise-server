import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";

/**
 * Real WhatsApp via Meta Cloud API. DORMANT unless NOTIF_WHATSAPP_PROVIDER=meta.
 * Uses global fetch (Node 18+), so no SDK dependency. Sends a text message;
 * rich templates/buttons can be layered on by extending the request body.
 */
export class MetaWhatsAppProvider extends Provider {
  get name() {
    return "meta-whatsapp";
  }
  async send({ to, body }) {
    const { phoneNumberId, accessToken, apiVersion } = config.metaWhatsApp;
    if (!phoneNumberId || !accessToken) {
      throw new Error("META_WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN required for meta provider");
    }
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: String(to).replace(/[^\d]/g, ""),
        type: "text",
        text: { body },
      }),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Meta WhatsApp send failed (${res.status}): ${JSON.stringify(raw)}`);
    }
    return { providerMessageId: raw.messages?.[0]?.id || null, status: "sent", raw };
  }
}

export default MetaWhatsAppProvider;
