/**
 * Provider contract. Every channel adapter implements:
 *
 *   get name(): string
 *   async send(message): Promise<{ providerMessageId, raw, status }>
 *
 * `message` = {
 *   to,                       // resolved recipient (email / phone / wa id)
 *   subject?,                 // email only
 *   body,                     // rendered text/html
 *   event?,                   // domain event — India/DLT SMS selects a template by it
 *   vars?,                    // ordered DLT variable values (Airtel IQ)
 *   context?,                 // rendered template context — variables BY NAME (MSG91)
 *   correlationId?,           // for log correlation
 *   meta?: { buttons, mediaUrl, attachments }  // rich-channel extras
 * }
 *
 * Adapters take only what they need; the rest is ignored. `event`/`vars`/
 * `context` exist because Indian DLT gateways do not accept free-form text —
 * they render pre-approved templates from variables (see §7.1/§7.2 of README).
 *
 * On unrecoverable failure it MUST throw — the Dispatcher converts throws into
 * retries/dead-letter. Returning normally means "accepted by provider".
 */
export class Provider {
  get name() {
    return "base";
  }
  // eslint-disable-next-line no-unused-vars
  async send(message) {
    throw new Error("Provider.send not implemented");
  }
}

export default Provider;
