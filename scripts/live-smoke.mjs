import fs from "fs";
import path from "path";

const DEFAULT_BASE_URL = "https://barcode-scan.zeabur.app";
const DEFAULT_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.BASE_URL || DEFAULT_BASE_URL,
    reportPath: process.env.SMOKE_REPORT_PATH || null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--base-url") {
      options.baseUrl = argv[index + 1] ?? options.baseUrl;
      index += 1;
      continue;
    }

    if (arg === "--report") {
      options.reportPath = argv[index + 1] ?? options.reportPath;
      index += 1;
    }
  }

  return options;
}

function sanitizeBaseUrl(baseUrl) {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function toTimestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureReportPath(reportPath) {
  if (reportPath) {
    return path.resolve(reportPath);
  }

  return path.resolve("tmp", `live-smoke-${toTimestampSlug()}.json`);
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function getCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  updateFromResponse(response) {
    for (const rawCookie of getCookieHeaders(response)) {
      const [pair] = rawCookie.split(";");
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      this.cookies.set(name, value);
    }
  }

  toHeader() {
    if (this.cookies.size === 0) {
      return null;
    }

    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function httpRequest(baseUrl, requestPath, options = {}, cookieJar = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const headers = new Headers(options.headers ?? {});
    const cookieHeader = cookieJar?.toHeader();
    if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }

    const response = await fetch(`${baseUrl}${requestPath}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      redirect: options.redirect ?? "follow",
      signal: controller.signal
    });

    cookieJar?.updateFromResponse(response);

    const contentType = response.headers.get("content-type") || "";
    const body =
      contentType.includes("application/json")
        ? await response.json()
        : await response.text();

    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(result) {
  return {
    name: result.name,
    status: result.status,
    details: result.details,
    httpStatus: result.httpStatus ?? null
  };
}

async function runChecks() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = sanitizeBaseUrl(options.baseUrl);
  const reportPath = ensureReportPath(options.reportPath);
  const cookieJar = new CookieJar();
  const results = [];

  async function addCheck(name, runner) {
    try {
      const result = await runner();
      results.push(summarize({ name, ...result }));
    } catch (error) {
      results.push(
        summarize({
          name,
          status: "fail",
          details: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  await addCheck("Public health endpoint", async () => {
    const { response, body } = await httpRequest(baseUrl, "/api/health");

    if (!response.ok || body.status !== "healthy") {
      return {
        status: "fail",
        httpStatus: response.status,
        details: `Expected healthy response, received ${response.status} ${JSON.stringify(body)}`
      };
    }

    return {
      status: body.version && body.version !== "0.0.0" ? "pass" : "fail",
      httpStatus: response.status,
      details:
        body.version && body.version !== "0.0.0"
          ? `Health is healthy and reports version ${body.version}.`
          : `Health is healthy but version is ${body.version || "missing"}.`
    };
  });

  await addCheck("Readiness endpoint", async () => {
    const { response, body } = await httpRequest(baseUrl, "/ready");

    return response.ok && body.ready === true
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "Readiness probe reports ready: true."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected ready=true, received ${response.status} ${JSON.stringify(body)}`
        };
  });

  await addCheck("Liveness endpoint", async () => {
    const { response, body } = await httpRequest(baseUrl, "/live");

    return response.ok && body.alive === true
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "Liveness probe reports alive: true."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected alive=true, received ${response.status} ${JSON.stringify(body)}`
        };
  });

  await addCheck("Root page", async () => {
    const { response, body } = await httpRequest(baseUrl, "/");
    const contentType = response.headers.get("content-type") || "";
    const looksLikeHtml = contentType.includes("text/html") && typeof body === "string" && body.includes("<html");

    return response.ok && looksLikeHtml
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "Root page returns HTML successfully."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected HTML at root, received ${response.status} ${contentType}.`
        };
  });

  await addCheck("Clock-in page", async () => {
    const { response } = await httpRequest(baseUrl, "/clock-in");

    return response.ok
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "Clock-in page is reachable."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: "Clock-in page did not return 200."
        };
  });

  await addCheck("QR code page", async () => {
    const { response } = await httpRequest(baseUrl, "/qrcode");

    return response.ok
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "QR code page is reachable."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: "QR code page did not return 200."
        };
  });

  await addCheck("Public settings API", async () => {
    const { response, body } = await httpRequest(baseUrl, "/api/settings");

    return response.ok && typeof body === "object" && body !== null
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "Public settings payload is reachable."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected JSON settings payload, received ${response.status}.`
        };
  });

  await addCheck("Admin session probe", async () => {
    const { response, body } = await httpRequest(baseUrl, "/api/admin/session", {}, cookieJar);

    return response.ok && typeof body?.isAdmin === "boolean"
      ? {
          status: "pass",
          httpStatus: response.status,
          details: `Admin session endpoint is reachable and reports isAdmin=${body.isAdmin}.`
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected admin session payload, received ${response.status} ${JSON.stringify(body)}`
        };
  });

  await addCheck("Dashboard auth gate", async () => {
    const { response, body } = await httpRequest(baseUrl, "/api/dashboard/operational-metrics");

    return response.status === 401
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "Operational metrics are correctly protected from anonymous access."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected 401 for anonymous metrics access, received ${response.status} ${JSON.stringify(body)}`
        };
  });

  await addCheck("LINE login redirect", async () => {
    const { response } = await httpRequest(
      baseUrl,
      "/api/line/login",
      { redirect: "manual" }
    );
    const location = response.headers.get("location") || "";

    return [302, 303].includes(response.status) && location.includes("access.line.me")
      ? {
          status: "pass",
          httpStatus: response.status,
          details: "LINE login route redirects to LINE authorization as expected."
        }
      : {
          status: "fail",
          httpStatus: response.status,
          details: `Expected LINE redirect, received ${response.status} ${location || "<no location>"}.`
        };
  });

  await addCheck("Public attendance kiosk gate", async () => {
    const { response, body } = await httpRequest(baseUrl, "/api/attendance/today");

    if (response.ok) {
      return {
        status: "pass",
        httpStatus: response.status,
        details: "Today attendance feed is reachable because the kiosk is currently unlocked."
      };
    }

    if (response.status === 401 && body?.code === "SCAN_SESSION_REQUIRED") {
      return {
        status: "pass",
        httpStatus: response.status,
        details: "Today attendance feed is correctly locked behind the kiosk session."
      };
    }

    return {
      status: "fail",
      httpStatus: response.status,
      details: `Unexpected kiosk attendance response: ${response.status} ${JSON.stringify(body)}`
    };
  });

  const adminPin = process.env.ADMIN_PIN?.trim();
  const superAdminPin = process.env.SUPER_ADMIN_PIN?.trim();

  await addCheck("Admin-authenticated smoke", async () => {
    if (!adminPin) {
      return {
        status: "blocked",
        details: "Skipped because ADMIN_PIN was not provided in the environment."
      };
    }

    const login = await httpRequest(
      baseUrl,
      "/api/verify-admin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: adminPin })
      },
      cookieJar
    );

    if (!login.response.ok || login.body?.success !== true) {
      return {
        status: "fail",
        httpStatus: login.response.status,
        details: `Admin login failed: ${login.response.status} ${JSON.stringify(login.body)}`
      };
    }

    const endpoints = [
      "/api/admin/session",
      "/api/employees/admin",
      "/api/attendance",
      "/api/salary-records"
    ];

    for (const endpoint of endpoints) {
      const result = await httpRequest(baseUrl, endpoint, {}, cookieJar);
      if (!result.response.ok) {
        return {
          status: "fail",
          httpStatus: result.response.status,
          details: `Admin smoke failed at ${endpoint}: ${result.response.status} ${JSON.stringify(result.body)}`
        };
      }
    }

    await httpRequest(baseUrl, "/api/admin/logout", { method: "POST" }, cookieJar);

    return {
      status: "pass",
      details: "Admin login, session, employee list, attendance list, salary list, and logout all passed."
    };
  });

  await addCheck("Super-admin metrics smoke", async () => {
    if (!adminPin || !superAdminPin) {
      return {
        status: "blocked",
        details: "Skipped because ADMIN_PIN and SUPER_ADMIN_PIN were not both provided in the environment."
      };
    }

    const adminLogin = await httpRequest(
      baseUrl,
      "/api/verify-admin",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: adminPin })
      },
      cookieJar
    );

    if (!adminLogin.response.ok || adminLogin.body?.success !== true) {
      return {
        status: "fail",
        httpStatus: adminLogin.response.status,
        details: `Admin login failed before super elevation: ${adminLogin.response.status}`
      };
    }

    const elevate = await httpRequest(
      baseUrl,
      "/api/admin/elevate-super",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: superAdminPin })
      },
      cookieJar
    );

    if (!elevate.response.ok || elevate.body?.success !== true) {
      return {
        status: "fail",
        httpStatus: elevate.response.status,
        details: `Super elevation failed: ${elevate.response.status} ${JSON.stringify(elevate.body)}`
      };
    }

    const metrics = await httpRequest(baseUrl, "/api/dashboard/operational-metrics", {}, cookieJar);
    await httpRequest(baseUrl, "/api/admin/logout", { method: "POST" }, cookieJar);

    return metrics.response.ok
      ? {
          status: "pass",
          httpStatus: metrics.response.status,
          details: "Super-admin metrics endpoint is reachable after elevation."
        }
      : {
          status: "fail",
          httpStatus: metrics.response.status,
          details: `Operational metrics failed after elevation: ${metrics.response.status} ${JSON.stringify(metrics.body)}`
        };
  });

  await addCheck("LINE interactive flows", async () => ({
    status: "blocked",
    details:
      "Manual verification is still required for LINE callback, first-time binding, and LIFF clock-in because they need a real LINE identity and browser interaction."
  }));

  const summary = results.reduce(
    (accumulator, result) => {
      accumulator[result.status] = (accumulator[result.status] || 0) + 1;
      return accumulator;
    },
    {}
  );

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    summary,
    results
  };

  writeReport(reportPath, report);

  console.log(`Smoke report written to ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));

  if ((summary.fail || 0) > 0) {
    process.exitCode = 1;
  }
}

await runChecks();
