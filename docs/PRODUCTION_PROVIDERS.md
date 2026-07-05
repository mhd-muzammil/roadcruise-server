# Production Providers — Setup, Deployment & Rollback

The notification engine ships **zero-infra by default**: mock providers (console-log), a JSON file store, and an in-process worker. It requires no credentials to boot and run end-to-end.

Three real providers are now **production-ready** and selected **purely via environment variables** — no code changes, no redeploys of business modules. Mock remains the zero-infra default; you opt into a real provider one channel at a time.

| Channel | Real provider | Provider name | Activation env |
|---|---|---|---|
| Email | Brevo / SMTP (nodemailer) | `smtp` | `NOTIF_EMAIL_PROVIDER=smtp` |
| SMS | MSG91 (India DLT, v5 Flow API) | `msg91-sms` | `NOTIF_SMS_PROVIDER=msg91` |
| SMS (alt) | Twilio | `twilio-sms` | `NOTIF_SMS_PROVIDER=twilio` |
| WhatsApp | Meta Cloud API | `meta-whatsapp` | `NOTIF_WHATSAPP_PROVIDER=meta` |

> Switching a channel back to `mock` is always a single env-var change. The engine, templates, queue, and retry semantics are identical across providers.

---

## Provider Setup

### Brevo SMTP (Email)

**What to obtain**

