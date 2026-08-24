/** Consent must be attachable to a number, and must not hijack an existing one. */
process.env.DATA_DIR ||= (await import("url")).fileURLToPath(new URL("../.tmp-cp/", import.meta.url));
const { rmSync } = await import("fs");
rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const us = await import("../src/auth/core/userService.js");
const { readDb, writeDb } = await import("../src/utils/db.js");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };

const seed = (u) => { const db = readDb(); db.users.push(u); writeDb(db); };
seed({ name: "NoPhone", email: "a@x.com", role: "customer", phone: "" });
seed({ name: "HasPhone", email: "b@x.com", role: "customer", phone: "6380422961" });

console.log("\n1. attaching a number where there is none");
us.attachPhoneIfMissing("a@x.com", "+91 91234 56780");
check("stores it normalised", us.findByEmail("a@x.com").phone === "9123456780", us.findByEmail("a@x.com").phone);

console.log("\n2. never repoints an existing number");
us.attachPhoneIfMissing("b@x.com", "9000000000");
check("existing number untouched", us.findByEmail("b@x.com").phone === "6380422961", us.findByEmail("b@x.com").phone);

console.log("\n3. rubbish is rejected, not stored");
seed({ name: "Junk", email: "c@x.com", role: "customer", phone: "" });
check("returns null", us.attachPhoneIfMissing("c@x.com", "12345") === null);
check("leaves the record empty", !us.findByEmail("c@x.com").phone);

console.log("\n4. consent records its evidence");
us.setMarketingConsent("a@x.com", true, { source: "account-settings", ip: "1.2.3.4" });
const u = us.findByEmail("a@x.com");
check("opt-in set", u.marketingOptIn === true);
check("suppression cleared", u.marketingOptOut === false);
check("timestamped", !!u.marketingConsentAt);
check("source recorded", u.marketingConsentSource === "account-settings");
check("ip recorded", u.marketingConsentIp === "1.2.3.4");

console.log("\n5. withdrawal silences both channels");
us.setMarketingConsent("a@x.com", false, { source: "account-settings" });
const w = us.findByEmail("a@x.com");
check("opt-in cleared", w.marketingOptIn === false);
check("also suppresses email", w.marketingOptOut === true);

console.log("\n6. an opted-in user with a number now exports");
us.setMarketingConsent("b@x.com", true, { source: "account-settings" });
const { consentRows } = await import("../src/notifications/broadcast/consentExport.js");
const rows = consentRows(undefined, { brand: "B" });
check("exactly one exportable row", rows.length === 1, String(rows.length));
check("it is the one with a phone", rows[0].phone === "6380422961", rows[0].phone);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
