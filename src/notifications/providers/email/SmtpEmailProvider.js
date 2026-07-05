import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";

/**
 * Real SMTP provider via nodemailer (Brevo-compatible; works with any relay).
 * DORMANT unless NOTIF_EMAIL_PROVIDER=smtp. nodemailer is lazy-imported so it is
 * never a hard dependency of the zero-infra path. Same contract as the mock —
 * the engine doesn't change.
 *
 * Contract: async send({ to, subject, body, meta }) => { providerMessageId, status, raw }
 * On unrecoverable failure it MUST throw — the Dispatcher owns retries/dead-letter.
 * Credentials (user/pass/auth) are NEVER logged or embedded in errors.
 */

// Connection-level failures where the pooled transport is likely dead and must
// be torn down so the next send rebuilds it. code 421 = service not available.
const BROKEN_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNECTION",
  "ESOCKET",
  "421",
]);

/**
 * Derive a plain-text fallback from rendered HTML. Dependency-free: drop
 * script/style blocks, turn a few block tags into line breaks, strip the rest
 * of the tags, decode a handful of common entities, and collapse whitespace.
 */
function htmlToText(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr|table|section|header|footer)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Best-effort error code extraction (nodemailer sets .code, sometimes numeric responseCode). */
function errCode(err) {
  if (!err) return "UNKNOWN";
  if (err.code) return String(err.code);
  if (err.responseCode) return String(err.responseCode);
  return "UNKNOWN";
}

export class SmtpEmailProvider extends Provider {
  constructor() {
    super();
    this._transport = null;
  }

  get name() {
    return "smtp";
  }

  /** Close and drop the cached transport so the next send rebuilds it. */
  _resetTransport() {
    const tx = this._transport;
    this._transport = null;
    if (tx && typeof tx.close === "function") {
      try {
        tx.close();
      } catch {
        // closing a dead pool can throw — nothing actionable, swallow.
      }
    }
  }

  async _tx() {
    if (this._transport) return this._transport;

    let nodemailer;
    try {
      nodemailer = (await import("nodemailer")).default;
    } catch {
      throw new Error(
        "NOTIF_EMAIL_PROVIDER=smtp but 'nodemailer' is not installed. Run: npm i nodemailer"
      );
    }

    const s = config.smtp;
    if (!s.host) throw new Error("SMTP_HOST is required for the smtp email provider");

    const options = {
      host: s.host,
      port: s.port,
      secure: s.secure, // true => implicit TLS (465); false => STARTTLS upgrade
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      // TLS posture: require STARTTLS on non-secure ports and always verify the
      // cert chain by default. NEVER silently disable verification.
      requireTLS: s.requireTLS,
      tls: {
        rejectUnauthorized: s.rejectUnauthorized,
        minVersion: "TLSv1.2",
      },
      // Connection pooling.
      pool: s.pool,
      maxConnections: s.maxConnections,
      maxMessages: s.maxMessages,
      // Timeouts — fail fast instead of hanging a worker slot.
      connectionTimeout: s.connectionTimeoutMs,
      greetingTimeout: s.greetingTimeoutMs,
      socketTimeout: s.socketTimeoutMs,
    };

    // Outbound rate limiting (opt-in): messages per rateDelta window.
    if (s.rateLimit > 0) {
      options.rateLimit = s.rateLimit;
      options.rateDelta = s.rateDeltaMs;
    }

    this._transport = nodemailer.createTransport(options);
    // Single non-secret info log — host+port only, never user/pass.
    console.log(`[smtp] transport ready host=${s.host} port=${s.port} secure=${s.secure}`);
    return this._transport;
  }

  async send({ to, subject, body, meta = {} }) {
    const tx = await this._tx();

    let info;
    try {
      info = await tx.sendMail({
        from: config.smtp.from,
        to,
        subject,
        html: body,
        text: htmlToText(body),
        attachments: meta.attachments || [],
      });
    } catch (err) {
      const code = errCode(err);
      // If the pooled connection looks broken, tear it down so the next send
      // (a Dispatcher retry) rebuilds a fresh transport. We do NOT retry here.
      if (BROKEN_CONNECTION_CODES.has(code)) {
        this._resetTransport();
      }
      const wrapped = new Error(`SMTP send failed [${code}]: ${err && err.message}`);
      if (err && err.code) wrapped.code = err.code;
      throw wrapped;
    }

    const accepted = info.accepted?.length || 0;
    const rejected = info.rejected?.length || 0;

    // All recipients rejected and none accepted => unrecoverable, throw.
    if (rejected > 0 && accepted === 0) {
      const code = errCode(info) === "UNKNOWN" ? "REJECTED" : errCode(info);
      throw new Error(`SMTP send failed [${code}]: all recipients rejected`);
    }

    // Treat a queued/accepted SMTP 250-response as "queued", else "sent".
    const response = String(info.response || "").toLowerCase();
    const status =
      /queued|accepted for delivery|will attempt/.test(response) ? "queued" : "sent";

    return { providerMessageId: info.messageId, status, raw: info };
  }
}

export default SmtpEmailProvider;
