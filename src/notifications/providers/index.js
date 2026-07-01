import { Channels } from "../config/events.js";
import config from "../config/notification.config.js";

import { MockEmailProvider } from "./email/MockEmailProvider.js";
import { SmtpEmailProvider } from "./email/SmtpEmailProvider.js";
import { MockSmsProvider } from "./sms/MockSmsProvider.js";
import { TwilioSmsProvider } from "./sms/TwilioSmsProvider.js";
import { MockWhatsAppProvider } from "./whatsapp/MockWhatsAppProvider.js";
import { MetaWhatsAppProvider } from "./whatsapp/MetaWhatsAppProvider.js";

/**
 * Provider registry. Maps the configured provider name (per channel) to an
 * adapter instance. Adding a vendor = add a class + one line here. Business
 * logic never references a vendor directly.
 */
const REGISTRY = {
  [Channels.EMAIL]: {
    mock: () => new MockEmailProvider(),
    smtp: () => new SmtpEmailProvider(),
    // ses / sendgrid / resend -> add adapters here
  },
  [Channels.SMS]: {
    mock: () => new MockSmsProvider(),
    twilio: () => new TwilioSmsProvider(),
    // msg91 / textlocal -> add adapters here
  },
  [Channels.WHATSAPP]: {
    mock: () => new MockWhatsAppProvider(),
    meta: () => new MetaWhatsAppProvider(),
    // twilio-whatsapp / interakt -> add adapters here
  },
};

const cache = new Map();

/** Resolve the active provider for a channel based on config (cached). */
export function getProvider(channel) {
  if (cache.has(channel)) return cache.get(channel);
  const name = config.providers[channel];
  const factory = REGISTRY[channel]?.[name];
  if (!factory) {
    throw new Error(
      `Unknown provider "${name}" for channel "${channel}". Available: ${Object.keys(
        REGISTRY[channel] || {}
      ).join(", ")}`
    );
  }
  const provider = factory();
  cache.set(channel, provider);
  return provider;
}

export default getProvider;
