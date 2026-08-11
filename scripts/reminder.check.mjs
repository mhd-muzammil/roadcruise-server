/** Date/selection logic for trip reminders. No DB, no SMS. */
const { istParts, addDays, dueBookings, sweepTripReminders } =
  await import("../src/notifications/scheduler/tripReminders.js");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const at = (iso) => Date.parse(iso);

console.log("\n1. IST calendar, not UTC");
// 14 Aug 20:00 IST == 14 Aug 14:30 UTC
check("evening IST maps to the same IST day", istParts(at("2026-08-14T14:30:00Z")).date === "2026-08-14");
// 14 Aug 23:00 UTC is already 15 Aug 04:30 IST — the trap a UTC comparison falls into
check("late UTC evening is already the NEXT IST day", istParts(at("2026-08-14T23:00:00Z")).date === "2026-08-15",
  istParts(at("2026-08-14T23:00:00Z")).date);
check("IST hour is read in IST", istParts(at("2026-08-14T14:30:00Z")).hour === 20, String(istParts(at("2026-08-14T14:30:00Z")).hour));

console.log("\n2. lead-day arithmetic");
check("14 Aug + 1 = 15 Aug", addDays("2026-08-14", 1) === "2026-08-15");
check("crosses month end", addDays("2026-08-31", 1) === "2026-09-01");
check("crosses year end", addDays("2026-12-31", 1) === "2027-01-01");
check("leap day", addDays("2028-02-28", 1) === "2028-02-29");

console.log("\n3. who is due");
const bookings = [
  { id: "B1", fromDate: "2026-08-15", status: "Approved", phone: "6380422961" },
  { id: "B2", fromDate: "2026-08-15", status: "Cancelled", phone: "6380422961" },
  { id: "B3", fromDate: "2026-08-15", status: "Completed", phone: "6380422961" },
  { id: "B4", fromDate: "2026-08-15", status: "Pending", phone: "" },
  { id: "B5", fromDate: "2026-08-16", status: "Approved", phone: "6380422961" },
  { id: "B6", fromDate: "2026-08-15", status: "Pending", phone: "9123456780" },
];
const due = dueBookings("2026-08-15", bookings).map((b) => b.id);
check("includes Approved + Pending", due.includes("B1") && due.includes("B6"), due.join(","));
check("excludes Cancelled", !due.includes("B2"));
check("excludes Completed", !due.includes("B3"));
check("excludes no-phone", !due.includes("B4"));
check("excludes a different date", !due.includes("B5"));
check("exactly two due", due.length === 2, due.join(","));

console.log("\n4. the actual scenario: trip 15 Aug, reminded on the 14th");
const emitted = [];
const fakeNotify = (event, payload) => emitted.push({ event, id: payload.bookingId });
// sweep() reads the DB; exercise the pure path instead and assert the target date.
const r = sweepTripReminders({ now: at("2026-08-14T14:30:00Z"), notify: fakeNotify, leadDays: 1 });
check("targets 15 Aug when run on the evening of the 14th", r.targetDate === "2026-08-15", r.targetDate);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