1. A [Brevo](https://www.brevo.com/) account.
2. An SMTP key from **SMTP & API → SMTP** (this is your `SMTP_PASS`; the login email is `SMTP_USER`).
3. A **verified sender domain** (SPF/DKIM configured in Brevo) so mail is accepted and not spam-filtered. The `SMTP_FROM` address must belong to that verified domain.

**Capabilities:** verified TLS (`minVersion TLSv1.2`), connection pooling, per-window rate limiting, connection/greeting/socket timeouts, graceful reconnect on broken pooled connections, HTML with automatic plain-text fallback, and attachments (nodemailer format). Delivery status maps `accepted → sent`; if all recipients are rejected the send throws (routed to retry/dead-letter).

**Env block**

```bash
NOTIF_EMAIL_PROVIDER=smtp
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false                  # true = implicit TLS on port 465
SMTP_USER=your-brevo-login@example.com
SMTP_PASS=your-brevo-smtp-key
SMTP_FROM="Road Cruise <no-reply@your-verified-domain.com>"

# Optional tunables (defaults shown)
SMTP_POOL=true
SMTP_MAX_CONNECTIONS=5
SMTP_MAX_MESSAGES=100
SMTP_RATE_LIMIT=0                  # 0 = unlimited
SMTP_RATE_DELTA_MS=1000
SMTP_CONNECTION_TIMEOUT_MS=10000
SMTP_GREETING_TIMEOUT_MS=10000
SMTP_SOCKET_TIMEOUT_MS=20000
SMTP_REQUIRE_TLS=true
SMTP_TLS_REJECT_UNAUTHORIZED=true  # keep true in production
```

`nodemailer` is already installed — no additional dependency needed.

---

### MSG91 SMS (India, DLT-compliant)

**What to obtain**

1. An [MSG91](https://msg91.com/) account with an **API key** (`MSG91_API_KEY`).
2. A **DLT-approved sender ID** — the 6-character header registered on your DLT operator (`MSG91_SENDER_ID`).
3. A **DLT flow template** approved on the DLT portal and configured in MSG91 (`MSG91_TEMPLATE_ID`). The template must contain a body variable that the rendered message text is injected into (`MSG91_BODY_VAR`, default `body`).

**Capabilities:** sends OTP/transactional/booking/payment SMS uniformly — the engine renders the message body and the provider injects it into the DLT template's body variable. Uses the **v5 Flow API over built-in `fetch`** (no SDK). `AbortController` timeout with one transient-only retry.

**Env block**

```bash
NOTIF_SMS_PROVIDER=msg91
MSG91_API_KEY=your-msg91-authkey
MSG91_SENDER_ID=RCRUSE            # 6-char DLT header
MSG91_TEMPLATE_ID=your-dlt-flow-template-id

# Optional (defaults shown)
MSG91_BODY_VAR=body
MSG91_DEFAULT_COUNTRY_CODE=91
MSG91_BASE_URL=https://control.msg91.com
MSG91_TIMEOUT_MS=15000
```

No SDK required — MSG91 uses built-in `fetch` (Node 18+).

---

### Meta WhatsApp (Cloud API)

**What to obtain**

1. A **Meta / WhatsApp Business** account and a WhatsApp Business App in the Meta developer console.
2. The **Phone Number ID** for your registered WhatsApp sender number (`WHATSAPP_PHONE_NUMBER_ID`).
3. A **permanent access token** — generate a **System User token** (not a temporary/dev token) so it does not expire (`WHATSAPP_ACCESS_TOKEN`).
4. Approved **message templates** for any template (HSM) sends.

**Capabilities:** supports text, image and document (PDF) via public link, and template messages. Uses built-in `fetch` (no SDK), an `AbortController` timeout, a small transient retry (429/5xx/network) with deterministic backoff, and error mapping that never leaks the token.

**Env block**

```bash
NOTIF_WHATSAPP_PROVIDER=meta
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_ACCESS_TOKEN=your-permanent-system-user-token

# Optional (defaults shown)
WHATSAPP_API_VERSION=v21.0
WHATSAPP_TIMEOUT_MS=15000
```

> **Back-compat:** the legacy env names `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_ACCESS_TOKEN`, and `META_WHATSAPP_API_VERSION` are still honored as fallbacks. Prefer the `WHATSAPP_*` names for new deployments.

No SDK required — Meta uses built-in `fetch` (Node 18+).

---

## Deployment Guide

Go live **one channel at a time**. Each step is independently reversible and touches only environment variables.

1. **Set production mode.** `NODE_ENV=production`. This makes the admin API fail closed unless a token is configured.
2. **Set the admin token.** `NOTIF_ADMIN_TOKEN=<a strong secret>` — **required** in production; without it the admin API returns `503`.
3. **Confirm the master + channel flags.** `NOTIF_ENABLED=true` and the relevant `NOTIF_EMAIL_ENABLED` / `NOTIF_SMS_ENABLED` / `NOTIF_WHATSAPP_ENABLED`.
4. **Flip the first channel to its real provider.** Set the channel's `NOTIF_*_PROVIDER` and the matching credentials block from *Provider Setup* above (start with one channel, e.g. email → `smtp`).
5. **Verify.** Confirm delivery and watch counters:

   ```bash
   curl -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
     https://your-host/api/notifications/metrics
   ```

   Check `counters.sent`, `rates.deliveryPct`, and that `deadLettered` stays at `0`.
6. **Repeat for the next channel** (`msg91` / `twilio` for SMS, then `meta` for WhatsApp), verifying via `/metrics` after each flip.
7. **Set the DLQ alert recipient.** `NOTIF_DLQ_ALERT_EMAIL=<ops inbox>` so dead-letters raise an email alert.

---

## Production Checklist

- [ ] Secrets are stored in a **secret manager** (e.g. AWS/GCP Secrets Manager, Vault) — **not** a `.env` file committed to version control.
- [ ] `NOTIF_ADMIN_TOKEN` is set to a strong, unique value.
- [ ] `NODE_ENV=production` (admin API fails closed without a token).
- [ ] TLS verification is on: `SMTP_REQUIRE_TLS=true` and `SMTP_TLS_REJECT_UNAUTHORIZED=true`.
- [ ] DLQ alerting is enabled and `NOTIF_DLQ_ALERT_EMAIL` points to a monitored ops inbox.
- [ ] Rate limits are tuned for your Brevo plan (`SMTP_RATE_LIMIT` / `SMTP_RATE_DELTA_MS`, pool sizing).
- [ ] MSG91 **DLT template is approved** and the sender ID is registered; `MSG91_TEMPLATE_ID` / `MSG91_SENDER_ID` match the approved DLT entities.
- [ ] Meta access token is a **permanent / System User token** (not a temporary dev token).
- [ ] For horizontal scale-out: **Redis** is configured (`REDIS_URL`, BullMQ) and **Postgres** is planned/wired (`DATABASE_URL`) so state is not tied to a single instance's JSON store.
- [ ] Monitoring scrapes `GET /api/notifications/metrics` (delivery rate, failures, queue size, dead-letter count).

---

## Rollback Procedure

No code changes or redeploys of business modules are required to roll back — every lever is an environment variable.

- **Disable the whole engine.** Set `NOTIF_ENABLED=false`. The engine stops subscribing to events and starting the worker; existing `notify(...)` emit calls become harmless no-ops and the app behaves exactly as before.
- **Revert a single channel to mock.** Change that channel's provider var back to `mock` — `NOTIF_EMAIL_PROVIDER=mock`, `NOTIF_SMS_PROVIDER=mock`, or `NOTIF_WHATSAPP_PROVIDER=mock`. The other channels are unaffected.
- **Turn off a single channel.** Set `NOTIF_EMAIL_ENABLED=false` / `NOTIF_SMS_ENABLED=false` / `NOTIF_WHATSAPP_ENABLED=false` to stop that channel entirely while leaving the rest live.

After changing any of the above, restart/reload the service so it re-reads the environment. No business-module code is touched.
