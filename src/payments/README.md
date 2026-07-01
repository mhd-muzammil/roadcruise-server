# Road Cruise — Enterprise Payment Module (Razorpay)

Authoritative documentation for the payment module under `src/payments/`.

This module adds online payments (Razorpay) to Road Cruise **additively and
non-breakingly**. It ships with a **mock gateway as the default**, so the entire
flow — order creation, signature verification, capture, webhooks, refunds,
notifications, receipts — runs end-to-end with **zero credentials and zero
infrastructure**. The real Razorpay adapter stays **dormant** until you flip
`PAYMENT_PROVIDER=razorpay` and supply keys. Customer communication is delegated
to the existing notification engine; the payment code never talks to a provider
(Twilio/SMTP/Meta) directly.

---

## 1. Overview & principles

| Principle | How it is enforced in code |
|---|---|
| **Provider-agnostic** | All business code depends on the `PaymentGateway` interface (`gateways/Gateway.js`), never on Razorpay. Adding a vendor = a new adapter class + one line in `gateways/index.js`. |
| **Additive / non-breaking** | New routes under `/api/payments`; no existing route, schema, or contract changes. `app.js` adds a `verify` hook to `express.json` that only *captures* `req.rawBody` — parsed `req.body` is unchanged for all existing routes. |
| **Mock-default / real-dormant** | `PAYMENT_PROVIDER` defaults to `mock` (`payment.config.js`). The Razorpay SDK is **lazy-imported** inside `RazorpayGateway._c()`, so it is never a hard dependency of the mock path. |
| **Reuses the notification engine** | `integration/notifications.js` only calls `notify(NotificationEvents.*, payload)`. The engine fans out to Email/SMS/WhatsApp. The payment module never imports a provider SDK for messaging. |
| **Backend verifies everything** | `verifyAndCapture` and `handleWebhook` verify HMAC-SHA256 signatures (timing-safe) **before** mutating state. A frontend "success" is never trusted. |
| **Idempotent & replay-safe** | Re-verifying a PAID payment short-circuits; webhook event ids are claimed atomically (`claimWebhook`); orders are deduped per booking and by `idempotencyKey` (`createIfAbsent`). |
| **Fails loud, never crashes** | `init()` runs `validateEnv()`; misconfiguration is logged as a warning, the host app keeps running, payments simply won't process until fixed. |

---

## 2. Architecture

```
                          ┌─────────────────────────────────────────────┐
   Booking module / API   │                                             │
   (utils/db.js bookings) │              PaymentService                 │
            │             │   (core/PaymentService.js, EventEmitter)    │
            ▼             │                                             │
   createOrderForBooking ─┼──▶ createOrder / verifyPayment / capture /  │
   verifyAndCapture       │      refund / verifyWebhook                 │
   handleWebhook          │                  │                          │
   refund                 └──────────────────┼──────────────────────────┘
                                             │ (Gateway interface only)
                                             ▼
                          ┌──────────────────────────────────────┐
                          │        PaymentGateway interface       │
                          │           (gateways/Gateway.js)       │
                          └───────────────┬───────────┬──────────┘
                                          │           │
                              ┌───────────▼──┐   ┌────▼─────────────┐
                              │  MockGateway │   │ RazorpayGateway  │
                              │  (default)   │   │ (dormant; lazy   │
                              │  HMAC-signed │   │  imports SDK)    │
                              └──────────────┘   └────────┬─────────┘
                                                          │ HTTPS
                                                          ▼
                                                   Razorpay API

   PaymentService ── emits domain events on its OWN emitter (observability)
                  └─ integration/notifications.js ─ notify() ─▶ Notification engine
                                                                   │
                                                      ┌────────────┼─────────────┐
                                                      ▼            ▼             ▼
                                                   Email          SMS        WhatsApp

   Razorpay  ──POST /api/payments/webhook──▶ controller (raw body + signature)
                                                      │
                                                      ▼
                                              PaymentService.handleWebhook
```

Key invariants:
- Business code → **PaymentService** → **Gateway interface** → Mock/Razorpay adapter.
- PaymentService → **notification engine** (`notify`) → Email/SMS/WhatsApp. Never a provider directly.
- Webhook HTTP → controller (raw body) → **PaymentService.handleWebhook**.

---

## 3. Payment flow (full sequence)

### Browser / checkout happy path

