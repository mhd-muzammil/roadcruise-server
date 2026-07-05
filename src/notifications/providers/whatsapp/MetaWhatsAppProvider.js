import { Provider } from "../Provider.js";
import config from "../../config/notification.config.js";

/**
 * Real WhatsApp via Meta Cloud API. DORMANT unless NOTIF_WHATSAPP_PROVIDER=meta.
 * Uses global fetch (Node 18+), so no SDK dependency.
 *
 * Supports plain text, link-based image and document (PDF) media, and template
 * messages. Media must be reachable via a public URL — this engine does not
 * upload binary content to Meta, so buffer/local-only attachments fall back to
 * a plain text send.
 *
 * NOTE: the access token / Authorization header is NEVER logged or included in
 * any thrown error message.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Backoff delays (ms) for the small in-provider transient retry. First send +
// these two extra attempts = up to 3 total tries. Deterministic (no jitter).
const RETRY_BACKOFFS_MS = [300, 900];

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp)(\?.*)?$/i;
const PDF_EXT_RE = /\.pdf(\?.*)?$/i;

/** A network/fetch error, HTTP 429, or HTTP >= 500 may be retried. */
function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

export class MetaWhatsAppProvider extends Provider {
  get name() {
    return "meta-whatsapp";
  }

  async send({ to, subject, body, meta = {} }) {
    const { phoneNumberId, accessToken, apiVersion, timeoutMs } =
      config.metaWhatsApp;

    if (!phoneNumberId || !accessToken) {
      throw new Error(
        "WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN required for meta provider"
      );
    }

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const digits = String(to || "").replace(/\D/g, "");

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits,
      ...this._buildTypedPayload({ body, meta }),
    };

    const requestBody = JSON.stringify(payload);
    const maxAttempts = 1 + RETRY_BACKOFFS_MS.length;
    let lastError;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // Backoff before a retry attempt (index shifted by the initial try).
        await sleep(RETRY_BACKOFFS_MS[attempt - 1]);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res, raw;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
          signal: controller.signal,
        });
        // Keep the timeout armed through body consumption too — a server that
        // sends headers then stalls the body must not hang the worker slot.
        // Re-throw an abort so it surfaces as a timeout; tolerate only a
        // genuinely malformed/empty JSON body as {}.
        raw = await res.json().catch((e) => {
          if ((e && e.name === "AbortError") || controller.signal.aborted) throw e;
          return {};
        });
      } catch (err) {
        // Distinguish an abort (timeout) from other network errors. Both are
        // transient and eligible for retry, but the timeout gets a clear label.
        const isAbort = (err && err.name === "AbortError") || controller.signal.aborted;
        lastError = isAbort
          ? new Error(
              `Meta WhatsApp request timed out after ${timeoutMs}ms`
            )
          : new Error(
              `Meta WhatsApp network error: ${err && err.message ? err.message : String(err)}`
            );
        continue; // network/timeout errors are transient → retry if attempts remain
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        return {
          providerMessageId: raw.messages?.[0]?.id || null,
          status: "sent",
          raw,
        };
      }

      const error = (raw && raw.error) || {};
      const mappedError = new Error(
        `Meta WhatsApp send failed (${res.status}) [${error.code}/${error.type}]: ${error.message}`
      );

      if (isTransientStatus(res.status)) {
        lastError = mappedError;
        continue; // 429 / 5xx → retry if attempts remain
      }

      // Non-transient (e.g. other 4xx) → fail immediately.
      throw mappedError;
    }

    // Exhausted all attempts on transient failures.
    throw lastError;
  }

  /**
   * Decide the message type and build its type-specific fields, following the
   * required priority: template > media (document/image) > text.
   */
  _buildTypedPayload({ body, meta }) {
    // 1) Template messages take top priority.
    if (meta.template) {
      const { name, languageCode, components } = meta.template;
      return {
        type: "template",
        template: {
          name,
          language: { code: languageCode || "en" },
          components: components || [],
        },
      };
    }

    // 2) Media (attachment or mediaUrl).
    const attachment = meta.attachments?.[0];
    const link = attachment?.url || attachment?.path || meta.mediaUrl;

    if (attachment || meta.mediaUrl) {
      // Only public link-based media is supported. If there is no URL to link
      // (buffer/local content only), fall back to a plain text send.
      if (link) {
        const contentType = String(attachment?.contentType || "").toLowerCase();
        const filename = attachment?.filename || "";

        const isPdf =
          contentType.includes("pdf") ||
          PDF_EXT_RE.test(filename) ||
          PDF_EXT_RE.test(link);

        if (isPdf) {
          const document = { link, caption: body };
          if (filename) document.filename = filename;
          return { type: "document", document };
        }

        const isImage =
          contentType.startsWith("image") ||
          IMAGE_EXT_RE.test(filename) ||
          IMAGE_EXT_RE.test(link);

        if (isImage) {
          return { type: "image", image: { link, caption: body } };
        }

        // Unknown media kind with a link — treat as a generic document so the
        // recipient still receives the file plus the message as a caption.
        const document = { link, caption: body };
        if (filename) document.filename = filename;
        return { type: "document", document };
      }
      // else: no public URL → fall through to text.
    }

    // 3) Plain text.
    return { type: "text", text: { preview_url: true, body } };
  }
}

export default MetaWhatsAppProvider;
