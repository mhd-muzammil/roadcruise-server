# Enterprise Notification & Communication Module

A reusable, event-driven, queue-based, provider-agnostic communication engine for the Road Cruise ERP. It delivers transactional messages over **Email**, **SMS**, and **WhatsApp** in response to domain events emitted anywhere in the ERP (booking, payment, trip, auth, ...).

It is **additive and non-breaking**: the only touch points in existing code are one-line, fire-and-forget `notify(...)` / hook calls and a single `notifications.init(app)` in the bootstrap. It boots and runs end-to-end with **zero external infrastructure** — mock providers, a JSON file store, and an in-process worker — and is upgraded to real providers / Redis / Postgres purely via environment variables.

---

## 1. Overview & Design Principles

| Principle | How it is realized |
|---|---|
| **Event-driven** | Business modules emit a domain event (`notify(NotificationEvents.X, payload)`) onto a singleton `EventBus`. They never call a provider, template, or queue. |
| **Queue-based** | Events are turned into per-channel records and enqueued; a background worker does the actual send + retry. The HTTP request path is never blocked. |
| **Provider-agnostic** | Each channel resolves an adapter (mock / SMTP / Twilio / Meta) from config. Swapping a vendor is one registry line; business code is unchanged. |
| **Zero-infra default** | With no env config: mock providers (console-log), JSON file persistence, and an in-process polling queue. No Redis, no DB, no credentials required. |
| **Non-breaking** | Emitting is fully isolated — a listener throwing can never bubble back to the caller. Booking/auth creation never fails because a notification failed. Deferred via `setImmediate`, so the HTTP response returns before any notification work begins. |
| **Secrets via env only** | No keys are hardcoded. Real adapters read credentials lazily and never log them. |
| **Idempotent** | A deterministic idempotency key prevents the same message being sent twice. |
| **Extensible without engine changes** | New event = constant + workflow + templates. New provider = adapter class + one registry line. New persistence/queue = same interface, different factory return. |

---

## 2. Architecture

```
  Business module (booking / auth / payment / trip ...)
        │
        │  notify(event, payload)        ← integration/hooks.js or facade
        ▼
  ┌───────────────┐   emitEvent (setImmediate, isolated, fire-and-forget)
  │   EventBus     │ ──────────────────────────────────────────────┐
  └───────────────┘                                                 │
        │ on(event)                                                 │ on("*")
        ▼                                                           ▼
  ┌──────────────────────┐                                  (metrics/observers)
  │ NotificationService   │  resolve workflow → recipients + context
  │  (engine front door)  │  per enabled channel w/ a recipient:
  └──────────────────────┘   • idempotency dedupe (skip if dupe)
        │  create QUEUED record + audit "enqueued"
        ▼
  ┌───────────────┐  enqueue(id)
  │     Queue      │  in-process poll (default)  |  BullMQ/Redis (REDIS_URL)
  └───────────────┘
        │  processor(id)
        ▼
  ┌───────────────┐  resolveTemplate(channel,event) → render() → getProvider(channel).send()
  │   Dispatcher   │
  └───────────────┘
        │ success                         │ failure
        ▼                                 ▼
  status=SENT                       attempts < maxAttempts ?
  + Repository.update               ├── yes → status=FAILED, nextAttemptAt = now + backoff  ──┐
  + Audit "sent"                    │         (exponential backoff w/ jitter)  retry ─────────┘
  + metrics.recordSend              └── no  → status=DEAD_LETTER
                                              + Repository.pushDeadLetter (DLQ)
                                              + Audit "dead_letter"
                                              + _alertAdmin (email ops alert)

  All stages append to the immutable Audit Log; all sends update Metrics.
```

---

## 3. Folder Structure

```
src/notifications/
├── index.js                      Public facade: init(app), notify(event,payload), buildEngine()
├── config/
│   ├── events.js                 NotificationEvents, Channels, DeliveryStatus constants
│   └── notification.config.js    Env-driven config + channelEnabled() helper
├── core/
│   ├── EventBus.js               Singleton domain EventBus (isolated, deferred emit)
│   ├── NotificationService.js    Engine front door: event → per-channel QUEUED records
│   ├── Dispatcher.js             render → send → retry/backoff/dead-letter state machine
│   ├── idempotency.js            Deterministic idempotency key (sha256 digest)
│   └── runtime.js                Holds initialized singletons for the admin API
├── queue/
│   ├── Queue.js                  Queue contract (start / enqueue / stop)
│   ├── InProcessQueue.js         Zero-infra polling worker (default)
│   ├── BullMQQueue.js            BullMQ/Redis adapter (dormant; needs REDIS_URL + bullmq)
│   └── index.js                  Queue factory (REDIS_URL ? BullMQ : in-process)
├── providers/
│   ├── Provider.js               Provider contract (name, send(message))
│   ├── index.js                  Provider registry + getProvider(channel) (cached)
│   ├── email/MockEmailProvider.js / SmtpEmailProvider.js
│   ├── sms/MockSmsProvider.js / TwilioSmsProvider.js
│   └── whatsapp/MockWhatsAppProvider.js / MetaWhatsAppProvider.js
├── templates/
│   ├── engine.js                 {{placeholder}} fill + per-channel escaping (render())
│   ├── registry.js               resolveTemplate(channel,event) w/ generic fallback
│   ├── email/layout.js           Branded responsive email layout + detailTable/detailRow
│   ├── email/index.js            Email template library (eventKey → {subject, html})
│   ├── sms/index.js              SMS template library (eventKey → {text})
│   └── whatsapp/index.js         WhatsApp library (eventKey → {text, buttons?, mediaUrl?})
├── workflows/
│   └── registry.js               Event → workflow (channels, resolveRecipients, buildContext)
├── repository/
│   ├── NotificationRepository.js JSON repo: notifications + DLQ (the record shape)
│   ├── store.js                  Atomic, serialized JSON store (zero-infra persistence)
│   └── index.js                  Repository factory (DATABASE_URL extension point)
├── audit/
│   └── AuditLog.js               Immutable append-only audit trail (audit.json)
├── observability/
│   └── metrics.js                In-memory counters + snapshot() for /metrics
├── api/
│   ├── notification.routes.js    Admin router mounted at /api/notifications
│   ├── notification.controller.js Admin endpoints (list, metrics, dlq, audit, retry, resend...)
│   └── adminGuard.js             x-admin-token guard (dev-open / prod-mandatory)
├── integration/
│   └── hooks.js                  One-line helpers existing controllers import
└── __tests__/                    node --test suites (engine, idempotency, templates)
```

