import { randomUUID } from "crypto";
import { PaymentGateway } from "./Gateway.js";
import { config } from "../config/payment.config.js";
import { phonepeXVerify, verifyPhonePeXVerify } from "../core/signature.js";

/**
 * Real PhonePe adapter (salt-based PG API). DORMANT unless PAYMENT_PROVIDER=phonepe.
 *
 * PhonePe differs from the Razorpay-shaped browser-signature model: the customer
 * is redirected to PhonePe's hosted "PAY_PAGE", pays there, and PhonePe both
 * (a) redirects the browser back to PHONEPE_REDIRECT_URL and (b) POSTs a signed
 * server-to-server callback to PHONEPE_CALLBACK_URL. Neither carries a trusted
 * amount, so the AUTHORITATIVE capture is always the Status API result
 * (state === "COMPLETED"). PaymentService.confirmByStatus() drives that check
 * from both the callback and the redirect-return.
 *
 * Signing: every request/callback uses
 *   X-VERIFY = SHA256(<stringToSign> + saltKey) + "###" + saltIndex
 * (no SDK, no OAuth token). Built-in global fetch only (Node 18+).
 *
 * SECURITY: the salt key is never logged or embedded in a thrown error message.
 *
 * API-version note: this implements PhonePe's salt-key PG API (merchantId +
 * saltKey + saltIndex, /pg/v1/*). If the merchant account is provisioned for the
 * newer OAuth "Standard Checkout" API, only the `_request` auth layer + endpoint
 * paths change — the PaymentService/controller wiring stays the same.
 */

