import { test } from "node:test";
import assert from "node:assert/strict";

import { hasPermission, roleAtLeast, permissionsFor, Roles } from "../rbac/roles.js";

// Pure RBAC matrix logic — no db writes.

test("roleAtLeast respects the hierarchy", () => {
  assert.equal(roleAtLeast(Roles.ADMIN, Roles.MANAGER), true, "admin outranks manager");
  assert.equal(roleAtLeast(Roles.CUSTOMER, Roles.ADMIN), false, "customer does not reach admin");
  assert.equal(roleAtLeast(Roles.ADMIN, Roles.ADMIN), true, "equal rank satisfies at-least");
});

test("hasPermission grants role-scoped permissions", () => {
  assert.equal(hasPermission(Roles.SUPER_ADMIN, "role:manage"), true, "super_admin can manage roles");
  assert.equal(hasPermission(Roles.CUSTOMER, "user:manage"), false, "customer cannot manage users");
});

test("permissionsFor includes lower-role permissions via hierarchy", () => {
  const adminPerms = permissionsFor(Roles.ADMIN);
  // admin (rank 80) inherits from manager/staff/... down the chain
  assert.ok(adminPerms.includes("user:manage"), "admin's own direct permission");
  assert.ok(adminPerms.includes("audit:read"), "inherited from manager");
  assert.ok(adminPerms.includes("booking:read"), "inherited from lowest roles");
  assert.ok(adminPerms.includes("booking:write"), "inherited from staff");
});