> Runtime data files (`notifications.json`, `audit.json`) are written to `src/notifications/data/` by the JSON store.

---

## 4. Event Catalog

All events are stable string constants in `config/events.js`. The channels each event fans out to come from `workflows/registry.js` (any event not explicitly listed uses `__default` = all three channels). Channels also subject to the per-channel feature flags (`channelEnabled`).

| Constant | Event string | Email | SMS | WhatsApp |
|---|---|:--:|:--:|:--:|
| `BOOKING_CREATED` | `booking.created` | ✅ | ✅ | ✅ |
| `BOOKING_CONFIRMED` | `booking.confirmed` | ✅ | ✅ | ✅ |
| `BOOKING_CANCELLED` | `booking.cancelled` | ✅ | ✅ | ✅ |
| `BOOKING_RESCHEDULED` | `booking.rescheduled` | ✅ | ✅ | ✅ |
| `PAYMENT_SUCCESSFUL` | `payment.successful` | ✅ | ✅ | ✅ |
| `PAYMENT_FAILED` | `payment.failed` | ✅ | ✅ | ✅ |
| `PAYMENT_PENDING` | `payment.pending` | ✅ | ✅ | — |
| `REFUND_INITIATED` | `refund.initiated` | ✅ | ✅ | ✅ |
| `REFUND_COMPLETED` | `refund.completed` | ✅ | ✅ | ✅ |
| `TRIP_SCHEDULED` | `trip.scheduled` | ✅ | ✅ | ✅ |
| `TRIP_REMINDER` | `trip.reminder` | — | ✅ | ✅ |
| `TRIP_STARTED` | `trip.started` | — | ✅ | ✅ |
| `TRIP_COMPLETED` | `trip.completed` | ✅ | ✅ | ✅ |
| `DRIVER_ASSIGNED` | `driver.assigned` | ✅ | ✅ | ✅ |
| `DRIVER_CHANGED` | `driver.changed` | ✅ | ✅ | ✅ |
| `INVOICE_GENERATED` | `invoice.generated` | ✅ | — | — |
| `CUSTOMER_REGISTERED` | `customer.registered` | ✅ | — | ✅ |
| `OTP_REQUESTED` | `auth.otp_requested` | ✅ | ✅ | — |
| `PASSWORD_RESET` | `auth.password_reset` | ✅ | — | — |
| `ADMIN_BOOKING_PAID` | `admin.booking_paid` | ✅ | — | ✅ |
| `ADMIN_BOOKING_UNPAID` | `admin.booking_unpaid` | ✅ | — | ✅ |
| `__default` (fallback) | — | ✅ | ✅ | ✅ |

> **Both points of view on a booking.** A booking notifies the **customer** (`BOOKING_CREATED` → Email + SMS + WhatsApp, customer POV) and the **business/admin** (`ADMIN_BOOKING_UNPAID` for pay-on-arrival, `ADMIN_BOOKING_PAID` after an online payment → Email + WhatsApp, admin POV). The admin events use `adminRecipients` (routes to `ADMIN_EMAIL`/`ADMIN_WHATSAPP`, falling back to `SUPPORT_EMAIL`/`SUPPORT_PHONE`) and carry the customer's details in their context so staff can act. SMS is intentionally off for admin alerts.

> **Note on auth flows:** the `OTP_REQUESTED` and `PASSWORD_RESET` templates reference `{{otp}}` / `{{resetLink}}`, which are **not** part of `defaultContext`. A dedicated `buildContext` for those events must supply `otp` (and `resetLink` for the email reset) when those flows are wired up. This is a registered extension point — the default workflow does not currently emit OTP/reset events.

---

## 5. Emitting Events from any ERP Module

There are two seams. Business code never imports a provider, template, or queue.

### A. The `notify(...)` facade (lowest level)

```js
import { notify, NotificationEvents } from "../notifications/index.js";

// fire-and-forget; returns the event envelope (with generated eventId)
notify(NotificationEvents.PAYMENT_SUCCESSFUL, {
  id: "RC-BK-1234", name: "Asha", email: "asha@x.com", phone: "+9199...",
  fare: 4500, status: "Paid",
});
```

`notify(event, payload, meta)` → `eventBus.emitEvent(...)`. Optional `meta = { actor, correlationId }`.

### B. The `integration/hooks.js` helpers (preferred for existing controllers)

`hooks.js` centralizes payload field-mapping so controllers stay free of notification concerns. Available helpers:

| Helper | Emits | Extra mapping it adds |
|---|---|---|
| `notifyBookingCreated(booking, meta?)` | `BOOKING_CREATED` | — |
| `notifyBookingConfirmed(booking, meta?)` | `BOOKING_CONFIRMED` | `paymentAmount = booking.fare`, `invoiceNumber` |
| `notifyPaymentSuccessful(booking, meta?)` | `PAYMENT_SUCCESSFUL` | `paymentAmount = booking.fare`, `paymentStatus = "Paid"`, `invoiceNumber` |
| `notifyDriverAssigned(booking, meta?)` | `DRIVER_ASSIGNED` | — |
| `notifyBookingCancelled(booking, meta?)` | `BOOKING_CANCELLED` | — |
| `notifyCustomerRegistered(user, meta?)` | `CUSTOMER_REGISTERED` | — |

### The exact non-breaking one-line pattern (from `booking.controller.js`)

After writing the booking to the DB and before responding, controllers add fire-and-forget emit lines — no `await`, no try/catch, no change to the response:

```js
db.bookings.unshift(newBooking);
writeDb(db);

// Emit domain events to the notification engine (async, non-blocking).
notifyBookingCreated(newBooking);
if (newBooking.status === "Approved") {
  notifyPaymentSuccessful(newBooking);
  notifyBookingConfirmed(newBooking);
}

res.status(211).json(newBooking);
```

`auth.controller.js` follows the same pattern with a single `notifyCustomerRegistered(userPayload);` line before responding. Because `emitEvent` defers via `setImmediate` and swallows listener errors, these calls cannot delay or fail the request.

The engine itself is wired up once in `app.js`:

```js
import notifications from "./notifications/index.js";
notifications.init(app);   // mounts /api/notifications + starts the worker
```

---

## 6. Template Engine & Placeholders

`templates/engine.js` is a dependency-free `{{placeholder}}` substitution engine.

