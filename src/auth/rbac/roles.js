/**
 * RBAC role + permission matrix. Roles are hierarchical by rank (higher rank
 * inherits lower-rank permissions). Extend by adding a role + its permissions;
 * middleware and future permission checks read from here.
 *
 * The existing app only used "admin" and "customer" — those remain valid and
 * map cleanly into this matrix (admin => ADMIN, customer => CUSTOMER), so no
 * existing user's role breaks.
 */
export const Roles = Object.freeze({
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  MANAGER: "manager",
  STAFF: "staff",
  DRIVER: "driver",
  CUSTOMER: "customer",
});

// Higher number = more privilege. Used for "at least this role" checks.
export const RoleRank = Object.freeze({
  [Roles.SUPER_ADMIN]: 100,
  [Roles.ADMIN]: 80,
  [Roles.MANAGER]: 60,
  [Roles.STAFF]: 40,
  [Roles.DRIVER]: 30,
  [Roles.CUSTOMER]: 10,
});

export const Permissions = Object.freeze({
  BOOKING_READ: "booking:read",
  BOOKING_WRITE: "booking:write",
  BOOKING_DELETE: "booking:delete",
  PAYMENT_READ: "payment:read",
  PAYMENT_REFUND: "payment:refund",
  USER_READ: "user:read",
  USER_MANAGE: "user:manage",
  ROLE_MANAGE: "role:manage",
  SESSION_MANAGE: "session:manage",
  NOTIFICATION_MANAGE: "notification:manage",
  AUDIT_READ: "audit:read",
  SELF_READ: "self:read",
  SELF_MANAGE: "self:manage",
});

const P = Permissions;

// Base permissions granted directly to each role (before hierarchy inheritance).
const DIRECT = {
  [Roles.CUSTOMER]: [P.SELF_READ, P.SELF_MANAGE, P.BOOKING_READ],
  [Roles.DRIVER]: [P.SELF_READ, P.SELF_MANAGE, P.BOOKING_READ],
  [Roles.STAFF]: [P.BOOKING_READ, P.BOOKING_WRITE, P.PAYMENT_READ, P.USER_READ],
  [Roles.MANAGER]: [P.BOOKING_DELETE, P.PAYMENT_REFUND, P.NOTIFICATION_MANAGE, P.AUDIT_READ],
  [Roles.ADMIN]: [P.USER_MANAGE, P.SESSION_MANAGE],
  [Roles.SUPER_ADMIN]: [P.ROLE_MANAGE],
};

// Build effective permission sets with hierarchy: a role inherits everything
// from all lower-ranked roles.
function buildMatrix() {
  const ordered = Object.values(Roles).sort((a, b) => RoleRank[a] - RoleRank[b]);
  const matrix = {};
  const acc = new Set();
  for (const role of ordered) {
    (DIRECT[role] || []).forEach((p) => acc.add(p));
    matrix[role] = new Set(acc); // snapshot of everything up to this rank
  }
  return matrix;
}
const MATRIX = buildMatrix();

export function normalizeRole(role) {
  const r = String(role || "").toLowerCase();
  return Object.values(Roles).includes(r) ? r : Roles.CUSTOMER;
}

export function hasPermission(role, permission) {
  const set = MATRIX[normalizeRole(role)];
  return !!set && set.has(permission);
}

export function roleAtLeast(role, minRole) {
  return RoleRank[normalizeRole(role)] >= (RoleRank[minRole] || 0);
}

export function permissionsFor(role) {
  return [...(MATRIX[normalizeRole(role)] || [])];
}

export default { Roles, RoleRank, Permissions, hasPermission, roleAtLeast, permissionsFor, normalizeRole };
