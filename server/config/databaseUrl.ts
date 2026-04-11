export type DatabaseProviderKey = "supabase" | "postgres";

export interface DatabaseProviderInfo {
  key: DatabaseProviderKey;
  host: string | null;
  isExternal: boolean;
  label: string;
  description: string;
}

function isLocalDatabaseHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isKnownSelfSignedPoolerHost(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname.endsWith('.pooler.supabase.com');
  } catch {
    return false;
  }
}

export function getDatabaseProviderInfo(databaseUrl?: string | null): DatabaseProviderInfo {
  if (!databaseUrl) {
    return {
      key: "postgres",
      host: null,
      isExternal: false,
      label: "PostgreSQL",
      description: "資料庫連線由伺服器端 DATABASE_URL 管理。",
    };
  }

  try {
    const parsedUrl = new URL(databaseUrl);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (hostname.endsWith(".supabase.com")) {
      return {
        key: "supabase",
        host: hostname,
        isExternal: true,
        label: "外部 PostgreSQL（Supabase）",
        description:
          "資料目前儲存在外部 Supabase PostgreSQL。Zeabur 只負責執行應用程式，不會把正式資料跟容器生命週期綁在一起。",
      };
    }

    const isExternal = !isLocalDatabaseHost(hostname);

    return {
      key: "postgres",
      host: hostname,
      isExternal,
      label: isExternal ? "外部 PostgreSQL" : "本機 PostgreSQL",
      description: isExternal
        ? "資料目前儲存在外部 PostgreSQL，由伺服器端 DATABASE_URL 指向。"
        : "資料目前儲存在本機 PostgreSQL，與目前應用部署環境綁定。",
    };
  } catch {
    return {
      key: "postgres",
      host: null,
      isExternal: false,
      label: "PostgreSQL",
      description: "資料庫連線由伺服器端 DATABASE_URL 管理。",
    };
  }
}

export function shouldDisablePreparedStatements(databaseUrl: string): boolean {
  try {
    const parsedUrl = new URL(databaseUrl);

    return (
      parsedUrl.hostname.endsWith(".pooler.supabase.com") &&
      parsedUrl.port === "6543"
    );
  } catch {
    return false;
  }
}
