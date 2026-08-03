import { NotificationEvents } from "../../config/events.js";
import { emailLayout, detailTable, detailRow } from "./layout.js";

/**
 * True when a context value is present and meaningful (not empty / not the "—"
 * placeholder). Used by the function-form templates to include a detail row
 * ONLY when the booking actually carries that field — so a vehicle booking
 * doesn't show an empty "Package" row, a package booking doesn't show "Drop", etc.
 */
const has = (v) => v != null && v !== "" && v !== "—";

/** Conditionally render a detail row: `row(cond, label, value)`. */
const row = (cond, label, value) => (cond ? detailRow(label, value) : "");

/**
 * EMAIL template library: eventKey -> { subject, html }.
 *
 * Key flows (booking + payment) are implemented here as the reference standard.
 * The email-templates agent extends THIS file with the remaining events,
 * following the same layout + detailTable pattern. A `generic` fallback ensures
 * any event without a specific template still renders something safe.
 */
export const emailTemplates = {
  // Email verification (link-based). {{verificationLink}} is supplied by the
  // auth module via the notification context (workflows/registry.js).
  [NotificationEvents.EMAIL_VERIFICATION]: {
    subject: "Verify your email — {{companyName}}",
    html: emailLayout({
      title: "Verify Your Email",
      preheader: "Confirm your email address to secure your account.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, please confirm your email address to finish securing your {{companyName}} account.</p>
        <p style="margin:20px 0;"><a href="{{verificationLink}}" style="background:#d4af37;color:#18181b;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none;font-size:14px;">Verify Email</a></p>
        <p style="font-size:12px;color:#71717a;">If the button doesn't work, copy this link: {{verificationLink}}</p>
        <p style="font-size:12px;color:#a1a1aa;">If you didn't create this account, you can safely ignore this email.</p>`,
    }),
  },

  // Context-aware: rows adapt to the booking type (general / vehicle / package).
  [NotificationEvents.BOOKING_CREATED]: (ctx) => ({
    subject: "We received your booking {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Booking Received",
      preheader: "Your booking request is in.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, thanks for choosing {{companyName}}. We've received your booking and it is being processed.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            row(has(ctx.packageName), "Package", "{{packageName}}") +
            detailRow(has(ctx.packageName) ? "Vehicle Preference" : "Service / Vehicle", "{{vehicle}}") +
            row(has(ctx.pickup), "Pickup", "{{pickup}}") +
            row(has(ctx.drop), "Drop", "{{drop}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            row(has(ctx.passengers), "Passengers", "{{passengers}}") +
            row(has(ctx.pickupTime), "Pickup Time", "{{pickupTime}}") +
            row(has(ctx.specialRequests), "Special Requests", "{{specialRequests}}")
        )}
        <p style="font-size:13px;color:#71717a;">You'll get a confirmation once payment is verified.</p>`,
    }),
  }),

  [NotificationEvents.BOOKING_CONFIRMED]: {
    subject: "Booking Confirmed ✓ {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Booking is Confirmed",
      preheader: "All set! Your trip is confirmed.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your payment has been received and your booking is <strong>confirmed</strong>. Your trip details are below.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Pickup", "{{pickup}}") +
            detailRow("Drop", "{{drop}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            detailRow("Driver", "{{driver}}") +
            detailRow("Amount Paid", "₹{{paymentAmount}}")
        )}
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Our team at {{companyName}} will contact you <strong>as soon as possible</strong> to finalize your pickup and driver details.</p>
        <p style="font-size:13px;color:#71717a;">For anything urgent, call us at {{supportPhone}} or email {{supportEmail}}.</p>`,
    }),
  },

  [NotificationEvents.PAYMENT_SUCCESSFUL]: {
    subject: "Payment Received ₹{{paymentAmount}} — {{companyName}}",
    html: emailLayout({
      title: "Payment Successful",
      preheader: "We've received your payment.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, we've successfully received your payment. Your receipt details are below.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Invoice No.", "{{invoiceNumber}}") +
            detailRow("Amount Paid", "₹{{paymentAmount}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">Your invoice and receipt are attached where supported.</p>`,
    }),
  },

  [NotificationEvents.PAYMENT_FAILED]: {
    subject: "Action needed: payment failed for {{bookingId}}",
    html: emailLayout({
      title: "Payment Failed",
      preheader: "We couldn't process your payment.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, unfortunately your payment for booking {{bookingId}} could not be processed. Please retry or contact support.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Amount", "₹{{paymentAmount}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}`,
    }),
  },

  [NotificationEvents.BOOKING_CANCELLED]: {
    subject: "Booking Cancelled — {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Booking Has Been Cancelled",
      preheader: "Your booking has been cancelled.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your booking with {{companyName}} has been cancelled. If any payment was made, applicable refunds will be processed separately.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">If this was a mistake, please contact {{supportPhone}} and we'll be happy to help re-book.</p>`,
    }),
  },

  [NotificationEvents.BOOKING_RESCHEDULED]: {
    subject: "Booking Rescheduled — {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Booking Has Been Rescheduled",
      preheader: "Your trip dates have been updated.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your booking has been rescheduled. Please find your updated trip details below.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("New Trip Dates", "{{tripDate}}") +
            detailRow("Pickup", "{{pickup}}") +
            detailRow("Drop", "{{drop}}") +
            detailRow("Driver", "{{driver}}")
        )}
        <p style="font-size:13px;color:#71717a;">No further action is needed. Reach us at {{supportPhone}} if these details look incorrect.</p>`,
    }),
  },

  [NotificationEvents.PAYMENT_PENDING]: {
    subject: "Payment Pending for {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Payment is Pending",
      preheader: "Complete your payment to confirm your booking.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, we're still awaiting payment for your booking. Please complete it to confirm your trip.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Invoice No.", "{{invoiceNumber}}") +
            detailRow("Amount Due", "₹{{paymentAmount}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">You can pay online at {{websiteUrl}} or contact {{supportPhone}} for assistance.</p>`,
    }),
  },

  [NotificationEvents.REFUND_INITIATED]: {
    subject: "Refund Initiated for {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Refund Has Been Initiated",
      preheader: "We've started processing your refund.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, we've initiated a refund for your booking. It typically reaches your account within 5–7 business days, depending on your bank.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Invoice No.", "{{invoiceNumber}}") +
            detailRow("Refund Amount", "₹{{paymentAmount}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">We'll notify you again once the refund is complete.</p>`,
    }),
  },

  [NotificationEvents.REFUND_COMPLETED]: {
    subject: "Refund Completed — ₹{{paymentAmount}} — {{companyName}}",
    html: emailLayout({
      title: "Your Refund is Complete",
      preheader: "Your refund has been processed successfully.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, good news — your refund has been processed successfully. The amount should now be reflected in your account.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Invoice No.", "{{invoiceNumber}}") +
            detailRow("Refund Amount", "₹{{paymentAmount}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">If you don't see the amount within a few business days, please contact {{supportEmail}}.</p>`,
    }),
  },

  [NotificationEvents.TRIP_SCHEDULED]: {
    subject: "Your Trip is Scheduled — {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Trip is Scheduled",
      preheader: "Your upcoming trip details are confirmed.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your trip with {{companyName}} is scheduled. Here are the details for your journey.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            detailRow("Pickup", "{{pickup}}") +
            detailRow("Drop", "{{drop}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Driver", "{{driver}}")
        )}
        <p style="font-size:13px;color:#71717a;">We'll send a reminder closer to your pickup time.</p>`,
    }),
  },

  [NotificationEvents.TRIP_REMINDER]: {
    subject: "Reminder: Your Trip is Coming Up — {{bookingId}}",
    html: emailLayout({
      title: "Trip Reminder",
      preheader: "Your trip is coming up soon.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, this is a friendly reminder that your trip is coming up soon. Please be ready at your pickup point on time.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Pickup", "{{pickup}}") +
            detailRow("Drop", "{{drop}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Driver", "{{driver}}")
        )}
        <p style="font-size:13px;color:#71717a;">Need to make a change? Call {{supportPhone}} as soon as possible.</p>`,
    }),
  },

  [NotificationEvents.TRIP_STARTED]: {
    subject: "Your Trip Has Started — {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Trip Has Started",
      preheader: "Your journey is now underway.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your trip has started. We wish you a safe and comfortable journey with {{companyName}}.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Pickup", "{{pickup}}") +
            detailRow("Drop", "{{drop}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Driver", "{{driver}}")
        )}
        <p style="font-size:13px;color:#71717a;">For any assistance during your trip, call {{supportPhone}}.</p>`,
    }),
  },

  [NotificationEvents.TRIP_COMPLETED]: {
    subject: "Trip Completed — Thank You for Riding with {{companyName}}",
    html: emailLayout({
      title: "Your Trip is Complete",
      preheader: "Thank you for travelling with us.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your trip has been completed. Thank you for choosing {{companyName}} — we hope you had a great experience.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Pickup", "{{pickup}}") +
            detailRow("Drop", "{{drop}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Driver", "{{driver}}") +
            detailRow("Fare", "₹{{paymentAmount}}")
        )}
        <p style="font-size:13px;color:#71717a;">We'd love your feedback. Visit {{websiteUrl}} to share your experience.</p>`,
    }),
  },

  [NotificationEvents.DRIVER_ASSIGNED]: {
    subject: "Driver Assigned for {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Driver Has Been Assigned",
      preheader: "Your driver details are ready.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, a driver has been assigned for your upcoming trip. Here are the details.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Driver", "{{driver}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Pickup", "{{pickup}}")
        )}
        <p style="font-size:13px;color:#71717a;">Your driver may contact you before pickup. For help, call {{supportPhone}}.</p>`,
    }),
  },

  [NotificationEvents.DRIVER_CHANGED]: {
    subject: "Driver Updated for {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Driver Has Been Updated",
      preheader: "Your assigned driver has changed.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, the driver for your trip has been updated. Please find the new driver details below.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("New Driver", "{{driver}}") +
            detailRow("Vehicle", "{{vehicle}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Pickup", "{{pickup}}")
        )}
        <p style="font-size:13px;color:#71717a;">No action is needed from your side. Reach us at {{supportPhone}} with any questions.</p>`,
    }),
  },

  [NotificationEvents.INVOICE_GENERATED]: {
    subject: "Invoice {{invoiceNumber}} for {{bookingId}} — {{companyName}}",
    html: emailLayout({
      title: "Your Invoice is Ready",
      preheader: "Your invoice has been generated.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, your invoice has been generated for your booking with {{companyName}}. A summary is below.</p>
        ${detailTable(
          detailRow("Invoice No.", "{{invoiceNumber}}") +
            detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Amount", "₹{{paymentAmount}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">The full invoice is attached where supported. You can also view it at {{websiteUrl}}.</p>`,
    }),
  },

  [NotificationEvents.CUSTOMER_REGISTERED]: {
    subject: "Welcome to {{companyName}}, {{customerName}}!",
    html: emailLayout({
      title: "Welcome to {{companyName}}",
      preheader: "Your account is ready.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, welcome aboard! Your {{companyName}} account has been created successfully. We're delighted to have you with us.</p>
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">You can now book trips, track your journeys, and manage payments — all in one place.</p>
        <p style="font-size:13px;color:#71717a;">Get started at {{websiteUrl}}. Questions? Reach us at {{supportEmail}} or {{supportPhone}}.</p>`,
    }),
  },

  // NOTE: OTP_REQUESTED and PASSWORD_RESET reference {{otp}} and {{resetLink}},
  // which are NOT part of defaultContext. The workflow context builder for these
  // auth flows MUST supply `otp` (OTP_REQUESTED) and `resetLink` (PASSWORD_RESET)
  // in the template context when those flows are wired up.
  [NotificationEvents.OTP_REQUESTED]: {
    subject: "Your {{companyName}} verification code",
    html: emailLayout({
      title: "Your Verification Code",
      preheader: "Use this code to verify your account.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, use the verification code below to continue. This code is valid for a short time and should not be shared with anyone.</p>
        <div style="margin:20px 0;text-align:center;">
          <span style="display:inline-block;padding:14px 28px;font-size:28px;font-weight:700;letter-spacing:6px;color:#d4af37;background:#0f0f12;border-radius:12px;">{{otp}}</span>
        </div>
        <p style="font-size:13px;color:#71717a;">If you didn't request this, please ignore this email or contact {{supportEmail}}.</p>`,
    }),
  },

  [NotificationEvents.PASSWORD_RESET]: {
    subject: "Reset your {{companyName}} password",
    html: emailLayout({
      title: "Reset Your Password",
      preheader: "Reset your account password.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, we received a request to reset your {{companyName}} password. Click the button below to choose a new one.</p>
        <div style="margin:24px 0;text-align:center;">
          <a href="{{resetLink}}" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:600;color:#0f0f12;background:#d4af37;border-radius:10px;text-decoration:none;">Reset Password</a>
        </div>
        <p style="font-size:13px;color:#71717a;">This link will expire soon for your security. If you didn't request a reset, you can safely ignore this email or contact {{supportEmail}}.</p>`,
    }),
  },

  // ---- Internal ADMIN alerts (sent to the business's own inbox, not the
  // customer). The template context is the customer's booking details so staff
  // can act. Rendered from the ADMIN POV, paired with the WhatsApp admin alert.
  [NotificationEvents.ADMIN_BOOKING_UNPAID]: (ctx) => ({
    subject: "🆕 New booking (UNPAID) {{bookingId}} — action needed",
    html: emailLayout({
      title: "New Booking — Payment to Collect",
      preheader: "A new booking needs manual confirmation and payment.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">A new booking has been placed <strong>without an online payment</strong>. Please contact the customer to confirm the trip and collect payment.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Customer", "{{customerName}}") +
            detailRow("Phone", "{{customerPhone}}") +
            row(has(ctx.packageName), "Package", "{{packageName}}") +
            detailRow(has(ctx.packageName) ? "Vehicle Preference" : "Service / Vehicle", "{{vehicle}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            row(has(ctx.pickup), "Pickup", "{{pickup}}") +
            row(has(ctx.drop), "Drop", "{{drop}}") +
            row(has(ctx.passengers), "Passengers", "{{passengers}}") +
            row(has(ctx.pickupTime), "Pickup Time", "{{pickupTime}}") +
            row(has(ctx.specialRequests), "Special Requests", "{{specialRequests}}") +
            detailRow("Fare to Collect", "₹{{paymentAmount}}")
        )}
        <p style="font-size:13px;color:#71717a;">☎️ Call the customer at {{customerPhone}} to confirm and arrange payment.</p>`,
    }),
  }),

  [NotificationEvents.ADMIN_BOOKING_CANCELLED]: (ctx) => ({
    subject: "❌ Booking CANCELLED {{bookingId}} — {{customerName}}",
    html: emailLayout({
      title: "Booking Cancelled",
      preheader: "A booking has been cancelled — free the vehicle / handle any refund.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">A booking has been <strong>cancelled</strong>. The held vehicle unit is now free again. If any payment was collected, process the refund separately.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Customer", "{{customerName}}") +
            detailRow("Phone", "{{customerPhone}}") +
            row(has(ctx.packageName), "Package", "{{packageName}}") +
            detailRow(has(ctx.packageName) ? "Vehicle Preference" : "Service / Vehicle", "{{vehicle}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            row(has(ctx.pickup), "Pickup", "{{pickup}}") +
            row(has(ctx.drop), "Drop", "{{drop}}") +
            detailRow("Fare", "₹{{paymentAmount}}")
        )}
        <p style="font-size:13px;color:#71717a;">☎️ Reach the customer at {{customerPhone}} if you need to follow up.</p>`,
    }),
  }),

  [NotificationEvents.ADMIN_BOOKING_MODIFIED]: (ctx) => ({
    subject: "✏️ Booking MODIFIED {{bookingId}} — {{customerName}}",
    html: emailLayout({
      title: "Booking Modified",
      preheader: "A customer changed their booking — re-check the schedule.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">A customer has <strong>modified their booking</strong> from My Bookings. The updated trip details are below — re-check the vehicle schedule and driver assignment.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Customer", "{{customerName}}") +
            detailRow("Phone", "{{customerPhone}}") +
            row(has(ctx.packageName), "Package", "{{packageName}}") +
            detailRow(has(ctx.packageName) ? "Vehicle Preference" : "Service / Vehicle", "{{vehicle}}") +
            detailRow("New Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            row(has(ctx.pickup), "Pickup", "{{pickup}}") +
            row(has(ctx.drop), "Drop", "{{drop}}") +
            row(has(ctx.passengers), "Passengers", "{{passengers}}") +
            row(has(ctx.pickupTime), "Pickup Time", "{{pickupTime}}") +
            row(has(ctx.specialRequests), "Special Requests", "{{specialRequests}}") +
            detailRow("Fare", "₹{{paymentAmount}}")
        )}
        <p style="font-size:13px;color:#71717a;">☎️ Reach the customer at {{customerPhone}} if the new schedule needs discussion.</p>`,
    }),
  }),

  [NotificationEvents.ADMIN_BOOKING_PAID]: (ctx) => ({
    subject: "💰 New PAID booking {{bookingId}} — trip confirmed",
    html: emailLayout({
      title: "New Paid Booking",
      preheader: "Payment received online — a new trip is confirmed.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">A new booking has been <strong>paid online</strong> and is confirmed. Details for scheduling and driver assignment are below.</p>
        ${detailTable(
          detailRow("Booking ID", "{{bookingId}}") +
            detailRow("Customer", "{{customerName}}") +
            detailRow("Phone", "{{customerPhone}}") +
            row(has(ctx.packageName), "Package", "{{packageName}}") +
            detailRow(has(ctx.packageName) ? "Vehicle Preference" : "Service / Vehicle", "{{vehicle}}") +
            detailRow("Trip Dates", "{{tripDate}}") +
            detailRow("Trip Type", "{{tripType}}") +
            row(has(ctx.pickup), "Pickup", "{{pickup}}") +
            row(has(ctx.drop), "Drop", "{{drop}}") +
            row(has(ctx.passengers), "Passengers", "{{passengers}}") +
            row(has(ctx.pickupTime), "Pickup Time", "{{pickupTime}}") +
            row(has(ctx.specialRequests), "Special Requests", "{{specialRequests}}") +
            detailRow("Amount Paid", "₹{{paymentAmount}}") +
            detailRow("Invoice No.", "{{invoiceNumber}}") +
            detailRow("Status", "{{paymentStatus}}")
        )}
        <p style="font-size:13px;color:#71717a;">Assign a driver and schedule the trip from the admin dashboard.</p>`,
    }),
  }),

  // ---- Website "Contact Us" enquiry ----
  // To the business inbox: the full enquiry so staff can respond.
  [NotificationEvents.CONTACT_ENQUIRY]: {
    subject: "📩 New enquiry: {{subject}} — from {{enquiryName}}",
    html: emailLayout({
      title: "New Website Enquiry",
      preheader: "A visitor submitted the Contact Us form.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">A new enquiry was submitted through the {{companyName}} website. Details are below — reply directly to the customer's email to respond.</p>
        ${detailTable(
          detailRow("Name", "{{enquiryName}}") +
            detailRow("Email", "{{enquiryEmail}}") +
            detailRow("Phone", "{{enquiryPhone}}") +
            detailRow("Subject", "{{subject}}")
        )}
        <p style="font-size:13px;color:#71717a;margin-bottom:6px;">Message:</p>
        <div style="font-size:14px;line-height:1.6;color:#18181b;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:14px 16px;white-space:pre-wrap;">{{message}}</div>`,
    }),
  },

  // Acknowledgement back to the person who wrote in.
  [NotificationEvents.CONTACT_ACK]: {
    subject: "We received your message — {{companyName}}",
    html: emailLayout({
      title: "Thanks for reaching out",
      preheader: "We've received your enquiry and will be in touch soon.",
      content: `
        <p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, thank you for contacting {{companyName}}. We've received your enquiry and our team will get back to you shortly — typically within a few hours.</p>
        ${detailTable(detailRow("Subject", "{{subject}}"))}
        <p style="font-size:13px;color:#71717a;margin-bottom:6px;">Your message:</p>
        <div style="font-size:14px;line-height:1.6;color:#18181b;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:14px 16px;white-space:pre-wrap;">{{message}}</div>
        <p style="font-size:13px;color:#71717a;margin-top:16px;">For anything urgent, call us at {{supportPhone}}.</p>`,
    }),
  },

  // Safe fallback for any event without a dedicated template (extension point).
  generic: {
    subject: "Update on your {{companyName}} request",
    html: emailLayout({
      title: "Notification",
      content: `<p style="font-size:14px;line-height:1.6;color:#3f3f46;">Hi {{customerName}}, there's an update regarding {{bookingId}}. Contact {{supportPhone}} for details.</p>`,
    }),
  },
};

export default emailTemplates;