- A template definition is `{ subject?, html?, text? }` **or** a function `(ctx) => ({ ... })` for conditional content.
- `{{path.to.value}}` is resolved from the context object (dot-path supported).
- **Channel-aware escaping** (security):
  - **Email** body → HTML-entity escaping (anti-XSS). The **subject** is not HTML-escaped.
  - **SMS / WhatsApp** body → ASCII control-char stripping (anti header/format injection) + whitespace collapse.
- Unknown/`null`/`undefined` placeholders render as empty string (never crash).
- Compiled placeholder lists are cached per template string.

`render(def, channel, ctx)` returns `{ subject?, body }` (email yields both; SMS/WhatsApp yield `body` only).

### Placeholder reference (from `workflows/registry.js` → `defaultContext` + branding)

| Placeholder | Source |
|---|---|
| `{{companyName}}` | branding (`COMPANY_NAME`) |
| `{{supportPhone}}` | branding (`SUPPORT_PHONE`) |
| `{{supportEmail}}` | branding (`SUPPORT_EMAIL`) |
| `{{websiteUrl}}` | branding (`COMPANY_URL`) |
| `{{logoUrl}}` | branding (`COMPANY_LOGO_URL`) |
| `{{customerName}}` | `payload.name` / `payload.customerName` → "Customer" |
| `{{bookingId}}` | `payload.bookingId` / `payload.id` → "—" |
| `{{tripDate}}` | `payload.tripDate` or `fromDate → toDate` / `fromDate` → "—" |
| `{{tripType}}` | `payload.tripType` → "—" |
| `{{pickup}}` | `payload.pickup` / `payload.from` → "—" |
| `{{drop}}` | `payload.drop` / `payload.to` → "—" |
| `{{vehicle}}` | `payload.vehicle` / `payload.item` → "—" |
| `{{driver}}` | `payload.driver` (≠ "None") → "To be assigned" |
| `{{paymentAmount}}` | `payload.paymentAmount` / `payload.fare` → "—" |
| `{{paymentStatus}}` | `payload.paymentStatus` / `payload.status` → "—" |
| `{{invoiceNumber}}` | `payload.invoiceNumber` → "—" |
| `{{otp}}` | **NOT in defaultContext** — auth-flow extension point |
| `{{resetLink}}` | **NOT in defaultContext** — auth-flow extension point |

Branding fields are spread into the context first; the engine relies on the workflow's `buildContext` for the rest.

### How to add a template / event / provider

- **New template for an existing event:** add an entry under the event key in `templates/email/index.js`, `templates/sms/index.js`, and/or `templates/whatsapp/index.js`. Missing channel templates fall back to that channel's `generic` template (no crash).
- **New event:** (1) add a constant to `config/events.js`; (2) add a workflow to `workflows/registry.js` (channels + optional custom `resolveRecipients`/`buildContext`); (3) add templates. No engine/dispatcher/queue code changes.
- **New provider:** see §7.

---

## 7. Provider Abstraction

Each channel has a **mock** adapter (default) and a **real** adapter that is **dormant** until selected via env. Real adapters lazy-import their SDK so they are never hard dependencies of the zero-infra path.

| Channel | Mock (default) | Real (production) | Activation |
|---|---|---|---|
| email | `MockEmailProvider` (`mock-email`) | `SmtpEmailProvider` (`smtp`, nodemailer / Brevo) | `NOTIF_EMAIL_PROVIDER=smtp` + SMTP_* |
| sms | `MockSmsProvider` (`mock-sms`) | `TwilioSmsProvider` (`twilio-sms`, twilio SDK), `Msg91SmsProvider` (`msg91-sms`, global fetch) **or** `AirtelIqSmsProvider` (`airtel-iq-sms`, global fetch) | `NOTIF_SMS_PROVIDER=twilio` + TWILIO_* — or — `=msg91` + MSG91_* (see §7.2) — or — `=airtel` + AIRTEL_IQ_* + DLT_* (see §7.1) |
| whatsapp | `MockWhatsAppProvider` (`mock-whatsapp`) | `MetaWhatsAppProvider` (`meta-whatsapp`, global fetch) | `NOTIF_WHATSAPP_PROVIDER=meta` + WHATSAPP_* (legacy `META_WHATSAPP_*` still honored as fallback) |

**Provider contract** (`Provider.js`): `get name()` and `async send({ to, subject?, body, event?, vars?, context?, correlationId?, meta? }) → { providerMessageId, status, raw }`. `event`, `vars` (ordered DLT variable values) and `context` (the rendered template context, for gateways that need variables *by name*) are supplied by the Dispatcher for India/DLT SMS providers; every other adapter ignores them. On unrecoverable failure it **throws** — the Dispatcher converts throws into retry/dead-letter. Returning normally means "accepted".

Mock providers log to console and return a synthetic id. They also expose deterministic failure hooks for testing retry: a recipient containing **`fail@`** (email) or **`000000`** (sms/whatsapp) throws.

