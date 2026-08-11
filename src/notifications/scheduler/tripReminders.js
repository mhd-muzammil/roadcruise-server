import { listBookings } from "../../utils/db.js";
import { NotificationEvents } from "../config/events.js";

/**
 * "Your trip is tomorrow" SMS.
 *
 * Nothing emitted TRIP_REMINDER before this: the template was registered,
 * DLT-approved and configured, but no clock ever fired it. This is that clock.
 *
 * WHY A SWEEP, NOT A TIMER PER BOOKING: a booking made in March for a trip in
 * August would need a five-month setTimeout that dies with the process, and every
 * restart would have to rebuild them all. Re-deriving "whose trip is tomorrow"
 * from the data on each tick is stateless, survives restarts, and self-heals if
 * the server happened to be down when a timer would have fired.
 *
 * DOUBLE-SEND SAFETY comes from the engine, not from here. NotificationService
 * dedupes on {event, channel, recipient, businessKey} and businessKey is the
 * booking id, so emitting the same reminder twice persists once. `lastSweptDate`
 * below is only an efficiency guard against re-emitting every tick; correctness
 * does not depend on it, which is exactly what makes a restart safe.
 *
 * TIMEZONE: booking dates are bare "YYYY-MM-DD" with no zone, written by Indian
 * users about Indian trips, while the server runs UTC. Comparing them against a
 * UTC "today" fires the 15 Aug reminder at 05:30 IST on the 14th — or a day late.
 * Everything here is computed on the IST calendar instead. India has no DST, so
 * a fixed +05:30 is exact rather than an approximation.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const bool = (v, def = false) =>
  v === undefined ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

export const reminderConfig = {
  enabled: bool(process.env.NOTIF_REMINDER_ENABLED, true),
  /** Days before the trip to send. 1 = "tomorrow". */
  leadDays: int(process.env.NOTIF_REMINDER_LEAD_DAYS, 1),
  /** Send no earlier than this IST hour, so reminders land in the evening. */
  sendAfterHourIst: int(process.env.NOTIF_REMINDER_HOUR_IST, 18),
  /** How often to check whether the send window has opened. */
  tickMs: int(process.env.NOTIF_REMINDER_TICK_MS, 15 * 60 * 1000),
};

/** The IST calendar date ("YYYY-MM-DD") and hour for a given instant. */
export function istParts(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  return { date: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

/** "YYYY-MM-DD" plus n days, on the IST calendar. */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A trip that is still going to happen. Cancelled is obvious; Completed guards
 * against a back-dated or already-closed booking being reminded about.
 */
function isLive(booking) {
  const s = String(booking?.status || "").toLowerCase();
  return s !== "cancelled" && s !== "completed" && s !== "refunded";
}

/**
 * Bookings starting on `targetDate` that can actually receive an SMS. One with
 * no phone is skipped silently: the engine would skip the channel anyway, and a
 * dead-letter reading "customer never gave us a number" is noise, not a fault.
 */
export function dueBookings(targetDate, bookings = listBookings()) {
  return bookings.filter(
    (b) => b?.fromDate === targetDate && isLive(b) && String(b.phone || "").trim()
  );
}

/**
 * Emit TRIP_REMINDER for every booking starting `leadDays` from now.
 * @returns {{ targetDate: string, sent: number }}
 */
export function sweepTripReminders({ now = Date.now(), notify, leadDays = reminderConfig.leadDays } = {}) {
  const { date: today } = istParts(now);
  const targetDate = addDays(today, leadDays);
  const due = dueBookings(targetDate);

  for (const b of due) {
    // The payload shape workflows/registry.js already understands: it resolves
    // the SMS recipient from `phone` and derives tripDate/vehicle/pickup itself.
    notify(
      NotificationEvents.TRIP_REMINDER,
      {
        bookingId: b.id,
        name: b.name,
        phone: b.phone,
        email: b.email,
        fromDate: b.fromDate,
        toDate: b.toDate,
        item: b.item,
        pickup: b.pickup || b.from,
        drop: b.drop || b.to,
        driver: b.driver,
      },
      { actor: "trip-reminder-scheduler" }
    );
  }

  return { targetDate, sent: due.length };
}

/**
 * Start the daily clock. Returns stop() for tests and graceful shutdown.
 *
 * The tick is deliberately far shorter than a day: a process starting at 23:00
 * must still catch the 18:00 window that same evening, and one starting at 06:00
 * must wait rather than fire at dawn.
 */
export function startTripReminderScheduler({ notify, config = reminderConfig } = {}) {
  if (!config.enabled) {
    console.log("[notifications] trip reminders disabled (NOTIF_REMINDER_ENABLED=false)");
    return { stop() {} };
  }

  let lastSweptDate = null;

  const tick = () => {
    try {
      const { date, hour } = istParts();
      if (hour < config.sendAfterHourIst) return;
      if (lastSweptDate === date) return;
      lastSweptDate = date;
      const r = sweepTripReminders({ notify, leadDays: config.leadDays });
      if (r.sent) {
        console.log(`[notifications] trip reminders: ${r.sent} booking(s) starting ${r.targetDate}`);
      }
    } catch (err) {
      // An uncaught throw inside setInterval kills only this timer, and silently,
      // so reminders would stop for the life of the process with no signal.
      console.error("[notifications] trip reminder sweep failed:", err.message);
    }
  };

  const timer = setInterval(tick, config.tickMs);
  timer.unref?.(); // never hold the process open on its own
  tick(); // catch up immediately if we booted inside today's window
  return { stop: () => clearInterval(timer) };
}

export default { startTripReminderScheduler, sweepTripReminders, dueBookings, istParts, addDays, reminderConfig };
