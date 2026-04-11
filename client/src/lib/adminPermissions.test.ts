import { describe, expect, it } from "vitest";

import {
  AdminPermissionLevel,
  hasPermissionLevel,
  resolvePermissionLevel,
} from "./adminPermissions";

describe("adminPermissions", () => {
  it("resolves valid permission levels from server payloads", () => {
    expect(resolvePermissionLevel(AdminPermissionLevel.BASIC)).toBe(AdminPermissionLevel.BASIC);
    expect(resolvePermissionLevel(AdminPermissionLevel.SUPER)).toBe(AdminPermissionLevel.SUPER);
  });

  it("rejects invalid permission levels", () => {
    expect(resolvePermissionLevel(null)).toBeNull();
    expect(resolvePermissionLevel("4")).toBeNull();
    expect(resolvePermissionLevel(999)).toBeNull();
  });

  it("checks hierarchical permission access", () => {
    expect(hasPermissionLevel(AdminPermissionLevel.SUPER, AdminPermissionLevel.ADMIN)).toBe(true);
    expect(hasPermissionLevel(AdminPermissionLevel.ADMIN, AdminPermissionLevel.SUPER)).toBe(false);
    expect(hasPermissionLevel(null, AdminPermissionLevel.ADMIN)).toBe(false);
  });
});
