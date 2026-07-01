import { NotificationEvents } from "../../config/events.js";

/**
 * SMS template library: eventKey -> { text }. Short, professional, < 320 chars.
 * Key flows implemented; the sms-templates agent extends with remaining events.
 */
export const smsTemplates = {
  [NotificationEvents.BOOKING_CREATED]: {
    text: "{{companyName}}: Hi {{customerName}}, booking {{bookingId}} received for {{vehicle}} on {{tripDate}}. We'll confirm shortly. Help: {{supportPhone}}",
  },
  [NotificationEvents.BOOKING_CONFIRMED]: {
    text: "{{companyName}}: Booking {{bookingId}} CONFIRMED. {{vehicle}}, {{tripDate}}. Driver: {{driver}}. Fare Rs.{{paymentAmount}}. Help: {{supportPhone}}",
  },
  [NotificationEvents.PAYMENT_SUCCESSFUL]: {
    text: "{{companyName}}: Payment of Rs.{{paymentAmount}} received for {{bookingId}}. Invoice {{invoiceNumber}}. Thank you!",
  },
  [NotificationEvents.PAYMENT_FAILED]: {
    text: "{{companyName}}: Payment for {{bookingId}} FAILED. Please retry or call {{supportPhone}}.",
  },

  // Booking lifecycle
  [NotificationEvents.BOOKING_CANCELLED]: {
    text: "{{companyName}}: Booking {{bookingId}} ({{vehicle}}, {{tripDate}}) has been CANCELLED. For assistance call {{supportPhone}}.",
  },
  [NotificationEvents.BOOKING_RESCHEDULED]: {
    text: "{{companyName}}: Booking {{bookingId}} RESCHEDULED to {{tripDate}}. {{vehicle}}, {{pickup}} to {{drop}}. Help: {{supportPhone}}",
  },

  // Payment lifecycle
  [NotificationEvents.PAYMENT_PENDING]: {
    text: "{{companyName}}: Payment of Rs.{{paymentAmount}} for {{bookingId}} is PENDING. Please complete it to confirm your booking. Help: {{supportPhone}}",
  },
  [NotificationEvents.REFUND_INITIATED]: {
    text: "{{companyName}}: Refund of Rs.{{paymentAmount}} for {{bookingId}} has been INITIATED. It will reflect in 5-7 business days. Help: {{supportPhone}}",
  },
  [NotificationEvents.REFUND_COMPLETED]: {
    text: "{{companyName}}: Refund of Rs.{{paymentAmount}} for {{bookingId}} is COMPLETED. Ref invoice {{invoiceNumber}}. Thank you!",
  },

  // Trip lifecycle
  [NotificationEvents.TRIP_SCHEDULED]: {
    text: "{{companyName}}: Trip for {{bookingId}} SCHEDULED on {{tripDate}}. {{vehicle}}, pickup {{pickup}}. Driver: {{driver}}. Help: {{supportPhone}}",
  },
  [NotificationEvents.TRIP_REMINDER]: {
    text: "{{companyName}}: Reminder - your trip {{bookingId}} is on {{tripDate}}. {{vehicle}}, pickup {{pickup}}. Driver: {{driver}}. Help: {{supportPhone}}",
  },
  [NotificationEvents.TRIP_STARTED]: {
    text: "{{companyName}}: Your trip {{bookingId}} has STARTED. {{vehicle}}, driver {{driver}}. Safe travels! Help: {{supportPhone}}",
  },
  [NotificationEvents.TRIP_COMPLETED]: {
    text: "{{companyName}}: Trip {{bookingId}} COMPLETED. Thank you for riding with us, {{customerName}}. Invoice {{invoiceNumber}}. Help: {{supportPhone}}",
  },
  [NotificationEvents.DRIVER_ASSIGNED]: {
    text: "{{companyName}}: Driver {{driver}} assigned to booking {{bookingId}} ({{vehicle}}, {{tripDate}}). Help: {{supportPhone}}",
  },
  [NotificationEvents.DRIVER_CHANGED]: {
    text: "{{companyName}}: Driver for booking {{bookingId}} updated to {{driver}} ({{vehicle}}, {{tripDate}}). Help: {{supportPhone}}",
  },

  // Documents
  [NotificationEvents.INVOICE_GENERATED]: {
    text: "{{companyName}}: Invoice {{invoiceNumber}} for booking {{bookingId}} (Rs.{{paymentAmount}}) is ready. Help: {{supportPhone}}",
  },

  // Identity / support
  [NotificationEvents.CUSTOMER_REGISTERED]: {
    text: "{{companyName}}: Welcome {{customerName}}! Your account is active. For any help call {{supportPhone}}.",
  },
  [NotificationEvents.OTP_REQUESTED]: {
    // NOTE: context builder MUST supply {{otp}} — it is not part of defaultContext.
    text: "{{companyName}}: Your verification code is {{otp}}. It expires shortly. Do not share it with anyone. Help: {{supportPhone}}",
  },
  [NotificationEvents.PASSWORD_RESET]: {
    // NOTE: context builder MUST supply {{otp}} (reset code) — not part of defaultContext.
    text: "{{companyName}}: Your password reset code is {{otp}}. Do not share it. If you didn't request this, call {{supportPhone}}.",
  },

  generic: {
    text: "{{companyName}}: Update on {{bookingId}}. Call {{supportPhone}} for details.",
  },
};

export default smsTemplates;
