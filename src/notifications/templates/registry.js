import { Channels } from "../config/events.js";
import { emailTemplates } from "./email/index.js";
import { smsTemplates } from "./sms/index.js";
import { whatsappTemplates } from "./whatsapp/index.js";

const byChannel = {
  [Channels.EMAIL]: emailTemplates,
  [Channels.SMS]: smsTemplates,
  [Channels.WHATSAPP]: whatsappTemplates,
};

/**
 * Resolve a template definition for (channel, event). Falls back to the
 * channel's `generic` template so an event without a dedicated template never
 * crashes the engine — it degrades gracefully.
 * @returns {{def: object, usedFallback: boolean}}
 */
export function resolveTemplate(channel, event) {
  const lib = byChannel[channel];
  if (!lib) throw new Error(`No template library for channel: ${channel}`);
  const def = lib[event];
  if (def) return { def, usedFallback: false };
  return { def: lib.generic, usedFallback: true };
}

export default resolveTemplate;
