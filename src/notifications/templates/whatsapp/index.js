import { NotificationEvents } from "../../config/events.js";

/**
 * WhatsApp template library: eventKey -> { text, buttons?, mediaUrl? }.
 *
 * `text` is the rendered message body. `buttons` and `mediaUrl` are passed
 * through to providers that support rich messages (Meta Cloud API); the mock
 * and SMS-grade providers ignore them gracefully. Key flows implemented; the
 * whatsapp-templates agent extends with remaining events + rich content.
 */
export const whatsappTemplates = {
  [NotificationEvents.BOOKING_CREATED]: {
    text:
      "*{{companyName}}*\nHi {{customerName}}, we've received booking *{{bookingId}}*.\n\n🚗 {{vehicle}}\n📅 {{tripDate}}\n🧭 {{tripType}}\n\nWe'll confirm shortly.",
    buttons: [{ type: "url", text: "View Booking", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.BOOKING_CONFIRMED]: {
    text:
      "*{{companyName}}* ✅\nBooking *{{bookingId}}* is CONFIRMED!\n\n🚗 {{vehicle}}\n📍 {{pickup}} → {{drop}}\n📅 {{tripDate}}\n👨‍✈️ Driver: {{driver}}\n💰 Fare: ₹{{paymentAmount}}",
    buttons: [
      { type: "url", text: "Track Trip", url: "{{websiteUrl}}" },
      { type: "phone", text: "Call Support", phone: "{{supportPhone}}" },
    ],
  },
  [NotificationEvents.PAYMENT_SUCCESSFUL]: {
    text:
      "*{{companyName}}*\n💳 Payment of *₹{{paymentAmount}}* received for {{bookingId}}.\nInvoice: {{invoiceNumber}}\nStatus: {{paymentStatus}}\n\nReceipt attached.",
  },
  [NotificationEvents.PAYMENT_FAILED]: {
    text:
      "*{{companyName}}*\n⚠️ Payment for *{{bookingId}}* failed.\nAmount: ₹{{paymentAmount}}\nPlease retry or contact {{supportPhone}}.",
    buttons: [{ type: "url", text: "Retry Payment", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.BOOKING_CANCELLED]: {
    text:
      "*{{companyName}}* ❌\nBooking *{{bookingId}}* has been CANCELLED.\n\n🚗 {{vehicle}}\n📍 {{pickup}} → {{drop}}\n📅 {{tripDate}}\n\nAny refund due will be processed shortly. Need help? Reach us at {{supportPhone}}.",
    buttons: [
      { type: "url", text: "Book Again", url: "{{websiteUrl}}" },
      { type: "phone", text: "Call Support", phone: "{{supportPhone}}" },
    ],
  },
  [NotificationEvents.BOOKING_RESCHEDULED]: {
    text:
      "*{{companyName}}* 🔄\nBooking *{{bookingId}}* has been RESCHEDULED.\n\n📅 New schedule: {{tripDate}}\n🚗 {{vehicle}}\n📍 {{pickup}} → {{drop}}\n👨‍✈️ Driver: {{driver}}\n\nSee you then!",
    buttons: [{ type: "url", text: "View Booking", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.PAYMENT_PENDING]: {
    text:
      "*{{companyName}}* ⏳\nPayment for booking *{{bookingId}}* is PENDING.\n\n💰 Amount: ₹{{paymentAmount}}\nStatus: {{paymentStatus}}\n\nPlease complete your payment to confirm your trip.",
    buttons: [
      { type: "url", text: "Pay Now", url: "{{websiteUrl}}" },
      { type: "phone", text: "Call Support", phone: "{{supportPhone}}" },
    ],
  },
  [NotificationEvents.REFUND_INITIATED]: {
    text:
      "*{{companyName}}* 💸\nHi {{customerName}}, a refund of *₹{{paymentAmount}}* for booking *{{bookingId}}* has been INITIATED.\n\nInvoice: {{invoiceNumber}}\nStatus: {{paymentStatus}}\n\nIt should reflect in your account within 5-7 business days.",
    buttons: [{ type: "phone", text: "Call Support", phone: "{{supportPhone}}" }],
  },
  [NotificationEvents.REFUND_COMPLETED]: {
    text:
      "*{{companyName}}* ✅\nGood news {{customerName}}! Your refund of *₹{{paymentAmount}}* for booking *{{bookingId}}* is COMPLETE.\n\nInvoice: {{invoiceNumber}}\nStatus: {{paymentStatus}}\n\nThank you for choosing us.",
    buttons: [{ type: "url", text: "Book Again", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.TRIP_SCHEDULED]: {
    text:
      "*{{companyName}}* 🗓️\nYour trip for booking *{{bookingId}}* is SCHEDULED.\n\n📅 {{tripDate}}\n🧭 {{tripType}}\n🚗 {{vehicle}}\n📍 {{pickup}} → {{drop}}\n👨‍✈️ Driver: {{driver}}\n\nWe'll remind you before departure.",
    buttons: [{ type: "url", text: "View Trip", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.TRIP_REMINDER]: {
    text:
      "*{{companyName}}* ⏰\nReminder: your trip *{{bookingId}}* is coming up!\n\n📅 {{tripDate}}\n🚗 {{vehicle}}\n📍 Pickup: {{pickup}}\n👨‍✈️ Driver: {{driver}}\n\nPlease be ready at your pickup point.",
    buttons: [
      { type: "url", text: "Track Trip", url: "{{websiteUrl}}" },
      { type: "phone", text: "Call Driver", phone: "{{supportPhone}}" },
    ],
  },
  [NotificationEvents.TRIP_STARTED]: {
    text:
      "*{{companyName}}* 🚦\nYour trip *{{bookingId}}* has STARTED!\n\n🚗 {{vehicle}}\n📍 {{pickup}} → {{drop}}\n👨‍✈️ Driver: {{driver}}\n\nHave a safe and pleasant journey. 🛣️",
    buttons: [{ type: "url", text: "Track Live", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.TRIP_COMPLETED]: {
    text:
      "*{{companyName}}* 🏁\nYour trip *{{bookingId}}* is COMPLETE.\n\n📍 {{pickup}} → {{drop}}\n📅 {{tripDate}}\n💰 Fare: ₹{{paymentAmount}}\n\nThank you for travelling with us, {{customerName}}! We'd love your feedback. ⭐",
    buttons: [
      { type: "url", text: "Rate Your Trip", url: "{{websiteUrl}}" },
      { type: "url", text: "Book Again", url: "{{websiteUrl}}" },
    ],
  },
  [NotificationEvents.DRIVER_ASSIGNED]: {
    text:
      "*{{companyName}}* 👨‍✈️\nA driver has been ASSIGNED to booking *{{bookingId}}*.\n\nDriver: *{{driver}}*\n🚗 {{vehicle}}\n📅 {{tripDate}}\n📍 Pickup: {{pickup}}\n\nYour driver will contact you near pickup time.",
    buttons: [
      { type: "url", text: "View Details", url: "{{websiteUrl}}" },
      { type: "phone", text: "Call Support", phone: "{{supportPhone}}" },
    ],
  },
  [NotificationEvents.DRIVER_CHANGED]: {
    text:
      "*{{companyName}}* 🔄\nThe driver for booking *{{bookingId}}* has been CHANGED.\n\nNew driver: *{{driver}}*\n🚗 {{vehicle}}\n📅 {{tripDate}}\n📍 Pickup: {{pickup}}\n\nApologies for any inconvenience.",
    buttons: [{ type: "phone", text: "Call Support", phone: "{{supportPhone}}" }],
  },
  [NotificationEvents.INVOICE_GENERATED]: {
    text:
      "*{{companyName}}* 🧾\nInvoice *{{invoiceNumber}}* has been generated for booking *{{bookingId}}*.\n\n💰 Amount: ₹{{paymentAmount}}\nStatus: {{paymentStatus}}\n\nYour invoice is attached.",
    buttons: [{ type: "url", text: "Download Invoice", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.CUSTOMER_REGISTERED]: {
    text:
      "*{{companyName}}* 🎉\nWelcome aboard, {{customerName}}!\n\nYour account is all set. Book rides, track trips and manage payments right from your phone.\n\nNeed anything? We're here at {{supportPhone}}.",
    buttons: [{ type: "url", text: "Start Booking", url: "{{websiteUrl}}" }],
  },
  [NotificationEvents.OTP_REQUESTED]: {
    // NOTE: {{otp}} is NOT produced by the default context builder in
    // workflows/registry.js — the OTP_REQUESTED context builder MUST supply
    // `otp` in the template context for this template to render correctly.
    text:
      "*{{companyName}}* 🔐\nYour verification code is *{{otp}}*.\n\nIt is valid for a short time. Do NOT share this code with anyone — our team will never ask for it.",
  },
  [NotificationEvents.PASSWORD_RESET]: {
    text:
      "*{{companyName}}* 🔑\nHi {{customerName}}, we received a request to reset your password.\n\nTap below to set a new one. If you didn't request this, please ignore this message or contact {{supportPhone}}.",
    buttons: [{ type: "url", text: "Reset Password", url: "{{websiteUrl}}" }],
  },
  // ---- Internal ADMIN alerts (sent to the business's own WhatsApp) ----
  // Function form so package/pickup lines only appear when the booking has them.
  [NotificationEvents.ADMIN_BOOKING_PAID]: (ctx) => {
    const pkg = ctx.packageName ? `\n📦 ${ctx.packageName}` : "";
    const route = ctx.pickup && ctx.pickup !== "—" ? `\n📍 {{pickup}}${ctx.drop && ctx.drop !== "—" ? " → {{drop}}" : ""}` : "";
    return {
      text:
        `*{{companyName}}* — 💰 NEW PAID BOOKING\n\n👤 {{customerName}}\n📞 {{customerPhone}}\n🆔 {{bookingId}}${pkg}\n🚗 {{vehicle}}${route}\n📅 {{tripDate}}\n💳 Paid: ₹{{paymentAmount}} (Invoice {{invoiceNumber}})\n\nPayment received online — trip confirmed.`,
    };
  },
  [NotificationEvents.ADMIN_BOOKING_UNPAID]: (ctx) => {
    const pkg = ctx.packageName ? `\n📦 ${ctx.packageName}` : "";
    const route = ctx.pickup && ctx.pickup !== "—" ? `\n📍 {{pickup}}${ctx.drop && ctx.drop !== "—" ? " → {{drop}}" : ""}` : "";
    return {
      text:
        `*{{companyName}}* — 🆕 NEW BOOKING (UNPAID)\n\n👤 {{customerName}}\n📞 {{customerPhone}}\n🆔 {{bookingId}}${pkg}\n🚗 {{vehicle}}${route}\n📅 {{tripDate}}\n💵 Fare: ₹{{paymentAmount}}\n\n☎️ Please contact the customer to confirm and collect payment.`,
    };
  },
  generic: {
    text: "*{{companyName}}*\nUpdate on {{bookingId}}. Contact {{supportPhone}} for details.",
  },
};

export default whatsappTemplates;
