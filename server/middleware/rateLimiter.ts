import rateLimit from 'express-rate-limit';

function isDevelopment() {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

// Broad baseline limiter applied to all /api routes.
// /api/health is exempted so orchestrator health probes are never rate-limited.
// /live and /ready are outside /api, so they're unaffected automatically.
export const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDevelopment() ? 600 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: {
    success: false,
    code: 'PUBLIC_API_RATE_LIMITED',
    message: 'Too many requests. Please try again later.'
  }
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 100 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'LOGIN_RATE_LIMITED',
    error: 'Too many login attempts. Please wait before retrying.'
  }
});

export const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDevelopment() ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'STRICT_RATE_LIMITED',
    error: 'Too many requests. Please wait before retrying.'
  }
});

export const scanUnlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 100 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'SCAN_UNLOCK_RATE_LIMITED',
    message: 'Too many unlock attempts. Please wait before retrying.'
  }
});

export const scanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 500 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'SCAN_RATE_LIMITED',
    message: 'Too many scan attempts. Please wait before retrying.'
  }
});

export const deviceScanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 1000 : 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'DEVICE_SCAN_RATE_LIMITED',
    message: 'Too many device scan requests. Please wait before retrying.'
  }
});

export const lineSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 120 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'LINE_SESSION_RATE_LIMITED',
    message: 'Too many LINE session requests. Please wait before retrying.'
  }
});

export const lineBindLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 50 : 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'LINE_BIND_RATE_LIMITED',
    message: 'Too many LINE binding attempts. Please wait before retrying.'
  }
});

export const lineClockInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 200 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'LINE_CLOCK_IN_RATE_LIMITED',
    message: 'Too many LINE clock-in attempts. Please wait before retrying.'
  }
});

// LIFF QR 打卡專用：比一般 session limiter 寬鬆，與硬體掃描器同等級
export const liffClockInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment() ? 500 : 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'LIFF_CLOCK_IN_RATE_LIMITED',
    message: 'Too many LIFF clock-in requests. Please wait before retrying.'
  }
});
