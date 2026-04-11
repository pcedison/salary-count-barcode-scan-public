export enum AdminPermissionLevel {
  BASIC = 1,
  STANDARD = 2,
  ADMIN = 3,
  SUPER = 4,
}

export function resolvePermissionLevel(value: unknown): AdminPermissionLevel | null {
  if (typeof value !== "number") {
    return null;
  }

  if (!Object.values(AdminPermissionLevel).includes(value)) {
    return null;
  }

  return value as AdminPermissionLevel;
}

export function hasPermissionLevel(
  currentLevel: AdminPermissionLevel | null | undefined,
  requiredLevel: AdminPermissionLevel,
): boolean {
  return typeof currentLevel === "number" && currentLevel >= requiredLevel;
}