**Activating real providers:**
- **SMTP / Brevo:** `NOTIF_EMAIL_PROVIDER=smtp`, set `SMTP_HOST` (Brevo: `smtp-relay.brevo.com`) + `SMTP_PORT/SECURE/USER/PASS/FROM`. Ships with verified TLS (`minVersion TLSv1.2`), connection pooling, per-window rate limiting, connection/greeting/socket timeouts, and graceful reconnect on broken pooled connections. Sends HTML with auto plain-text fallback and supports attachments (nodemailer format); delivery status maps `accepted → sent` and throws when all recipients are rejected. Tunables: `SMTP_POOL/MAX_CONNECTIONS/MAX_MESSAGES/RATE_LIMIT/RATE_DELTA_MS/CONNECTION_TIMEOUT_MS/GREETING_TIMEOUT_MS/SOCKET_TIMEOUT_MS/REQUIRE_TLS/TLS_REJECT_UNAUTHORIZED`. Requires `npm i nodemailer` (already installed).
- **Twilio SMS:** `NOTIF_SMS_PROVIDER=twilio`, set `TWILIO_ACCOUNT_SID/AUTH_TOKEN/SMS_FROM`. Requires `npm i twilio` (already installed).
- **MSG91 SMS:** `NOTIF_SMS_PROVIDER=msg91`, set `MSG91_API_KEY`, `MSG91_SENDER_ID` (approved 6-char DLT header, `KVROCR`) and the per-event template ids `MSG91_OTP_TEMPLATE_ID` / `MSG91_REMINDER_TEMPLATE_ID` / `MSG91_BOOKING_TEMPLATE_ID` (+ optional `MSG91_*_VARS/DEFAULT_COUNTRY_CODE/BASE_URL/TIMEOUT_MS`). India DLT-compliant, uses the v5 Flow API over built-in fetch (no SDK). **Selects the approved template by event and sends only variable values — never message text** (see §7.2); the rendered body is deliberately ignored, because MSG91 renders the DLT-approved content itself. `AbortController` timeout. It does **one** attempt and **classifies** the outcome, attaching a `retryable` flag; the Dispatcher owns the actual retry/backoff (see §8). Transient failures (network, timeout, HTTP `408/429/500/502/503/504`) are retryable; permanent ones (bad config, unmapped/unconfigured template, invalid number, HTTP `400/401/403/404`, MSG91 logical errors) fail fast. Config is validated at startup — when `msg91` is selected, a missing `MSG91_API_KEY`/`MSG91_SENDER_ID`/OTP id/reminder id **fails closed in production** (warns in development); the booking id is optional and only that event stops sending while it is unset. The auth key, the full phone number and variable values (the OTP is one) are never logged.
- **Airtel IQ SMS:** `NOTIF_SMS_PROVIDER=airtel`, set `AIRTEL_IQ_CUSTOMER_ID/USERNAME/PASSWORD` + `AIRTEL_IQ_SENDER_ID` (approved 6-char DLT header, falls back to `DLT_HEADER_ID`) and the `DLT_*` template ids (+ optional `AIRTEL_IQ_BASE_URL/MESSAGE_TYPE/DEFAULT_COUNTRY_CODE/TIMEOUT_MS`). Uses Airtel's `v2/sms/send` xchange endpoint over built-in fetch (no SDK) with HTTP Basic auth. Sends the **rendered body** plus the per-event `dltTemplateId` and `entityId`; Airtel matches the body against the registered template operator-side. An event with **no registered template id fails permanently** rather than sending — an unregistered body is accepted with a `200` and then silently dropped by the operator, so dead-lettering is the only way it gets noticed. Same one-attempt/classify contract as MSG91: transient (network, timeout, `408/429/5xx`) retryable, permanent (bad config, unregistered template, invalid number, other `4xx`) not. Credentials come from the **Airtel IQ console**, which is a separate product from the DLT portal registration. Credentials, recipients and bodies are never logged.
- **Meta WhatsApp:** `NOTIF_WHATSAPP_PROVIDER=meta`, set `WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN` (+ optional `WHATSAPP_API_VERSION/TIMEOUT_MS`); legacy `META_WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN/API_VERSION` are still honored as fallbacks. Uses built-in fetch (Node 18+), no SDK. Supports text, image and document (PDF) via public link, and template messages; `AbortController` timeout, a small transient retry (429/5xx/network) with deterministic backoff, and error mapping that never leaks the token.

**Adding a new vendor:** write an adapter class implementing the contract under `providers/<channel>/`, then add one line to the `REGISTRY` in `providers/index.js` (e.g. `ses`, `sendgrid`, `resend` for email; `textlocal`, `kaleyra` for sms — `twilio` and `msg91` already ship; `twilio-whatsapp`, `interakt` for whatsapp). Select it via the channel's `NOTIF_*_PROVIDER` env var. Business code is untouched. (`getProvider` caches one instance per channel.)

> Rich-content extras (`buttons`, `mediaUrl`, `attachments`) are passed to providers via `message.meta`. The mock and SMS-grade providers ignore them gracefully. The Meta adapter now supports text, image and document (PDF) messages via public link, and template messages; the SMTP adapter supports attachments in nodemailer format. WhatsApp rich-template buttons remain a registered extension point.

---

## 7.1 India DLT compliance (`config/dlt.js`)

Every commercial SMS to an Indian number must match a **content template** pre-registered on a DLT portal and approved by the operators. Each approved template carries a 19-digit **Template ID** that must travel with the send. A body that does not match is accepted with a `200` and then **dropped silently** — the failure is invisible from the API response, which is why this module treats an unregistered event as a hard, non-retryable error.

DLT identifiers are issued by the operator chain, not by the sender, so **the same Entity ID and Template IDs work through Airtel IQ, MSG91, or any other aggregator.** Registering once covers Jio/Airtel/Vi/BSNL.

**Three worlds, one source of truth.** `config/dlt.js` ties together the `{{handlebars}}` template the engine renders, the `{#var#}` text a human registered on the portal, and the ordered variable values on the wire. The portal text is *derived from* the code templates, so an edit to an SMS template visibly changes the registration sheet — the signal that it must be re-registered before the edit can ship.

```bash
npm run dlt:templates            # the exact text to paste into the portal, per event
npm run dlt:templates -- --env   # the .env block to fill in with approved ids
npm run dlt:templates -- --json  # machine-readable
```

**Branding is fixed text, not a variable.** `companyName`, `supportPhone`, `supportEmail` and `websiteUrl` (`FIXED_KEYS`) are baked into the registered template as literals rather than registered as `{#var#}`. This is not cosmetic: operator scrubbing rejects templates that are mostly variable, and caps variable content at ~30 characters — a brand name alone can consume that entire budget, and the Header already asserts the brand. **Set `COMPANY_NAME` and `SUPPORT_PHONE` correctly *before* registering**, because changing them later invalidates every approved template.

**Config.** `DLT_ENTITY_ID` (19-digit Principal Entity ID), `DLT_HEADER_ID` (approved 6-char sender header), and one `DLT_TID_<EVENT>` per event — e.g. `DLT_TID_BOOKING_CONFIRMED`. Ids are read lazily from env, matching how every real provider reads its credentials. `validateProviderConfig()` fails closed in production when `airtel` is selected with no registered ids, or when branding is still a `«CHANGEME»` placeholder.

**Per-provider mapping — two different id spaces.** Airtel IQ submits the **rendered body** plus the 19-digit **Airtel DLT** template id (`DLT_TID_<EVENT>`, this module) and the operator matches the text. MSG91 works the other way round: the approved content lives *in MSG91*, and a send carries MSG91's own 24-char **MSG91 template id** plus **named** variable values (`config/msg91Templates.js`) - no message text at all. The two ids are not interchangeable; sending one where the other is expected is rejected. The Dispatcher hands every SMS provider both the ordered `vars` (Airtel) and the rendered `context` (MSG91), and each uses what it needs. See §7.2.

