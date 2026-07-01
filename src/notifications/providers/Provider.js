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
 *   meta?: { buttons, mediaUrl, attachments }  // rich-channel extras
 * }
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
