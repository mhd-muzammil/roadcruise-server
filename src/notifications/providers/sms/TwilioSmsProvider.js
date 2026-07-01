import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";

/**
 * Real SMS via Twilio. DORMANT unless NOTIF_SMS_PROVIDER=twilio. The twilio SDK
 * is lazy-imported. Swap to MSG91/TextLocal by adding a sibling adapter with the
 * same contract and registering it in providers/index.js.
 */
export class TwilioSmsProvider extends Provider {
  constructor() {
    super();
    this._client = null;
  }
  get name() {
    return "twilio-sms";
  }
  async _c() {
    if (this._client) return this._client;
    let twilio;
    try {
      twilio = (await import("twilio")).default;
    } catch {
      throw new Error("NOTIF_SMS_PROVIDER=twilio but 'twilio' is not installed. Run: npm i twilio");
    }
    const { accountSid, authToken } = config.twilio;
    if (!accountSid || !authToken) throw new Error("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN required");
    this._client = twilio(accountSid, authToken);
    return this._client;
  }
  async send({ to, body }) {
    const client = await this._c();
    const msg = await client.messages.create({ from: config.twilio.smsFrom, to, body });
    return { providerMessageId: msg.sid, status: msg.status || "sent", raw: { sid: msg.sid } };
  }
}

export default TwilioSmsProvider;
