/** Offer-announcement audience + fail-safe. No SMS, no email. */
const { offerAudience, offerContext, announceOffer } =
  await import("../src/notifications/broadcast/offerBroadcast.js");
const { msg91TemplateStatus } = await import("../src/notifications/config/msg91Templates.js");
const { NotificationEvents } = await import("../src/notifications/config/events.js");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };

const users = [
  { name: "Real",      role: "customer", phone: "6380422961", email: "a@x.com" },
  { name: "PhoneOnly", role: "customer", phone: "9123456780", email: "9123456780@phone.invalid", emailPlaceholder: true },
  { name: "OptedOut",  role: "customer", phone: "9999999999", email: "b@x.com", marketingOptOut: true },
  { name: "TheAdmin",  role: "admin",    phone: "7777777777", email: "info@roadcruise.in" },
  { name: "NoContact", role: "customer", phone: "", email: "" },
  { name: "EmailOnly", role: "customer", phone: "", email: "c@x.com" },
];

console.log("\n1. who receives an offer");
const aud = offerAudience(users);
const names = aud.map((a) => a.name);
check("includes a normal customer", names.includes("Real"), names.join(","));
check("includes a phone-only customer", names.includes("PhoneOnly"));
check("includes an email-only customer", names.includes("EmailOnly"));
check("EXCLUDES opted-out", !names.includes("OptedOut"));
check("EXCLUDES admin/staff", !names.includes("TheAdmin"));
check("EXCLUDES contactless", !names.includes("NoContact"));

console.log("\n2. placeholder emails are never mailed");
const phoneOnly = aud.find((a) => a.name === "PhoneOnly");
check("phone-login address nulled out", phoneOnly.email === null, String(phoneOnly.email));
check("but still reachable by SMS", phoneOnly.phone === "9123456780");

console.log("\n3. price is digits only (the template supplies 'Rs')");
check("strips currency and commas", offerContext({ price: "Rs 6,999" }).offerPrice === "6999", offerContext({ price: "Rs 6,999" }).offerPrice);
check("handles a bare number", offerContext({ price: "2500" }).offerPrice === "2500");
check("empty stays empty", offerContext({}).offerPrice === "");

console.log("\n4. one event per recipient, keyed to the promo");
const seen = [];
announceOffer({ promo: { id: "P1", title: "Kodai", price: "Rs 6,999", duration: "3D/4N" }, notify: (e, p) => seen.push({ e, id: p.id, to: p.phone || p.email }), users });
check("emits once per eligible customer", seen.length === aud.length, `${seen.length} vs ${aud.length}`);
check("uses the offer event", seen.every((s) => s.e === NotificationEvents.OFFER_ANNOUNCED));
check("businessKey is the promo id", seen.every((s) => s.id === "P1"));

console.log("\n5. SMS fails safe until the template is registered");
const t = msg91TemplateStatus().find((x) => x.event === NotificationEvents.OFFER_ANNOUNCED);
check("offer template is known to the mapping", !!t);
check("but NOT configured (no id) => dead-letters, never sends unapproved text", t && !t.configured, String(t && t.templateId));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
