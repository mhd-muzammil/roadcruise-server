import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";

/**
 * Real SMTP provider via nodemailer. DORMANT unless NOTIF_EMAIL_PROVIDER=smtp.
 * nodemailer is lazy-imported so it is never a hard dependency of the zero-infra
 * path. Same contract as the mock — the engine doesn't change.
 */
export class SmtpEmailProvider extends Provider {
  constructor() {
    super();
    this._transport = null;
  }
  get name() {
    return "smtp";
  }
  async _tx() {
    if (this._transport) return this._transport;
    let nodemailer;
    try {
      nodemailer = (await import("nodemailer")).default;
    } catch {
      throw new Error("NOTIF_EMAIL_PROVIDER=smtp but 'nodemailer' is not installed. Run: npm i nodemailer");
    }
    const { host, port, secure, user, pass } = config.smtp;
    if (!host) throw new Error("SMTP_HOST is required for the smtp email provider");
    this._transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
    });
    return this._transport;
  }
  async send({ to, subject, body, meta = {} }) {
    const tx = await this._tx();
    const info = await tx.sendMail({
      from: config.smtp.from,
      to,
      subject,
      html: body,
      attachments: meta.attachments || [],
    });
    return { providerMessageId: info.messageId, status: "sent", raw: info };
  }
}

export default SmtpEmailProvider;
