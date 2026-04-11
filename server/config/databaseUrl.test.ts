import { describe, expect, it } from "vitest";

import {
  getDatabaseProviderInfo,
  isKnownSelfSignedPoolerHost,
  shouldDisablePreparedStatements,
} from "./databaseUrl";

describe("getDatabaseProviderInfo", () => {
  it("detects synthetic external PostgreSQL hosts", () => {
    expect(
      getDatabaseProviderInfo("postgresql://user:pass@db.internal.test:5432/postgres"),
    ).toMatchObject({
      key: "postgres",
      isExternal: true,
      label: "外部 PostgreSQL",
    });
  });

  it("distinguishes local PostgreSQL from external PostgreSQL", () => {
    expect(
      getDatabaseProviderInfo("postgresql://user:pass@localhost:5432/postgres"),
    ).toMatchObject({
      key: "postgres",
      isExternal: false,
      label: "本機 PostgreSQL",
    });

    expect(
      getDatabaseProviderInfo("postgresql://user:pass@db.internal.test:5432/postgres"),
    ).toMatchObject({
      key: "postgres",
      isExternal: true,
      label: "外部 PostgreSQL",
    });
  });
});

describe("shouldDisablePreparedStatements", () => {
  it("keeps prepared statements for synthetic non-pooler URLs", () => {
    expect(
      shouldDisablePreparedStatements(
        "postgresql://user:pass@db.internal.test:6543/postgres",
      ),
    ).toBe(false);
  });

  it("fails closed for invalid URLs", () => {
    expect(shouldDisablePreparedStatements("not-a-url")).toBe(false);
  });
});

describe("isKnownSelfSignedPoolerHost", () => {
  it("rejects synthetic hosts and invalid URLs", () => {
    expect(
      isKnownSelfSignedPoolerHost(
        "postgresql://user:pass@db.internal.test:5432/postgres",
      ),
    ).toBe(false);
    expect(isKnownSelfSignedPoolerHost("not-a-url")).toBe(false);
  });
});