> The round-trip invariant — *registered template text + ordered vars must reproduce the transmitted body byte-for-byte* — is enforced by a test (`__tests__/dlt.test.js`) across all SMS templates. If that test fails, SMS has silently stopped being delivered.

---

## 7.2 MSG91 template mapping (`config/msg91Templates.js`)

RoadCruise sends through **MSG91** against its **Airtel DLT** registration (PE ID `1701177061700570449`, header `KVROCR`). MSG91 stores the approved content, so a send transmits **no message text** — only the template id for that event plus the values for its variables. That is what guarantees the delivered message is character-identical to what the operators approved.

**One mapping, three facts per event:**

| Event | MSG91 template | MSG91 template id (env) | Airtel DLT id |
|---|---|---|---|
| `auth.otp_requested` | `OTP_VERIFICATION` | `MSG91_OTP_TEMPLATE_ID` | `1077512810022246340` |
| `trip.reminder` | `REMINDER_BEFORE_RIDE` | `MSG91_REMINDER_TEMPLATE_ID` | `1077340200023002579` |
| `booking.confirmed` | `BOOKING_CONFIRMATION` | `MSG91_BOOKING_TEMPLATE_ID` | `1077397880030911933` |

The Airtel DLT id is recorded **for cross-checking the MSG91 panel entry only** — it is never put on the wire to MSG91.

**The Flow API keys the template as `flow_id`.** Not `template_id` — MSG91 accepts a `template_id` request with HTTP 200 and then rejects it asynchronously as API-failed code 400 ("Template ID ... missing, incorrect, or archived").

**Variable names are configuration.** MSG91 templates use `##name##` placeholders and the names are whatever was typed into the MSG91 panel. For the DLT-verified OTP template those names are `alphanumeric` and `numeric` (the DLT variable *types*, carried over on import — not descriptions of meaning). `##alphanumeric##` occurs twice under one name, so MSG91 renders the same value in both the code position and the trailing signature; `##numeric##` has no determinable meaning and is deliberately left unmapped rather than guessed. `config/msg91Templates.js` ships defaults derived from the approved DLT content and this repo's SMS templates; a mismatch is corrected **without a deploy** via `MSG91_OTP_VARS` / `MSG91_REMINDER_VARS` / `MSG91_BOOKING_VARS`, written as `<msg91 variable name>=<context key>` in template order.

**OTP is currently BLOCKED.** Its MSG91 template declares `##alphanumeric##` twice under one name and a mid-sentence `##numeric##`, so no variable mapping renders a correct message (`alphanumeric=OTP, numeric=""` loses the signature; `numeric=OTP` yields `…(OTP) 739104to verify…`; `alphanumeric=brand` yields "RoadCruise is your One-Time Password"). Rather than ship a wrong mapping, the entry carries `unresolved` and an empty `defaultVars`, so every OTP send fails **non-retryably** and dead-letters with the reason on the record. Fix the template in the MSG91 panel to match the DLT-approved text with two distinctly named variables, then set `MSG91_OTP_VARS` to those names — supplying the override is itself what lifts the block, no deploy required.

**Nothing unapproved is ever sent.** An event with no mapped template, an unset template id, or an empty variable map raises a **non-retryable** error and dead-letters. That is deliberate: it is how booking SMS stays off the wire until `BOOKING_CONFIRMATION` exists in MSG91, and it never touches the booking itself — the Dispatcher isolates provider failures.

**OTP.** The application generates the code and passes it in the event payload (`{{otp}}`). The provider never generates one, and deliberately does **not** use MSG91's `/api/v5/otp` endpoint, which would mint a second code with its own expiry and desynchronise verification.

**The Flow API does not authenticate.** `POST /api/v5/flow/` answers `{"type":"success"}` even for a completely bogus auth key (verified against this account, 2026-08-08), so "accepted by MSG91" is **not** evidence a message was sent. Delivery-report endpoints do authenticate, so `--verify-key` uses one as the real credential check and the smoke test refuses to send until it passes. MSG91 also returns the request id in `message`, not `request_id`.

```bash
npm run msg91:templates                                    # mapping + what is missing
npm run msg91:templates -- --verify-key                    # does the AuthKey actually work?
npm run msg91:templates -- --send-otp 9876543210 --code 482913   # ONE real SMS
```

---

## 8. Queue & Retry

**Default (zero-infra):** `InProcessQueue` — a non-blocking background worker that polls the repository (`findDue`, default every 1000 ms) for due records (`QUEUED`, or `FAILED` with `nextAttemptAt` in the past), processing up to `NOTIF_CONCURRENCY` (default 4) at a time. Records survive process restarts because due-state lives in the store, not memory. `enqueue()` is just a hint to wake the loop early.

**Scaled-out:** `BullMQQueue` — activated automatically when `REDIS_URL` is set (factory in `queue/index.js`). Requires `npm i bullmq ioredis` (lazy-imported; default concurrency 8, queue `rc-notifications`). The Dispatcher is unchanged either way — retry scheduling is owned by the Dispatcher, the queue only delivers ids to the processor.

**Retry / backoff** — owned by `Dispatcher._handleFailure` / `_backoffMs`:

```
attempts        = record.attempts + 1   (incremented on each failure)
raw             = baseBackoffMs * factor ^ max(0, attempt - 1)
jitter          = random integer in [0, jitterMs)
nextAttemptAt   = now + ( min(maxBackoffMs, raw) + jitter )
```

With defaults (`baseBackoffMs=2000`, `factor=3`, `maxBackoffMs=60000`, `jitterMs=500`, `maxAttempts=3`):

| Failure # | raw delay | capped + jitter |
|---|---|---|
| attempt 1 → schedule retry | 2000 × 3⁰ = 2000 ms | ~2000–2500 ms |
| attempt 2 → schedule retry | 2000 × 3¹ = 6000 ms | ~6000–6500 ms |
| attempt 3 (= maxAttempts) | — | **dead-letter** (no further retry) |

**Error classification (retryable vs terminal):** a provider may attach `err.retryable = false` to a thrown error to signal a *permanent* failure (e.g. a `4xx` such as a bad DLT template or invalid credentials — retrying can never succeed). When set, `_handleFailure` skips retries and dead-letters immediately (audit `detail.terminal = true`). The flag is **opt-in**: any error without it (the default for mock/SMTP/Meta) is treated as retryable, so existing behavior is unchanged. The MSG91 provider is the first to use this.

