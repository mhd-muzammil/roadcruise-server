/**
 * Offer announcement: context building, emission and the SMS fail-safe.
 * Audience/consent rules live in `npm run consent:check` — kept separate so the
 * two do not drift apart restating each other. No SMS, no email.
 */
const { offerContext, announceOffer } = await import("../src/notifications/broadcast/offerBroadcast.js");
const { msg91TemplateStatus } = await import("../src/notifications/config/msg91Templates.js");
const { NotificationEvents } = await import("../src/notifications/config/events.js");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };

console.log("\n1. price is digits only (the DLT template supplies 'Rs' itself)");
check("strips currency and commas", offerContext({ price: "Rs 6,999" }).offerPrice === "6999", offerContext({ price: "Rs 6,999" }).offerPrice);
check("handles a bare number", offerContext({ price: "2500" }).offerPrice === "2500");
check("empty stays empty", offerContext({}).offerPrice === "");
check("falls back to a title", offerContext({}).offerTitle === "New package");

console.log("\n2. one event per reachable recipient, keyed to the promo");
const users = [
  { name: "Both",     role: "customer", phone: "6380422961", email: "a@x.com", marketingOptIn: true },
  { name: "MailOnly", role: "customer", phone: "9123456780", email: "b@x.com" },              // no SMS consent
  { name: "Silent",   role: "customer", phone: "9111111111", email: "c@x.com", marketingOptOut: true },
];
const seen = [];
const r = announceOffer({
  promo: { id: "P1", title: "Kodai", price: "Rs 6,999", duration: "3D 4N" },
  notify: (e, p) => seen.push({ e, id: p.id, phone: p.phone, email: p.email }),
  users,
});
check("audience counted", r.audience === 2, String(r.audience));
check("one emit per audience member", seen.length === 2, String(seen.length));
check("uses the offer event", seen.every((s) => s.e === NotificationEvents.OFFER_ANNOUNCED));
check("businessKey is the promo id (dedupes re-announce)", seen.every((s) => s.id === "P1"));
check("consented user carries a phone", seen.some((s) => s.phone === "6380422961"));
check("non-consented user carries email but NO phone", seen.some((s) => s.email === "b@x.com" && s.phone === null));
check("suppressed user emitted nothing", !seen.some((s) => s.email === "c@x.com"));

console.log("\n3. SMS fails safe until the DLT template is registered");
const t = msg91TemplateStatus().find((x) => x.event === NotificationEvents.OFFER_ANNOUNCED);
check("offer template known to the mapping", !!t);
check("NOT configured => dead-letters, never sends unapproved text", t && !t.configured, String(t && t.templateId));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
