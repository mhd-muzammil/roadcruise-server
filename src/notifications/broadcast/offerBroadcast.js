import { readDb } from "../../utils/db.js";
import { NotificationEvents } from "../config/events.js";
import { config as authConfig } from "../../auth/config/auth.config.js";

/**
 * Announce an offer package to existing customers.
 *
 * CATEGORY, AND WHY IT MATTERS: this is TRAI "service-explicit" traffic — an
 * offer to people who have already transacted with us — not cold marketing. That
 * distinction earns a lighter consent regime, but it does NOT exempt the message
 * from template registration: the operator matches the delivered body against
 * DLT-registered content and silently drops anything that does not match. So the
 * SMS half stays dark until MSG91_OFFER_TEMPLATE_ID is filled in, exactly like
 * BOOKING_CONFIRMATION. Email carries no such restriction and sends today.
 *
 * CONSENT IS PER CHANNEL, because the law is. SMS needs affirmative opt-in
 * user gates every channel. Regulatory consent for SMS specifically is a DLT-side
 * artifact that must exist before the template is even approved; this flag is how
 * a customer stops receiving them afterwards.
 *
 * ONE ANNOUNCEMENT PER CUSTOMER PER PROMO. The businessKey is the promo id, so
 * the engine's idempotency key (event + channel + recipient + promo) turns a
 * second click of "Notify customers" into a no-op rather than a second SMS. That
 * is the entire double-send defence — deliberately not a "sent" column.
 */

/** A synthetic phone-login address that must never receive mail. */
const isPlaceholderEmail = (u) =>
  u?.emailPlaceholder === true ||
  String(u?.email || "").endsWith(`@${authConfig.otpLogin.placeholderEmailDomain}`);

/**
 * Customers eligible for an offer announcement.
 *
 * Staff accounts are excluded: an admin does not want the blast, and including
 * them makes a test send look successful when it only reached the person who
 * pressed the button.
 */
export function offerAudience(users = readDb().users || []) {
  return users
    .filter((u) => String(u?.role || "customer").toLowerCase() === "customer")
    .map((u) => ({
      name: u.name,
      // SMS requires AFFIRMATIVE consent (TRAI service-explicit): an offer may
      // not be texted to someone who merely holds an account. Absent means no.
      phone: u.marketingOptIn === true ? String(u.phone || "").trim() || null : null,
      // Email rides the existing business relationship and ships unless the
      // customer opted out — the standard the law actually applies to it.
      // Placeholder phone-login addresses can never receive mail.
      email: u.marketingOptOut === true || isPlaceholderEmail(u) ? null : u.email || null,
    }))
    // A channel with no address is SKIPPED by the engine, so a customer who is
    // reachable on only one of the two still gets that one.
    .filter((r) => r.phone || r.email);
}

/** The context an offer message renders from. */
export function offerContext(promo = {}) {
  return {
    offerTitle: promo.title || "New package",
    // Digits only: the DLT-registered body supplies "Rs" itself, and a value of
    // "Rs 6,999" would render "Rs Rs 6,999" and no longer match the template.
    offerPrice: String(promo.price || "").replace(/[^\d]/g, ""),
    offerDuration: promo.duration || "",
    offerTagline: promo.tagline || "",
  };
}

/**
 * Emit one OFFER_ANNOUNCED per eligible customer.
 * @returns {{ promoId: string, audience: number }}
 */
export function announceOffer({ promo, notify, users } = {}) {
  if (!promo?.id) throw new Error("announceOffer requires a promo with an id");
  const audience = offerAudience(users);
  const ctx = offerContext(promo);

  for (const r of audience) {
    notify(
      NotificationEvents.OFFER_ANNOUNCED,
      { id: promo.id, promoId: promo.id, name: r.name, phone: r.phone, email: r.email, ...ctx },
      { actor: "offer-broadcast" }
    );
  }

  return { promoId: promo.id, audience: audience.length };
}

export default { announceOffer, offerAudience, offerContext };