**Dead-letter behavior:** when `attempts >= maxAttempts` **or** the error is non-retryable, the record is set to `DEAD_LETTER`, a DLQ entry is pushed via `pushDeadLetter`, `metrics.deadLettered` increments, an audit `dead_letter` entry is written, and `_alertAdmin` sends an ops email (via the email provider) to `dlqAlert.email` if alerting is enabled.

---

## 9. Persistence / DB Schema

Default persistence is the atomic, write-serialized JSON store (`repository/store.js`) writing to `src/notifications/data/`. `notifications.json` holds `{ notifications: [], deadLetters: [] }`; `audit.json` holds `{ entries: [] }`.

### Notification record (`notifications[]`)

| Field | Meaning |
|---|---|
| `id` | `RC-NTF-<uuid>` primary key |
| `eventId` | source event envelope id |
| `event` | event string (e.g. `payment.successful`) |
| `correlationId` | from envelope (meta.correlationId / payload.id) |
| `customerId` | resolved customer identity |
| `bookingId` | from context |
| `channel` | `email` / `sms` / `whatsapp` |
| `provider` | active provider name for the channel |
| `templateKey` | template key (= event) |
| `recipient` | resolved address for the channel |
| `status` | `DeliveryStatus` (queued/processing/sent/delivered/read/failed/dead_letter/skipped) |
| `attempts` / `maxAttempts` | retry counters |
| `idempotencyKey` | dedupe key (`idk_...`) |
| `payload` | sanitized rendering context (no secrets) |
| `attachments` | array passed from emit payload |
| `rendered` | `{ subject?, body }` actually sent |
| `providerResponse` | raw provider ack/id |
| `error` | last error message |
| `nextAttemptAt` | when the worker may pick it up next |
| `createdAt` / `updatedAt` / `sentAt` / `completedAt` | timestamps (ISO) |

### Audit entry (`audit.json` entries[])

| Field | Meaning |
|---|---|
| `auditId` | `RC-AUD-<uuid>` |
| `at` | ISO timestamp |
| `actor` | who triggered (default `system`) |
| `action` | `enqueued`, `sent`, `retry`, `dead_letter`, `skipped`, `deduped`, `manual_retry`, ... |
| `event` | event string |
| `notificationId` | linked notification id |
| `channel` | channel |
| `result` | `queued` / `ok` / `scheduled` / `failed` / `duplicate` / `no_recipient` / `requeued` ... |
| `detail` | freeform JSON (provider id, attempt, error, ...) |

### Dead-letter entry (`notifications.json` deadLetters[])

| Field | Meaning |
|---|---|
| `notificationId` | the dead notification |
| `event`, `channel`, `recipient` | context |
| `error` | last error |
| `attempts` | attempts made |
| `movedAt` | when moved to DLQ |

### Forward-looking PostgreSQL DDL (migration target)

```sql
CREATE TABLE notifications (
  id                TEXT PRIMARY KEY,                 -- RC-NTF-<uuid>
  event_id          TEXT,
  event             TEXT NOT NULL,
  correlation_id    TEXT,
  customer_id       TEXT,
  booking_id        TEXT,
  channel           TEXT NOT NULL,                    -- email | sms | whatsapp
  provider          TEXT,
  template_key      TEXT,
  recipient         TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  idempotency_key   TEXT UNIQUE,
  payload           JSONB,
  attachments       JSONB DEFAULT '[]'::jsonb,
  rendered          JSONB,
  provider_response JSONB,
  error             TEXT,
  next_attempt_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);
CREATE INDEX idx_notifications_status_next ON notifications (status, next_attempt_at);
CREATE INDEX idx_notifications_customer    ON notifications (customer_id);
CREATE INDEX idx_notifications_booking     ON notifications (booking_id);

CREATE TABLE notification_audit (
  audit_id        TEXT PRIMARY KEY,                   -- RC-AUD-<uuid>
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor           TEXT NOT NULL DEFAULT 'system',
  action          TEXT NOT NULL,
  event           TEXT,
  notification_id TEXT REFERENCES notifications(id),
  channel         TEXT,
  result          TEXT,
  detail          JSONB
);
CREATE INDEX idx_audit_notification ON notification_audit (notification_id);

CREATE TABLE notification_dead_letters (
  id              BIGSERIAL PRIMARY KEY,
  notification_id TEXT REFERENCES notifications(id),
  event           TEXT,
  channel         TEXT,
  recipient       TEXT,
  error           TEXT,
  attempts        INTEGER,
  moved_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> The `idempotency_key UNIQUE` constraint is the DB-level enforcement of the dedupe rule. A `PostgresNotificationRepository` implementing the same method contract is a registered extension point — see §15.

---

## 10. Admin / ERP API Reference

Mounted at **`/api/notifications`**. Every route is behind `adminGuard` (header `x-admin-token`). JSON envelopes.

| Method | Path | Params | Description |
|---|---|---|---|
| GET | `/api/notifications` | query: `status, channel, event, customerId, bookingId, search, limit(=50), offset(=0)` | List + search + paginate. Returns `{ total, limit, offset, items }`. |
| GET | `/api/notifications/metrics` | — | Metrics snapshot (see §12). |
| GET | `/api/notifications/dead-letters` | — | `{ items: [...] }` DLQ contents. |
| GET | `/api/notifications/audit` | query: `limit(=100), offset(=0)` | Paginated audit trail `{ total, items }`. |
| GET | `/api/notifications/export` | — | Downloads all notification records as a JSON attachment. |
| GET | `/api/notifications/:id` | path: `id` | Single record + its `auditTrail`. `404` if missing. |
| POST | `/api/notifications/:id/retry` | body: `{ extraAttempts?: number }`; header: `x-admin-actor?` | Re-queue a failed/dead record, raising its attempt budget. |
| POST | `/api/notifications/resend` | body: `{ event, payload }` **or** `{ fromNotificationId }`; header: `x-admin-actor?` | Re-emit a domain event (new notifications). `202` with `{ accepted, eventId, event }`. `400` if no event/source, `404` if source missing. |

**Auth behavior** (`adminGuard.js`):
- Token set → `x-admin-token` header must equal `NOTIF_ADMIN_TOKEN`, else `401`.
- No token + **production** (`NODE_ENV=production`) → fail-closed `503` (admin API disabled).
- No token + **non-production** → allowed but logs a loud warning (dev convenience).

**Example curls:**

```bash
# list failed SMS, page 1
curl -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
  "http://localhost:5000/api/notifications?status=failed&channel=sms&limit=20"