```
 Customer browser          Frontend / API            PaymentService            Gateway        Notification engine
       │                        │                          │                      │                   │
       │  (booking exists)      │                          │                      │                   │
       │  POST /orders ────────▶│ createOrderForBooking ──▶ │ createOrder ───────▶ │                   │
       │                        │                          │  status=CREATED       │                   │
       │                        │                          │  emit PAYMENT_CREATED │                   │
       │                        │                          │  notify PAYMENT_PENDING ──────────────────▶ (email/sms)
       │ ◀── checkout config ───│ ◀── {payment, checkout} ─ │                      │                   │
       │                        │                          │                      │                   │
       │  Razorpay Checkout (keyId, orderId, amount)        │                      │                   │
       │  user pays ───────────────────────────────────────────────────────────▶ │ (authorize)       │
       │ ◀── razorpay_order_id / payment_id / signature ────│                      │                   │
       │                        │                          │                      │                   │
       │  POST /verify ────────▶│ verifyAndCapture ───────▶ │ verifyPayment(sig) ─▶│ (HMAC, timing-safe)│
       │                        │                          │  capturePayment ────▶│                   │
       │                        │                          │  status=PAID          │                   │
       │                        │                          │  confirmBooking ("Approved")              │
       │                        │                          │  generateInvoice/Receipt                  │
       │                        │                          │  emit PAYMENT_SUCCEEDED                    │
       │                        │                          │  emit INVOICE_GENERATED                    │
       │                        │                          │  emit BOOKING_CONFIRMED                     │
       │                        │                          │  notify PAYMENT_SUCCESSFUL ────────────────▶ (email)
       │                        │                          │  notify INVOICE_GENERATED ─────────────────▶ (email)
       │                        │                          │  notify BOOKING_CONFIRMED ─────────────────▶ (email/sms/wa)
       │ ◀── {success, status} ─│ ◀── {verified, payment} ─ │                                            │
```

Steps in order:

1. **Create order** — `POST /api/payments/orders { bookingId }` → `createOrderForBooking`.
   Looks up the booking via the bridge; reuses an existing PAID/active order if present
   (idempotent); otherwise calls `gateway.createOrder`, persists a `CREATED` payment record,
   appends an `order_created` transaction + audit entry, emits `PAYMENT_CREATED`, and fires a
   `PAYMENT_PENDING` notification.
2. **Checkout** — frontend opens the Razorpay Checkout widget using the returned public
   `checkout` block (`keyId`, `orderId`, `amount`, `currency`).
3. **Verify signature** — `POST /api/payments/verify { razorpay_order_id, razorpay_payment_id,
   razorpay_signature }` → `verifyAndCapture`. The gateway verifies
   `HMAC_SHA256(order_id|payment_id, KEY_SECRET)` with a timing-safe comparison. A failed
   signature transitions the payment to `FAILED` and returns `400 INVALID_SIGNATURE`.
4. **Capture** — `gateway.capturePayment`. Capture failure keeps the payment `AUTHORIZED`
   (recoverable), audits `capture_failed`, and rethrows.
5. **Mark PAID** — `_markPaid` (idempotent): sets `PAID` + `capturedAt`.
6. **Confirm booking** — `bookingBridge.confirmBooking` sets booking `status="Approved"` (the
   existing confirmed value), idempotently.
7. **Emit + notify** — emits `PAYMENT_SUCCEEDED`, `INVOICE_GENERATED`, `BOOKING_CONFIRMED` on
   the service emitter, then `notify`s `PAYMENT_SUCCESSFUL`, `INVOICE_GENERATED`,
   `BOOKING_CONFIRMED` into the notification engine.

### Webhook flow (gateway → us)

```
 Razorpay ──POST /api/payments/webhook──▶ controller
   headers: x-razorpay-signature, x-razorpay-event-id
   body:    raw JSON (captured as req.rawBody by express.json verify hook)
                         │
                         ▼
        PaymentService.handleWebhook
          1. if !webhookEnabled → {ok, ignored}
          2. gateway.verifyWebhook(rawBody, signature)  ── fail → audit + {ok:false, invalid_signature}
          3. JSON.parse(rawBody)                         ── fail → {ok:false, invalid_json}
          4. claimWebhook(eventId)                       ── duplicate → {ok:true, duplicate:true}
          5. audit webhook_received
          6. _routeWebhook(event):
               payment.authorized        → status=AUTHORIZED, emit PAYMENT_AUTHORIZED
               payment.captured/order.paid → _markPaid (confirm + notify, idempotent)
               payment.failed            → _fail (FAILED + notify PAYMENT_FAILED)
               refund.created            → REFUND_INITIATED, notify REFUND_INITIATED
               refund.processed          → _completeRefund → REFUNDED|PARTIALLY_REFUNDED, notify REFUND_COMPLETED
               (other)                   → acknowledged, audited, not actioned
```