// PhonePe merchantTransactionId: <=35 chars, [a-zA-Z0-9_-] only.
function toMerchantTxnId(receipt) {
  const base = String(receipt || `TXN${randomUUID().replace(/-/g, "")}`).replace(/[^a-zA-Z0-9_-]/g, "");
  return base.slice(0, 35) || `TXN${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

const PAY_PATH = "/pg/v1/pay";
const REFUND_PATH = "/pg/v1/refund";
const statusPath = (mid, mtid) => `/pg/v1/status/${mid}/${mtid}`;

/** Build a classified error mirroring the notification providers' contract. */
function gatewayError(message, { statusCode = null, retryable = false } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.retryable = retryable;
  return err;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class PhonePeGateway extends PaymentGateway {
  get name() {
    return "phonepe";
  }

  _cfg() {
    const c = config.phonepe;
    if (!c.merchantId || !c.saltKey) {
      throw gatewayError("PHONEPE_MERCHANT_ID and PHONEPE_SALT_KEY are required for the phonepe gateway");
    }
    return c;
  }

  /**
   * Signed HTTP call to PhonePe. `stringToSign` is the X-VERIFY pre-image
   * (base64Payload + apiPath for POST, apiPath for GET). Returns parsed JSON.
   */
  async _request({ method, apiPath, base64Payload = null, stringToSign, extraHeaders = {} }) {
    const { saltKey, saltIndex, baseUrl, timeoutMs } = this._cfg();
    const headers = {
      "Content-Type": "application/json",
      accept: "application/json",
      "X-VERIFY": phonepeXVerify(stringToSign, saltKey, saltIndex),
      ...extraHeaders,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res, data;
    try {
      res = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers,
        body: base64Payload ? JSON.stringify({ request: base64Payload }) : undefined,
        signal: controller.signal,
      });
      data = await res.json().catch((e) => {
        if (e?.name === "AbortError" || controller.signal.aborted) throw e;
        return {};
      });
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) {
        throw gatewayError(`PhonePe ${apiPath} timed out after ${timeoutMs}ms`, { retryable: true });
      }
      throw gatewayError(`PhonePe ${apiPath} failed (network error): ${err?.message || err}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok && data?.success === undefined) {
      // Never echo saltKey/headers — only the PhonePe-provided code/message.
      throw gatewayError(`PhonePe ${apiPath} failed (${res.status}) [${data?.code ?? ""}]: ${data?.message ?? ""}`, {
        statusCode: res.status,
        retryable: RETRYABLE_STATUS.has(res.status),
      });
    }
    return data;
  }

  /** Create a PhonePe PAY_PAGE order. Returns the hosted redirect URL in `raw`. */
  async createOrder({ amount, currency, receipt, notes }) {
    const c = this._cfg();
    const merchantTransactionId = toMerchantTxnId(receipt);
    const payload = {
      merchantId: c.merchantId,
      merchantTransactionId,
      merchantUserId: String(notes?.customerId || notes?.bookingId || "guest").slice(0, 36),
      amount, // already in paise (smallest unit)
      redirectUrl: (c.redirectUrl || "").replace("{orderId}", merchantTransactionId),
      redirectMode: "REDIRECT",
      callbackUrl: c.callbackUrl || undefined,
      paymentInstrument: { type: "PAY_PAGE" },
    };
    const base64Payload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const data = await this._request({
      method: "POST",
      apiPath: PAY_PATH,
      base64Payload,
      stringToSign: `${base64Payload}${PAY_PATH}`,
    });
    if (!data?.success) {
      throw gatewayError(`PhonePe pay init rejected [${data?.code ?? ""}]: ${data?.message ?? ""}`);
    }
    const redirectUrl = data?.data?.instrumentResponse?.redirectInfo?.url || null;
    return {
      orderId: merchantTransactionId,
      amount,
      currency,
      status: "created",
      raw: { redirectUrl, merchantTransactionId, code: data.code, response: data },
    };
  }

  /**
   * NOT used for PhonePe: there is no browser-returned HMAC of (orderId|paymentId).
   * The trust anchor is the Status API (see PaymentService.confirmByStatus). Throw
   * loudly so a Razorpay-shaped /verify call against PhonePe never silently fails.
   */
  verifyPayment() {
    throw gatewayError(
      "PhonePe does not use browser-signature verification — confirm via the Status API (payments confirmByStatus / phonepe callback)"
    );
  }

  /** PAY_PAGE auto-captures; no separate capture step. Kept for interface parity. */
  async capturePayment({ paymentId }) {
    return { status: "captured", raw: { id: paymentId, phonepe: true, autoCapture: true } };
  }

  /** Status API — the authoritative source of truth for a transaction. */
  async fetchPayment(merchantTransactionId) {
    const c = this._cfg();
    const apiPath = statusPath(c.merchantId, merchantTransactionId);
    return this._request({
      method: "GET",
      apiPath,
      stringToSign: apiPath,
      extraHeaders: { "X-MERCHANT-ID": c.merchantId },
    });
  }

  /**
   * Normalize a Status/callback response into a decision the service can act on.
   * PhonePe: success + data.state === "COMPLETED" => paid; "FAILED" => failed;
   * "PENDING" => pending.
   */
  parseStatus(data) {
    const state = data?.data?.state || data?.code || null;
    const paid = data?.success === true && (state === "COMPLETED" || data?.code === "PAYMENT_SUCCESS");
    const failed = state === "FAILED" || data?.code === "PAYMENT_ERROR" || data?.success === false;
    return {
      paid,
      failed: failed && !paid,
      pending: !paid && !failed,
      state,
      code: data?.code || null,
      merchantTransactionId: data?.data?.merchantTransactionId || null,
      providerReferenceId: data?.data?.transactionId || data?.data?.providerReferenceId || null,
      amount: data?.data?.amount ?? null,
    };
  }

  /**
   * Refund (full/partial). `paymentId` here is the ORIGINAL merchantTransactionId
   * (which PaymentService stores as gatewayPaymentId for PhonePe). Issues a fresh
   * merchantTransactionId for the refund itself, as PhonePe requires.
   */
  async refund({ paymentId, amount, notes }) {
    const c = this._cfg();
    const refundTxnId = toMerchantTxnId(`RF${randomUUID().replace(/-/g, "").slice(0, 20)}`);
    const payload = {
      merchantId: c.merchantId,
      originalTransactionId: paymentId,
      merchantTransactionId: refundTxnId,
      amount, // paise
      callbackUrl: c.callbackUrl || undefined,
      ...(notes ? { message: String(notes).slice(0, 80) } : {}),
    };
    const base64Payload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const data = await this._request({
      method: "POST",
      apiPath: REFUND_PATH,
      base64Payload,
      stringToSign: `${base64Payload}${REFUND_PATH}`,
    });
    const st = this.parseStatus(data);
    return {
      refundId: refundTxnId,
      // "processed" tells PaymentService the refund settled synchronously; PENDING
      // refunds complete later via the callback -> confirmByStatus path.
      status: st.paid ? "processed" : st.pending ? "pending" : "failed",
      amount,
      raw: data,
    };
  }

  /**
   * Verify a PhonePe S2S callback. PhonePe signs the base64 `response` body only:
   *   X-VERIFY = SHA256(base64Response + saltKey) + "###" + saltIndex
   * The caller passes the RAW request body (JSON: { response: base64 }) + the
   * X-VERIFY header value.
   * @returns {boolean}
   */
  verifyWebhook(rawBody, signature) {
    const c = config.phonepe;
    if (!c.saltKey || !signature) return false;
    let responseB64;
    try {
      const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
      responseB64 = body?.response;
    } catch {
      return false;
    }
    if (!responseB64) return false;
    return verifyPhonePeXVerify(responseB64, signature, c.saltKey, c.saltIndex);
  }

  /** Decode a verified callback body into the PhonePe result JSON. */
  decodeCallback(rawBody) {
    const body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    const json = JSON.parse(Buffer.from(body.response, "base64").toString("utf8"));
    return json;
  }
}

export default PhonePeGateway;