# metrics
curl -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
  http://localhost:5000/api/notifications/metrics

# single record + audit trail
curl -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
  http://localhost:5000/api/notifications/RC-NTF-xxxx

# manual retry with extra budget
curl -X POST -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" -H "x-admin-actor: ops@roadcruise" \
  -d '{"extraAttempts":2}' \
  http://localhost:5000/api/notifications/RC-NTF-xxxx/retry

# resend a fresh event
curl -X POST -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event":"payment.successful","payload":{"id":"RC-BK-1234","email":"a@b.com","fare":4500}}' \
  http://localhost:5000/api/notifications/resend

# resend from an existing notification
curl -X POST -H "x-admin-token: $NOTIF_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fromNotificationId":"RC-NTF-xxxx"}' \
  http://localhost:5000/api/notifications/resend
```

---

## 11. Feature Flags & Environment Variables

All config comes from env (`config/notification.config.js`). Booleans accept `1/true/yes/on`.

| Variable | Default | Meaning |
|---|---|---|
| `NOTIF_ENABLED` | `true` | Master switch. `false` = engine does not subscribe to events / start the worker. |
| `NOTIF_EMAIL_ENABLED` | `true` | Enable email channel. |
| `NOTIF_SMS_ENABLED` | `true` | Enable SMS channel. |
| `NOTIF_WHATSAPP_ENABLED` | `true` | Enable WhatsApp channel. |
| `NOTIF_EMAIL_PROVIDER` | `mock` | `mock` \| `smtp`. |
| `NOTIF_SMS_PROVIDER` | `mock` | `mock` \| `twilio` \| `msg91`. |
| `NOTIF_WHATSAPP_PROVIDER` | `mock` | `mock` \| `meta`. |
| `REDIS_URL` | _unset_ | If set → BullMQ/Redis queue (else in-process). |
| `DATABASE_URL` | _unset_ | If set → intended Postgres repo (currently warns + falls back to JSON). |
| `NOTIF_MAX_ATTEMPTS` | `3` | Max delivery attempts before dead-letter. |
| `NOTIF_BACKOFF_MS` | `2000` | Base backoff (ms). |
| `NOTIF_BACKOFF_FACTOR` | `3` | Exponential factor. |
| `NOTIF_MAX_BACKOFF_MS` | `60000` | Backoff cap (ms). |
| `NOTIF_BACKOFF_JITTER_MS` | `500` | Random jitter added to backoff (ms). |
| `NOTIF_CONCURRENCY` | `4` | In-process worker concurrency. |
| `COMPANY_NAME` | `Road Cruise` | Branding `{{companyName}}`. |
| `SUPPORT_PHONE` | `+91 99999 99999` | Branding `{{supportPhone}}`. |
| `SUPPORT_EMAIL` | `support@roadcruise.com` | Branding `{{supportEmail}}`; DLQ alert fallback. |
| `COMPANY_URL` | `https://roadcruise.example` | Branding `{{websiteUrl}}`. |
| `COMPANY_LOGO_URL` | `""` | Branding `{{logoUrl}}`. |
| `ADMIN_NAME` | `Karthik` | Admin display name in admin-alert context. |
| `ADMIN_EMAIL` | `SUPPORT_EMAIL` | Admin inbox for booking alerts (Email). Unset → email channel skipped. |
| `ADMIN_WHATSAPP` | `SUPPORT_PHONE` | Admin WhatsApp for booking alerts. Unset → whatsapp channel skipped. |
| `NOTIF_ADMIN_TOKEN` | _unset_ | Admin API token (REQUIRED in production). |
| `NODE_ENV` | _unset_ | `production` makes the admin token mandatory (fail-closed). |
| `NOTIF_DLQ_ALERT_ENABLED` | `true` | Email ops alert on dead-letter. |
| `NOTIF_DLQ_ALERT_EMAIL` | `SUPPORT_EMAIL` | DLQ alert recipient. |
| `SMTP_HOST` | _unset_ | SMTP host (required for smtp provider; Brevo: `smtp-relay.brevo.com`). |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | Implicit TLS on connect (`true` = TLS/465). |
| `SMTP_USER` / `SMTP_PASS` | _unset_ | SMTP auth. |
| `SMTP_FROM` | `SUPPORT_EMAIL` or `no-reply@roadcruise.com` | From address. |
| `SMTP_POOL` | `true` | Enable connection pooling. |
| `SMTP_MAX_CONNECTIONS` | `5` | Max pooled connections. |
| `SMTP_MAX_MESSAGES` | `100` | Max messages per pooled connection. |
| `SMTP_RATE_LIMIT` | `0` | Messages per rate window (`0` = unlimited). |
| `SMTP_RATE_DELTA_MS` | `1000` | Rate-limit window (ms). |
| `SMTP_CONNECTION_TIMEOUT_MS` | `10000` | Connection timeout (ms). |
| `SMTP_GREETING_TIMEOUT_MS` | `10000` | Greeting timeout (ms). |
| `SMTP_SOCKET_TIMEOUT_MS` | `20000` | Socket idle timeout (ms). |
| `SMTP_REQUIRE_TLS` | `true` | Require STARTTLS upgrade. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Reject invalid/self-signed TLS certs. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | _unset_ | Twilio creds. |
| `TWILIO_SMS_FROM` | _unset_ | Twilio SMS sender. |
| `TWILIO_WHATSAPP_FROM` | _unset_ | Twilio WhatsApp sender (for a future twilio-whatsapp adapter). |
| `MSG91_API_KEY` | _unset_ | MSG91 AuthKey (required for msg91 provider). **Server only** — never expose to the client bundle. |
| `MSG91_SENDER_ID` | _unset_ | Approved 6-char DLT header (RoadCruise: `KVROCR`). |
| `MSG91_OTP_TEMPLATE_ID` | _unset_ | MSG91 template id for `auth.otp_requested`. Required when `msg91` is selected. |
| `MSG91_REMINDER_TEMPLATE_ID` | _unset_ | MSG91 template id for `trip.reminder`. Required when `msg91` is selected. |
| `MSG91_BOOKING_TEMPLATE_ID` | _unset_ | MSG91 template id for `booking.confirmed`. Optional — that event fails safe while unset. |
| `MSG91_OTP_VARS` / `MSG91_REMINDER_VARS` / `MSG91_BOOKING_VARS` | _unset_ | Override the `##name##` -> context-key mapping, e.g. `otp=otp,company=companyName`. |
| `MSG91_DEFAULT_COUNTRY_CODE` | `91` | Default country code for recipient numbers. |
| `MSG91_BASE_URL` | `https://control.msg91.com` | MSG91 API base URL. |
| `MSG91_TIMEOUT_MS` | `15000` | Request timeout (ms). |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` | _unset_ | Meta Cloud API creds. |
| `WHATSAPP_API_VERSION` | `v21.0` | Meta Graph API version. |
| `WHATSAPP_TIMEOUT_MS` | `15000` | Request timeout (ms). |
| `META_WHATSAPP_PHONE_NUMBER_ID` / `META_WHATSAPP_ACCESS_TOKEN` | _unset_ | Legacy alias for `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` (fallback). |
| `META_WHATSAPP_API_VERSION` | `v21.0` | Legacy alias for `WHATSAPP_API_VERSION` (fallback). |

---

## 12. Observability

`GET /api/notifications/metrics` returns `metrics.snapshot(repository)`:

```jsonc
{
  "counters": {
    "enqueued": 0, "processed": 0, "sent": 0, "failed": 0,
    "deadLettered": 0, "retries": 0,
    "byChannel": { "email": {"sent":0,"failed":0,"retries":0,"latencyMsTotal":0,"latencyCount":0}, "sms": {...}, "whatsapp": {...} },
    "totalDeliveryMs": 0, "deliveredCount": 0
  },
  "byChannel": { "sms": { "sent": 0, "failed": 0, "retries": 0, "avgLatencyMs": 0 }, "email": {...}, "whatsapp": {...} },
  "totals": { "records": 0, "byStatus": { "queued":0, "sent":0, ... } },
  "rates": { "deliveryPct": 0, "failurePct": 0, "avgDeliveryMs": 0 },
  "queueSize": 0,
  "generatedAt": "ISO"
}
```

- **`deliveryPct`** = sent / (sent + failed) × 100 — success rate of completed send attempts.
- **`failurePct`** = failed / (sent + failed) × 100 — failure rate of attempts.
- **`avgDeliveryMs`** = mean provider send latency over successful sends.
- **`byChannel`** (top-level) — per-channel view that maps to the conventional SMS metrics: `sms.sent` = `sms_sent_total`, `sms.failed` = `sms_failed_total`, `sms.retries` = `sms_retry_total`, `sms.avgLatencyMs` = `sms_latency_ms`. Latency is tracked for both successful and failed sends. Same shape for `email` and `whatsapp`.
- **`queueSize`** = records currently `queued` + `processing`.
- `byStatus` is a live count from the repository; `counters` are in-memory since boot. Swap for Prometheus by emitting these counters to a registry.

---

## 13. Security Model

- **Idempotency / dedupe:** `idempotencyKey(event, channel, recipient, businessKey)` is a sha256 digest (`idk_<32hex>`). The service checks `findByIdempotencyKey` before enqueuing; a duplicate is audited as `deduped` and skipped. The Postgres target enforces this with a `UNIQUE` constraint.
- **Template sanitization / escaping:** email bodies are HTML-entity escaped (anti-XSS); SMS/WhatsApp bodies have ASCII control chars stripped (anti header/format injection). Missing placeholders never throw.
- **Recipient skipping:** a channel with no resolvable address is recorded as `skipped` (`no_recipient`) and audited — it is never treated as a failure and never retried.
- **Admin guard:** `x-admin-token` required; production fails closed if the token is unset; non-prod warns.
- **Secrets via env:** all provider credentials are read lazily from env and are never hardcoded or logged.
- **PII handling:** the stored `payload` is the sanitized rendering context (no secrets); provider responses store ids/acks. The audit log is append-only (entries are never updated or deleted), giving a tamper-evident trail of who/what/when.

---

## 14. Testing

```bash
npm run test:notifications
# → node --test src/notifications/__tests__/
```

Runs the Node built-in test runner across `__tests__/engine.test.js`, `idempotency.test.js`, and `templates.test.js`. No external services needed — mock providers + JSON store make the suite self-contained. (Mock failure hooks: recipient containing `fail@` for email, `000000` for sms/whatsapp, exercise the retry/dead-letter path.)

---

## 15. Migration / Rollout Plan

The module ships **disabled-safe with mocks**; each stage is independently reversible and introduces **zero breaking changes**. Roll forward by setting env vars only — no code edits required for stages (b)–(d).

**Stage (a) — Ship disabled-safe (current state).**
Mock providers, JSON store, in-process queue. `notifications.init(app)` mounts the admin API and starts the worker. Existing controllers carry only fire-and-forget emit lines that cannot affect responses. Nothing leaves the server (mock providers log to console). Safe to deploy as-is.

**Stage (b) — Flip feature flags.**
Confirm `NOTIF_ENABLED=true` and the per-channel flags for the channels you want live. Set `NOTIF_ADMIN_TOKEN` (mandatory once `NODE_ENV=production`) and `NOTIF_DLQ_ALERT_EMAIL`. Still using mocks — verify via `/api/notifications` and `/metrics`.

**Stage (c) — Configure real providers via env.**
Install the needed SDKs (`npm i nodemailer twilio`) and switch providers: `NOTIF_EMAIL_PROVIDER=smtp` (+ SMTP_*), `NOTIF_SMS_PROVIDER=twilio` (+ TWILIO_*), `NOTIF_WHATSAPP_PROVIDER=meta` (+ META_*). Flip one channel at a time; the engine, templates, and queue are unchanged.

**Stage (d) — Add Redis for BullMQ.**
`npm i bullmq ioredis`, set `REDIS_URL`. The factory transparently switches to `BullMQQueue` for durable, horizontally-scalable processing. Dispatcher and retry semantics are identical.

**Stage (e) — Postgres persistence.**
Implement `repository/PostgresNotificationRepository.js` against the same method contract, run the DDL from §9, wire it into `repository/index.js`, and set `DATABASE_URL`. (Today, `DATABASE_URL` warns and falls back to JSON — Postgres is a registered, not-yet-implemented extension point.)

**Rollback.** At any stage, set `NOTIF_ENABLED=false` to fully disable the engine (it stops subscribing to events and starting the worker) — existing emit calls become harmless no-ops and the app behaves exactly as before. Individual channels can be turned off with their `NOTIF_*_ENABLED` flags, and any real provider reverts to `mock` by changing one env var. No code changes or redeploys of business modules are needed to roll back.