The webhook is the source of truth for asynchronous transitions (and the safety net if the
browser never returns to `/verify`).

---

## 4. Payment states & transitions

States from `config/paymentEvents.js` (`PaymentStatus`):

| State | Value | Meaning |
|---|---|---|
| `PENDING` | `pending` | Record seeded, no gateway order yet (transient default in repo). |
| `CREATED` | `created` | Gateway order created; awaiting customer payment. |
| `AUTHORIZED` | `authorized` | Funds authorized but not captured (or capture failed/recoverable). |
| `CAPTURED` | `captured` | Captured at gateway (intermediate; service moves straight to PAID). |
| `PAID` | `paid` | Verified + captured. Booking confirmed. **Terminal for the happy path.** |
| `FAILED` | `failed` | Signature/verification/payment failed. Terminal. |
| `CANCELLED` | `cancelled` | Cancelled. Terminal. |
| `EXPIRED` | `expired` | Order expiry window elapsed. Terminal. |
| `REFUND_INITIATED` | `refund_initiated` | Refund requested, awaiting gateway processing. |
| `REFUNDED` | `refunded` | Fully refunded (total refunded ≥ amount). Terminal. |
| `PARTIALLY_REFUNDED` | `partially_refunded` | Some, not all, refunded. Can be refunded again. |

**Terminal states** (`TERMINAL_STATES`): `FAILED`, `CANCELLED`, `EXPIRED`, `REFUNDED`.

Legal transitions enforced by `PaymentService`:

```
   PENDING ──▶ CREATED ──▶ AUTHORIZED ──▶ (capture) ──▶ PAID
                  │             │                         │
                  └─────────────┴──────────────▶ FAILED / CANCELLED / EXPIRED
                                                          │
                                       PAID ──▶ REFUND_INITIATED ──▶ REFUNDED
                                                                 └──▶ PARTIALLY_REFUNDED ──▶ (refund again)
```

Enforcement notes (exact code behavior):
- `verifyAndCapture`: if already `PAID` → short-circuit `{alreadyPaid:true}`. On bad signature → `_fail` (→ `FAILED`). On capture failure → `AUTHORIZED` (kept for retry).
- `_markPaid`: re-reads the record; if already `PAID`, returns `{alreadyPaid:true}` (idempotent).
- `refund`: only allowed from `PAID` or `PARTIALLY_REFUNDED`; otherwise `INVALID_STATE` (HTTP 409).
- Webhook `payment.authorized` / `payment.failed` only act when not already `PAID`.
- `_completeRefund`: sets `REFUNDED` when cumulative refunds ≥ amount, else `PARTIALLY_REFUNDED`.

---

## 5. Events

### A. Domain events on the PaymentService emitter (`PaymentEvents`)

These are for **observability/admin** within the process; subscribe via
`getPaymentService().on(...)`. They do **not** send customer messages.

| Event | Value | Emitted by |
|---|---|---|
| `PAYMENT_CREATED` | `payment.created` | `createOrderForBooking` |
| `PAYMENT_AUTHORIZED` | `payment.authorized` | webhook `payment.authorized` |
| `PAYMENT_SUCCEEDED` | `payment.succeeded` | `_markPaid` |
| `PAYMENT_FAILED` | `payment.failed` | `_fail` |
| `PAYMENT_CANCELLED` | `payment.cancelled` | (catalogued; reserved) |
| `PAYMENT_EXPIRED` | `payment.expired` | (catalogued; reserved) |
| `REFUND_INITIATED` | `payment.refund_initiated` | `refund`, webhook `refund.created` |
| `REFUND_COMPLETED` | `payment.refund_completed` | `_completeRefund` |
| `INVOICE_GENERATED` | `payment.invoice_generated` | `_markPaid` |
| `BOOKING_CONFIRMED` | `payment.booking_confirmed` | `_markPaid` |

### B. Notification events bridged via `integration/notifications.js`

The bridge calls `notify(NotificationEvents.*, payload, {actor:"payment-service"})`. Which
`notify()` events fire, exactly, per lifecycle point:

| Lifecycle point | Bridge function | `notify()` events fired |
|---|---|---|
| Order created (pending) | `emitPaymentPending` | `PAYMENT_PENDING` (`payment.pending`) |
| **Payment success** | `emitPaymentSucceeded` | `PAYMENT_SUCCESSFUL`, `INVOICE_GENERATED`, `BOOKING_CONFIRMED` |
| **Payment failure** | `emitPaymentFailed` | `PAYMENT_FAILED` (`payment.failed`) |
| **Refund initiated** | `emitRefundInitiated` | `REFUND_INITIATED` (`refund.initiated`) |
| **Refund completed** | `emitRefundCompleted` | `REFUND_COMPLETED` (`refund.completed`) |

