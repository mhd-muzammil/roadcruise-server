// Booking pricing — the SINGLE source of truth for every amount a customer is
// quoted, charged, notified about or invoiced for.
//
// The results page asks POST /api/bookings/quote for its prices, the booking
// controller re-prices with the same functions when the booking is created,
// and the stored `pricing` breakdown is what My Bookings, the admin log,
// notifications and the invoice render. The browser never supplies an amount
// that ends up being charged.
//
// All rates come from the admin-managed vehicle record ({ outstationRate,
// driverBata, localPricing }) or the admin-managed package price — there is no
// second rate table. The trip-billing conventions below are the rules the
// client fare engine used before this moved server-side, unchanged.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// GST applied on top of every booking subtotal. Configurable for a future
// rate change; 5% is the passenger-transport / tour-operator rate in use.
export const GST_RATE_PERCENT = (() => {
  const n = Number(process.env.GST_RATE_PERCENT);
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();

export const TRIP_TYPES = Object.freeze({
  airport: "Airport Transfer",
  oneway: "Outstation One-Way",
  roundtrip: "Outstation Round-Trip",
  hourly: "Hourly Rental",
});

// Hourly packages. `priceKey` is the vehicle localPricing field that prices it,
// so a vehicle without that price simply isn't offered the package.
export const HOURLY_PACKAGES = Object.freeze([
  { key: "4h40", label: "4 hrs 40 kms", hours: 4, kms: 40, priceKey: "fourHours" },
  { key: "8h80", label: "8 hrs 80 kms", hours: 8, kms: 80, priceKey: "eightHours" },
  { key: "12h120", label: "12 hrs 120 kms", hours: 12, kms: 120, priceKey: "twelveHours" },
]);
export const hourlyPackageByKey = (key) => HOURLY_PACKAGES.find((p) => p.key === key) || null;

export const FARE_RULES = Object.freeze({
  airportMinKm: 30, // airport transfers bill at least this many km
  onewayMinKm: 130, // one-way OUTSTATION trips bill at least this many km
  roundtripMinKmPerDay: 250, // OUTSTATION round trips bill at least this many km per day
  // At/below this one-way distance a trip is a LOCAL drop, not an outstation
  // run — the outstation minimums must NOT apply.
  localTripKm: 50,
  freeWaitingMins: 30,
});

// Stops are supported on the outstation trip types only (an airport transfer
// is point-to-point, an hourly rental has no fixed route).
export const STOP_TRIP_TYPES = Object.freeze(["oneway", "roundtrip"]);
export const MAX_STOPS = 5;

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const km = (n) => `${Number(n || 0).toLocaleString("en-IN")} km`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Whole days a round trip spans (same-day return = 1). */
export function tripDays(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00`);
  const b = Date.parse(`${toDate || fromDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/** Subtotal -> { subtotal, gstRate, gstAmount, total }, rounded to paise. */
export function applyGst(subtotal) {
  const base = round2(subtotal);
  const gstAmount = round2((base * GST_RATE_PERCENT) / 100);
  return { subtotal: base, gstRate: GST_RATE_PERCENT, gstAmount, total: round2(base + gstAmount) };
}

/** Assemble the stored breakdown from charge lines. */
function finalize(source, lines, extra = {}) {
  const clean = lines.filter((l) => Number(l.amount) > 0).map((l) => ({ ...l, amount: round2(l.amount) }));
  const sum = clean.reduce((s, l) => s + l.amount, 0);
  return { source, lines: clean, ...applyGst(sum), ...extra };
}

/**
 * Price one vehicle for a trip-planner search. Returns null when the vehicle
 * can't serve this trip type (e.g. no hourly package price configured).
 *
 * trip: { type, distanceKm?, days?, pkg? }
 * Returns { pricing, included, excluded, rental }
 */
export function quoteVehicleTrip(vehicle, trip) {
  const perKm = Number(vehicle?.outstationRate) || 0;
  const bata = Number(vehicle?.driverBata) || 0;
  const local = vehicle?.localPricing || {};
  const type = trip?.type;

  if (type === "hourly") {
    const pkg = hourlyPackageByKey(trip?.pkg);
    if (!pkg) return null;
    const price = Number(local[pkg.priceKey]) || 0;
    if (price <= 0) return null;
    const extraKm = Number(local.extraKm) || 0;
    const extraHr = Number(local.extraHr) || 0;
    return {
      rental: { key: pkg.key, label: pkg.label, hours: pkg.hours, kms: pkg.kms },
      pricing: finalize("trip", [
        { key: "hourly", label: "Hourly rental", detail: `${plural(pkg.hours, "hour")} · ${pkg.kms} km package`, amount: price },
      ], { billKm: pkg.kms, perKm, days: 1 }),
      included: [
        `${pkg.hours} hours & ${pkg.kms} km included`,
        "Driver allowance",
        "Fuel & vehicle charges",
      ],
      excluded: [
        "Road tolls & parking, if any",
        extraKm ? `Extra km @ ₹${extraKm}/km` : "Extra km charged as per tariff",
        extraHr ? `Extra hour @ ₹${extraHr}/hr` : "Extra hours charged as per tariff",
      ],
    };
  }

  if (perKm <= 0) return null;
  const distanceKm = Math.max(1, Math.round(Number(trip?.distanceKm) || 0));

  const distanceLine = (billKm, floorNote) => ({
    key: "distance",
    label: "Vehicle charges",
    detail: `${km(billKm)} × ₹${perKm}/km${billKm > distanceKm && floorNote ? ` (${floorNote})` : ""}`,
    amount: billKm * perKm,
  });

  if (type === "airport") {
    const billKm = Math.max(distanceKm, FARE_RULES.airportMinKm);
    return {
      rental: null,
      pricing: finalize("trip", [distanceLine(billKm, `minimum ${FARE_RULES.airportMinKm} km`)], { billKm, perKm, days: 1 }),
      included: [
        `${billKm} km included`,
        "Driver allowance",
        `${FARE_RULES.freeWaitingMins} mins free waiting from trip start`,
      ],
      excluded: [
        "Airport entry, tolls & parking, if any",
        `Travel beyond ${billKm} km @ ₹${perKm}/km`,
        `Waiting beyond ${FARE_RULES.freeWaitingMins} mins, as per tariff`,
      ],
    };
  }

  if (type === "oneway") {
    // Short trips bill actual km (min 30, no outstation bata); the 130 km
    // floor + bata apply only beyond localTripKm.
    const isLocal = distanceKm <= FARE_RULES.localTripKm;
    const minKm = isLocal ? FARE_RULES.airportMinKm : FARE_RULES.onewayMinKm;
    const billKm = Math.max(distanceKm, minKm);
    const lines = [distanceLine(billKm, `minimum ${minKm} km`)];
    if (!isLocal && bata) lines.push({ key: "bata", label: "Driver bata", detail: `${inr(bata)} × 1 day`, amount: bata });
    return {
      rental: null,
      pricing: finalize("trip", lines, { billKm, perKm, days: 1 }),
      included: [
        `${billKm} km included`,
        isLocal || !bata ? "Driver allowance" : `Driver bata ${inr(bata)}`,
        "One-way drop — pay only for this direction",
      ],
      excluded: [
        "Road tolls, parking & interstate permits, if any",
        `Travel beyond ${billKm} km @ ₹${perKm}/km`,
        "Night driving allowance (11 PM – 5 AM), if applicable",
      ],
    };
  }

  if (type === "roundtrip") {
    const days = Math.max(1, Math.round(Number(trip?.days) || 1));
    // A same-day return within localTripKm is a local up-down: both directions
    // at actual km (min 30 each way) instead of the 250 km/day floor. Driver
    // bata still applies: the driver waits and drives back.
    const isLocal = days === 1 && distanceKm <= FARE_RULES.localTripKm;
    const minKm = isLocal ? FARE_RULES.airportMinKm * 2 : FARE_RULES.roundtripMinKmPerDay * days;
    // Up and down: the one-way route is driven twice (Chennai → Kanyakumari
    // 670 km = 1,340 km round trip). Shown explicitly so the customer can see
    // why a round trip is billed for double the one-way distance.
    const roundTripKm = distanceKm * 2;
    const billKm = Math.max(roundTripKm, minKm);
    const upDown = `${km(distanceKm)} up + ${km(distanceKm)} down = ${km(roundTripKm)}`;
    const floorNote = isLocal
      ? `minimum ${km(minKm)} billed`
      : `minimum ${FARE_RULES.roundtripMinKmPerDay} km/day × ${plural(days, "day")} = ${km(minKm)} billed`;
    const lines = [
      {
        key: "distance",
        label: "Vehicle charges (up & down)",
        detail: billKm > roundTripKm
          ? `${upDown}; ${floorNote} × ₹${perKm}/km`
          : `${upDown} × ₹${perKm}/km`,
        amount: billKm * perKm,
      },
    ];
    if (bata) {
      lines.push({ key: "bata", label: "Driver bata (per day)", detail: `${inr(bata)} × ${plural(days, "day")}`, amount: bata * days });
    }
    return {
      rental: null,
      pricing: finalize("trip", lines, { billKm, perKm, days, oneWayKm: distanceKm, roundTripKm }),
      included: [
        `${km(billKm)} included — ${km(distanceKm)} up & ${km(distanceKm)} down (${plural(days, "day")})`,
        bata ? `Driver bata ${inr(bata)}/day × ${days}` : "Driver allowance",
        "Vehicle at your disposal for the entire trip",
      ],
      excluded: [
        "Road tolls, parking & interstate permits, if any",
        `Travel beyond ${km(billKm)} @ ₹${perKm}/km`,
        ...(isLocal ? [] : [`Minimum billing ${FARE_RULES.roundtripMinKmPerDay} km/day`]),
      ],
    };
  }

  return null;
}

/** Positive rupee amount out of a display price like "4,999". */
export const parsePrice = (p) => {
  const n = Number(String(p ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
};

/** An admin-managed tour package, priced from its listed price. */
export function quotePackage(pkg) {
  const price = parsePrice(pkg?.price);
  if (!price) return null;
  return {
    pricing: finalize("package", [
      { key: "package", label: "Tour package", detail: [pkg.name, pkg.duration].filter(Boolean).join(" · "), amount: price },
    ]),
    included: Array.isArray(pkg.inclusions) ? pkg.inclusions : [],
    excluded: Array.isArray(pkg.exclusions) ? pkg.exclusions : [],
  };
}

/**
 * The fleet-card / enquiry booking form quotes a vehicle at its 8 hrs / 80 km
 * local package rate as an indicative fare (the team confirms the final one).
 */
export function quoteVehicleIndicative(vehicle) {
  const q = quoteVehicleTrip(vehicle, { type: "hourly", pkg: "8h80" });
  if (!q) return null;
  return {
    ...q,
    rental: null,
    pricing: {
      ...q.pricing,
      source: "indicative",
      lines: q.pricing.lines.map((l) => ({ ...l, label: "Vehicle charges (indicative)", detail: `8 hrs · 80 km local package rate` })),
    },
  };
}

/**
 * A booking the server has no rate for (a general enquiry with no vehicle, or a
 * package from the offline fallback list): the client's estimate is recorded as
 * an estimate only. The booking controller never charges these online.
 */
export function quoteEstimate(amount, label = "Estimated fare") {
  return { pricing: finalize("estimate", [{ key: "estimate", label, detail: "To be confirmed by our team", amount }]), included: [], excluded: [] };
}

/**
 * Post-trip charges for a finished ride: the km actually driven beyond what
 * the booking included, plus anything else the trip ran up. Feeds the final
 * (post-trip) invoice; the booking's original `pricing` is never rewritten.
 *
 *   includedKm   km covered by the booked fare
 *   actualKm     odometer km the trip really took
 *   extraKmRate  ₹/km for the excess
 *   otherAmount  extra hours / night allowance etc. (GST applies)
 *   tolls        tolls & parking at actuals (passed through, no GST)
 *
 * Returns the stored `tripClosure` shape (minus who/when).
 */
export function quoteTripClosure({ includedKm, actualKm, extraKmRate, otherAmount = 0, otherLabel = "", tolls = 0 }) {
  const inc = Math.max(0, Math.round(Number(includedKm) || 0));
  const act = Math.max(0, Math.round(Number(actualKm) || 0));
  const rate = Math.max(0, round2(Number(extraKmRate) || 0));
  const extraKm = Math.max(0, act - inc);
  const other = Math.max(0, round2(Number(otherAmount) || 0));
  const tollAmt = Math.max(0, round2(Number(tolls) || 0));

  const taxable = [
    { key: "extraKm", label: "Extra km", detail: `${km(extraKm)} beyond ${km(inc)} × ₹${rate}/km`, amount: extraKm * rate },
    { key: "other", label: String(otherLabel || "").trim() || "Additional charges", detail: "", amount: other },
  ];
  const { lines, subtotal, gstRate, gstAmount, total } = finalize("closure", taxable);
  const tollLine = tollAmt > 0
    ? [{ key: "tolls", label: "Tolls & parking", detail: "At actuals (no GST)", amount: tollAmt }]
    : [];
  return {
    includedKm: inc,
    actualKm: act,
    extraKm,
    extraKmRate: rate,
    lines: [...lines, ...tollLine],
    subtotal,
    gstRate,
    gstAmount,
    tolls: tollAmt,
    total: round2(total + tollAmt),
  };
}

export default {
  GST_RATE_PERCENT, TRIP_TYPES, HOURLY_PACKAGES, FARE_RULES, STOP_TRIP_TYPES, MAX_STOPS,
  tripDays, applyGst, quoteVehicleTrip, quotePackage, quoteVehicleIndicative, quoteEstimate, parsePrice,
  hourlyPackageByKey, quoteTripClosure,
};
