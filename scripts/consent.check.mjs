/** Per-channel consent rules for offer announcements. No sends. */
const { offerAudience } = await import("../src/notifications/broadcast/offerBroadcast.js");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };
const find = (aud, n) => aud.find((a) => a.name === n);

const users = [
  { name: "OptedIn",    role: "customer", phone: "6380422961", email: "in@x.com",  marketingOptIn: true },
  { name: "NeverAsked", role: "customer", phone: "9123456780", email: "na@x.com" },
  { name: "OptedOut",   role: "customer", phone: "9111111111", email: "out@x.com", marketingOptIn: false, marketingOptOut: true },
  { name: "PhoneOnly",  role: "customer", phone: "9222222222", email: "9222222222@phone.invalid", emailPlaceholder: true, marketingOptIn: true },
  { name: "Staff",      role: "admin",    phone: "9333333333", email: "admin@x.com", marketingOptIn: true },
];
const aud = offerAudience(users);

console.log("\n1. SMS requires affirmative opt-in");
check("opted-in customer gets SMS", find(aud, "OptedIn")?.phone === "6380422961");
check("never-asked customer gets NO SMS", find(aud, "NeverAsked")?.phone === null, String(find(aud, "NeverAsked")?.phone));
check("opted-out gets no SMS", !find(aud, "OptedOut") || find(aud, "OptedOut").phone === null);

console.log("\n2. email rides the business relationship (opt-out, not opt-in)");
check("never-asked customer STILL gets email", find(aud, "NeverAsked")?.email === "na@x.com", String(find(aud, "NeverAsked")?.email));
check("opted-out customer is fully suppressed", !find(aud, "OptedOut"), JSON.stringify(find(aud, "OptedOut")));

console.log("\n3. unchanged guarantees");
check("placeholder address never mailed", find(aud, "PhoneOnly")?.email === null);
check("but opted-in phone user gets SMS", find(aud, "PhoneOnly")?.phone === "9222222222");
check("staff excluded entirely", !find(aud, "Staff"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