Payloads carry the fields the existing templates expect: the full booking object spread plus
`paymentAmount` (defaults to `booking.fare`), `paymentStatus` (`"Paid"`/`"Pending"`/`"Failed"`/
`"Refund Initiated"`/`"Refunded"`), `invoiceNumber`, and on success `receiptNumber`.

> Note: success fires **three** notification events (receipt/invoice + booking confirmation),
> matching `_markPaid`'s three domain emits.

---

## 6. Folder structure

```
src/payments/
├── index.js                      # Public facade: init(app), getPaymentService(), PaymentEvents, PaymentStatus
├── config/
│   ├── payment.config.js         # Env-driven config, validateEnv(), webhookSecret(), keySecret()
│   └── paymentEvents.js          # PaymentEvents, PaymentStatus, TERMINAL_STATES, WebhookEvents
├── core/
│   ├── PaymentService.js         # Lifecycle orchestrator (EventEmitter); the only business entry point
│   ├── signature.js              # Timing-safe HMAC-SHA256 checkout/webhook sign + verify
│   └── receiptNumber.js          # generateReceiptNumber / generateInvoiceNumber / generatePaymentId
├── gateways/
│   ├── Gateway.js                # PaymentGateway interface + toMinor/fromMinor money helpers
│   ├── MockGateway.js            # Default adapter: deterministic HMAC, simulateCheckout/buildWebhook
│   ├── RazorpayGateway.js        # Real adapter (dormant; lazy-imports the razorpay SDK)
│   └── index.js                  # getGateway() factory + REGISTRY; _resetGateway() test seam
├── repository/
│   └── PaymentRepository.js      # payments / transactions / audit / webhooks over JsonStore
├── integration/
│   ├── bookingBridge.js          # getBooking / confirmBooking (the only touch of booking data)
│   └── notifications.js          # emit* helpers → notify() into the notification engine
├── receipts/
│   └── ReceiptService.js         # generateInvoice / generateReceipt / buildQrData / generatePdf
├── api/
│   ├── payment.routes.js         # Express router mounted at /api/payments
│   └── payment.controller.js     # Route handlers
├── data/                         # Runtime JSON store (payments.json) — created on first write
└── README.md                     # This document
```

(There is no `__tests__/` directory yet — see [Testing](#14-testing).)

---

## 7. Gateway abstraction

### The interface (`gateways/Gateway.js`)

```js
class PaymentGateway {
  get name()                                          // adapter id, e.g. "mock" | "razorpay"
  async createOrder({ amount, currency, receipt, notes }) // → { orderId, amount, currency, status, raw }
  verifyPayment({ orderId, paymentId, signature })        // → boolean (synchronous, timing-safe HMAC)
  async capturePayment({ paymentId, amount, currency })   // → { status, raw }
  async fetchPayment(paymentId)                           // → object
  async refund({ paymentId, amount, notes })              // → { refundId, status, amount, raw }
  verifyWebhook(rawBody, signature)                       // → boolean (timing-safe HMAC over RAW body)
}
```

> **Money convention:** all `amount` values passed **to/from gateway methods** are in the
> smallest currency unit (**paise** for INR). `PaymentService` stores **major units (rupees)**
> in records and converts at the edge with `toMinor` / `fromMinor`.

### How the Mock gateway works (`MockGateway.js`)

- Emulates the full Razorpay surface (order/verify/capture/refund/webhook) using
  **deterministic HMAC-SHA256 signatures** computed with `config.mockSecret`. No real-money
  calls are ever made.
- `createOrder` → `order_mock_…`; `capturePayment` → `{status:"captured"}`; `refund` →
  `{status:"processed"}` (so mock refunds **complete immediately**, no webhook needed).
- `verifyPayment` / `verifyWebhook` reuse the shared `signature.js` verifiers — the **same math**
  as the real path, just keyed by `mockSecret`.
- **Dev/test helpers** (simulate the browser + gateway producing valid artifacts):
  - `simulateCheckout(orderId)` → `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`
    with a valid checkout signature.
  - `buildWebhook(event, payloadObj)` → `{ body, signature }` with a valid webhook signature.

### How to enable Razorpay

1. `npm i razorpay` (it is an `optionalDependency`; lazy-imported only when selected).
2. Set `PAYMENT_PROVIDER=razorpay` and `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
   (+ `RAZORPAY_WEBHOOK_SECRET` if webhooks are on).
3. The `RazorpayGateway` builds the SDK client lazily; signature verification still uses
   `signature.js` (no SDK dependency), keyed by the Razorpay secrets.

### How to add Stripe / Cashfree / PhonePe / PayPal

1. Create `gateways/StripeGateway.js` (etc.) implementing `PaymentGateway`.
2. Register it in `gateways/index.js`:
   ```js
   const REGISTRY = {
     mock: () => new MockGateway(),
     razorpay: () => new RazorpayGateway(),
     stripe: () => new StripeGateway(),   // ← add one line
   };
   ```
3. Set `PAYMENT_PROVIDER=stripe`. **No PaymentService, booking, or API code changes.**

---

## 8. Persistence / store

The repository (`PaymentRepository`) reuses the **notifications `JsonStore`** (atomic
temp-file + rename, with a serialized per-file write chain) but points it at its **own data
directory** `src/payments/data/` (file `payments.json`). The store seeds four collections:
`payments[]`, `transactions[]`, `audit[]`, `webhooks[]`. The whole engine depends only on the
repository contract, so a Postgres adapter can replace it with no service changes.

### Payment record shape (all fields)

| Field | Type | Notes |
|---|---|---|
| `paymentId` | string | `RC-PAY-…`, generated if absent |
| `bookingId` | string | FK into existing bookings |
| `customerId` | string\|null | Falls back to `booking.phone` |
| `gateway` | string | adapter name (`mock`/`razorpay`) |
| `gatewayOrderId` | string | order id from the gateway |
| `gatewayPaymentId` | string\|null | set on authorize/capture |
| `gatewaySignature` | string\|null | checkout signature retained for webhook reconcile |
| `receiptNumber` | string | `RC-RCPT-…` |
| `invoiceNumber` | string | `RC-INV-<bookingId>` |
| `currency` | string | default `INR` |
| `amount` | number | **major units (rupees)** |
| `tax` | number | default `0` |
| `discount` | number | default `0` |
| `paymentMethod` | string\|null | from booking |
| `status` | string | a `PaymentStatus` value |
| `failureReason` | string\|null | set on `FAILED` |
| `idempotencyKey` | string | `order:<bookingId>:<orderId>` |
| `refunds` | array | `[{ refundId, amount, at }]` |
| `capturedAt` | ISO string\|null | set on PAID |
| `refundedAt` | ISO string\|null | set on refund completion |
| `createdAt` / `updatedAt` | ISO string | maintained by the repo |

**Transactions ledger** (`transactions[]`, append-only): `{ paymentId, type, at, … }` where
`type` ∈ `order_created` \| `captured` \| `refund_initiated`, plus contextual fields
(`gatewayOrderId`, `gatewayPaymentId`, `amount`, `via`, `captureStatus`, `refundId`).

**Audit trail** (`audit[]`, append-only): `{ at, actor, action, result, paymentId?, bookingId?,
detail? }`. Actions include `order_created`, `payment_captured`, `payment_failed`,
`capture_failed`, `refund_initiated`, `refund_completed`, `webhook_received`, `webhook_rejected`,
`webhook_error`.

**Webhook dedupe list** (`webhooks[]`): array of processed event ids. `claimWebhook(eventId)`
atomically returns `true` the first time (process) and `false` thereafter (replay → skip).
A null/empty id returns `true` (nothing to dedupe on).

### Forward-looking PostgreSQL DDL (extension point — not yet implemented)

```sql
CREATE TABLE payments (
    payment_id          TEXT PRIMARY KEY,
    booking_id          TEXT NOT NULL,
    customer_id         TEXT,
    gateway             TEXT NOT NULL,
    gateway_order_id    TEXT,
    gateway_payment_id  TEXT,
    gateway_signature   TEXT,
    receipt_number      TEXT,
    invoice_number      TEXT,
    currency            TEXT NOT NULL DEFAULT 'INR',
    amount              NUMERIC(12,2) NOT NULL,         -- major units (rupees)
    tax                 NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount            NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_method      TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    failure_reason      TEXT,
    idempotency_key     TEXT UNIQUE,                    -- dedupe orders
    refunds             JSONB NOT NULL DEFAULT '[]',
    captured_at         TIMESTAMPTZ,
    refunded_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_booking ON payments (booking_id);
CREATE INDEX idx_payments_order   ON payments (gateway_order_id);
CREATE INDEX idx_payments_status  ON payments (status);

CREATE TABLE payment_transactions (
    id                  BIGSERIAL PRIMARY KEY,
    payment_id          TEXT NOT NULL REFERENCES payments(payment_id),
    type                TEXT NOT NULL,                  -- order_created | captured | refund_initiated
    gateway_order_id    TEXT,
    gateway_payment_id  TEXT,
    refund_id           TEXT,
    amount              NUMERIC(12,2),
    via                 TEXT,                           -- checkout | webhook
    capture_status      TEXT,
    at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_txn_payment ON payment_transactions (payment_id);

CREATE TABLE payment_audit (
    id          BIGSERIAL PRIMARY KEY,
    payment_id  TEXT,
    booking_id  TEXT,
    actor       TEXT NOT NULL DEFAULT 'system',
    action      TEXT NOT NULL,
    result      TEXT,
    detail      JSONB,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_payment ON payment_audit (payment_id);

-- Webhook dedupe (replaces the webhooks[] list)
CREATE TABLE payment_webhooks (
    event_id     TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 9. API reference

Mounted at `/api/payments` (by `index.js` → `app.use("/api/payments", paymentRoutes)`).

### Public / customer + gateway

| Method | Path | Auth | Body / Query |
|---|---|---|---|
| GET | `/config` | public | — |
| POST | `/orders` | public | `{ bookingId, amount?, customerId? }` |
| POST | `/verify` | public | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` (or `orderId`/`paymentId`/`signature`) |
| POST | `/webhook` | **signature** (not token) | raw JSON; headers `x-razorpay-signature`, `x-razorpay-event-id` |

### Admin (require `x-admin-token` via shared `adminGuard`)

| Method | Path | Body / Query |
|---|---|---|
| GET | `/` | query: `status`, `bookingId`, `customerId`, `gateway`, `search`, `limit`, `offset` |
| GET | `/:paymentId` | — (returns record + `transactions` + `audit`) |
| POST | `/:paymentId/refund` | `{ amount?, notes? }` (omit `amount` for full refund) |
| POST | `/:paymentId/retry` | — (only `FAILED`/`CANCELLED`/`EXPIRED`; else 409) |
| GET | `/:paymentId/receipt` | query: `type=invoice` \| (default `receipt`) |

`x-admin-actor` (optional) is recorded in the audit trail on `/orders`, `/refund`, `/retry`.

### Example requests

```bash
# Public config (safe for the browser — no secrets)
curl http://localhost:5000/api/payments/config

# Create / reuse an order for a booking
curl -X POST http://localhost:5000/api/payments/orders \
  -H "Content-Type: application/json" \
  -d '{"bookingId":"RC-BK-123","amount":4999}'

# Verify checkout signature + capture
curl -X POST http://localhost:5000/api/payments/verify \
  -H "Content-Type: application/json" \
  -d '{"razorpay_order_id":"order_xxx","razorpay_payment_id":"pay_xxx","razorpay_signature":"<hmac>"}'

# Webhook (gateway → us). Signature over the RAW body.
curl -X POST http://localhost:5000/api/payments/webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: <hmac_of_raw_body>" \
  -H "x-razorpay-event-id: evt_abc123" \
  --data-binary '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_xxx","order_id":"order_xxx"}}}}'

# --- Admin (x-admin-token) ---
curl http://localhost:5000/api/payments?status=paid \
  -H "x-admin-token: $NOTIF_ADMIN_TOKEN"

curl http://localhost:5000/api/payments/RC-PAY-XXXX \
  -H "x-admin-token: $NOTIF_ADMIN_TOKEN"

curl -X POST http://localhost:5000/api/payments/RC-PAY-XXXX/refund \
  -H "x-admin-token: $NOTIF_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount":1000,"notes":{"reason":"partial cancellation"}}'

curl -X POST http://localhost:5000/api/payments/RC-PAY-XXXX/retry \
  -H "x-admin-token: $NOTIF_ADMIN_TOKEN"

curl "http://localhost:5000/api/payments/RC-PAY-XXXX/receipt?type=invoice" \
  -H "x-admin-token: $NOTIF_ADMIN_TOKEN"
```

### Raw-body verification (how it works)

`app.js` configures `express.json({ verify: (req,_res,buf) => { req.rawBody = buf } })`. This
**captures the exact bytes** before parsing, while still populating `req.body` for every route
(non-breaking). The webhook handler reads `req.rawBody` and passes it to
`gateway.verifyWebhook(rawBody, signature)`, which computes `HMAC_SHA256(rawBody, WEBHOOK_SECRET)`.
The raw body is mandatory: re-serializing the parsed JSON would change the bytes and break the HMAC.
(The controller has a `JSON.stringify(req.body)` fallback only for environments where `rawBody`
is unavailable — the canonical path is `req.rawBody`.)

---

## 10. Security model

- **Timing-safe HMAC** — `core/signature.js` uses `crypto.timingSafeEqual` over equal-length
  buffers (`timingSafeEqualHex`) to defeat timing attacks. Checkout =
  `HMAC_SHA256(orderId|paymentId, KEY_SECRET)`; webhook = `HMAC_SHA256(rawBody, WEBHOOK_SECRET)`.
- **Webhook verification on RAW body** — verification runs against `req.rawBody`, never the
  re-serialized parse (see §9).
- **Replay / idempotency** — `claimWebhook(eventId)` atomically rejects duplicate webhook
  deliveries; orders are deduped per booking (active/paid reuse) and by `idempotencyKey`
  (`createIfAbsent`); `verifyAndCapture` and `_markPaid` short-circuit on already-PAID.
- **Never trust the frontend** — a payment becomes `PAID` only after the backend verifies the
  signature and captures; the browser's claim of success is irrelevant.
- **Secrets only in env** — `RAZORPAY_*` and `PAYMENT_MOCK_SECRET` live in env, never in
  source, and are never logged. `/config` exposes only the public `keyId`.
- **Admin guard reuse** — admin routes use the notifications module's `adminGuard`
  (`x-admin-token`), with the token sourced from `NOTIF_ADMIN_TOKEN` (or `PAYMENT_ADMIN_TOKEN`).

---

## 11. Environment variables

From `config/payment.config.js` and `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `PAYMENTS_ENABLED` | `true` | Master switch. `false` → module not mounted; rollback kill-switch. |
| `PAYMENT_WEBHOOK_ENABLED` | `true` | Enable webhook processing. |
| `PAYMENT_PROVIDER` | `mock` | `mock` \| `razorpay` (lowercased). |
| `PAYMENT_CURRENCY` | `INR` | ISO currency code. |
| `PAYMENT_TAX_PERCENT` | `0` | Tax percentage (paise-safe, applied in receipts). |
| `PAYMENT_ORDER_EXPIRY_MIN` | `30` | PENDING→EXPIRED window (minutes). |
| `PAYMENT_MAX_ATTEMPTS` | `3` | Retry attempts for transient gateway errors. |
| `PAYMENT_BACKOFF_MS` | `1000` | Base backoff (ms). |
| `PAYMENT_MOCK_SECRET` | `mock_secret_key` | Mock gateway signing secret (dev/test). |
| `RAZORPAY_KEY_ID` | `null` | Required when provider=razorpay. |
| `RAZORPAY_KEY_SECRET` | `null` | Required when provider=razorpay. |
| `RAZORPAY_WEBHOOK_SECRET` | `null` | Required when provider=razorpay **and** webhooks on. |
| `NOTIF_ADMIN_TOKEN` | `null` | Admin token (shared with notifications). |
| `PAYMENT_ADMIN_TOKEN` | `null` | Overrides `NOTIF_ADMIN_TOKEN` for payment admin. |
| `NODE_ENV` | — | `production` flips `config.isProduction`. |

`validateEnv()` (run at `init`): when `provider=razorpay`, requires `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, and (if webhooks on) `RAZORPAY_WEBHOOK_SECRET`. Failures are logged as a
warning; the app does not crash.

The **active secrets** are resolved by provider: `keySecret()` and `webhookSecret()` return the
Razorpay secrets when `provider=razorpay`, otherwise `mockSecret`.

---

## 12. Feature flags & money convention

- **Feature flags:** `PAYMENTS_ENABLED` (mount the module at all) and `PAYMENT_WEBHOOK_ENABLED`
  (process webhooks). With `PAYMENTS_ENABLED=false`, `init()` logs and returns `null` without
  mounting any route — a clean rollback.
- **Money convention (paise vs rupees):** Records and notifications use **major units (rupees)**.
  The **gateway boundary** uses **minor units (paise)**. Convert with
  `toMinor(major) = Math.round(major*100)` and `fromMinor(minor) = minor/100`
  (`gateways/Gateway.js`). PaymentService applies `toMinor` when calling `createOrder` /
  `capturePayment` / `refund`, and `fromMinor` when reading refund amounts off webhooks.

---

## 13. Receipts / invoices / QR

`receipts/ReceiptService.js` produces structured documents plus HTML (email-safe inline styles)
and plain-text renderings:

- `generateInvoice(payment, booking)` → invoice doc: company brand, customer, booking,
  `amounts` (`subtotal`/`tax`/`discount`/`total`/`currency`), payment details, `qrData`,
  `.html`, `.text`.
- `generateReceipt(payment, booking)` → payment-receipt doc: amount, gateway, paid-at,
  `qrData`, `.html`, `.text`.
- `buildQrData(payment)` → a stable, scannable **string** payload
  (`RC-PAYMENT|pid=…|booking=…|amt=…|inv=…|rcpt=…`).

**Extension points (honestly marked):**
- **QR image** — only the QR *payload string* (`qrData`) is produced today. Turning it into an
  actual image is a future step using the `qrcode` optional dependency.
- **PDF** — `generatePdf(doc)` **lazy-loads `pdfkit`** and throws a clear, actionable error if
  it isn't installed (`npm i pdfkit`). It is not wired into notifications as an attachment yet.

Both `pdfkit` and `qrcode` are `optionalDependencies` in `package.json`, so the default
(dependency-free) path never breaks without them.

---

## 14. Testing

Run the payment test suite:

```bash
npm run test:payments
```

This runs `node --test-concurrency=1 --test "src/payments/__tests__/*.test.js"`.

> Status: the `src/payments/__tests__/` directory does not exist yet, so the script currently
> matches no files. Add tests there to populate the suite. The `MockGateway` is built for this —
> `simulateCheckout(orderId)` and `buildWebhook(event, payloadObj)` produce **validly signed**
> checkout results and webhook payloads, and `gateways/index.js` exposes a `_resetGateway()`
> test seam to clear the cached singleton between cases.

---

## 15. Migration & deployment guide

**Zero breaking changes.** The module ships dormant-by-default and is removable with one env var.

### Staged rollout

**(a) Ship with the mock gateway (no keys, zero breaking changes)**
- Deploy as-is. `PAYMENT_PROVIDER=mock`, no Razorpay account required. The full flow
  (orders → verify → capture → notifications → receipts → refunds) works end-to-end against the
  mock gateway. Existing routes are untouched; the only app-level change is the additive
  `rawBody` capture in `express.json`.

**(b) Go live with Razorpay**
- `npm i razorpay`.
- Set:
  ```
  PAYMENT_PROVIDER=razorpay
  RAZORPAY_KEY_ID=rzp_live_xxx
  RAZORPAY_KEY_SECRET=xxx
  ```
- `validateEnv()` will warn (not crash) if any required key is missing.

**(c) Configure the Razorpay webhook**
- In the Razorpay Dashboard → Settings → Webhooks, add:
  - **URL:** `https://<your-host>/api/payments/webhook`
  - **Secret:** the same value you put in `RAZORPAY_WEBHOOK_SECRET`.
  - **Active events** (the ones this module handles, per `WebhookEvents`):
    `payment.authorized`, `payment.captured`, `payment.failed`,
    `refund.created`, `refund.processed`, `order.paid`.
- Razorpay signs the raw body; we verify it (§9/§10). Unhandled event types are acknowledged
  and audited but not actioned.

**(d) Future: Postgres repository**
- Implement a Postgres adapter against the `PaymentRepository` contract and apply the DDL in §8
  (note `idempotency_key UNIQUE`). No PaymentService/API changes required.

### Rollback

Set `PAYMENTS_ENABLED=false` and redeploy. The module is not mounted; everything else runs
unchanged. (Or revert to `PAYMENT_PROVIDER=mock` to keep the flow alive without real charges.)

### Frontend integration (no current UI change required)

The backend exposes everything a frontend needs without any UI change today; when a UI is
added it follows this sequence:

```js
// 1. Fetch public config (no secrets)
const cfg = await fetch("/api/payments/config").then(r => r.json());

// 2. Create / reuse an order for a booking
const { checkout } = await fetch("/api/payments/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bookingId }),
}).then(r => r.json());

// 3. Open Razorpay Checkout with the public checkout block
const rzp = new Razorpay({
  key: checkout.keyId,
  order_id: checkout.orderId,
  amount: checkout.amount,      // paise
  currency: checkout.currency,
  handler: async (resp) => {
    // 4. Verify on the backend (the trust anchor) — never mark paid client-side
    await fetch("/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_order_id: resp.razorpay_order_id,
        razorpay_payment_id: resp.razorpay_payment_id,
        razorpay_signature: resp.razorpay_signature,
      }),
    });
  },
});
rzp.open();
```

The webhook is the asynchronous safety net — even if the browser never returns to `/verify`,
`payment.captured`/`order.paid` will mark the payment PAID and confirm the booking.
