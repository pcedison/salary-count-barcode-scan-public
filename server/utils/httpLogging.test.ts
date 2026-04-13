import { describe, expect, it } from 'vitest';

import { buildApiRequestLog, getApiRequestLogLevel } from './httpLogging';

describe('http logging helpers', () => {
  it('keeps successful api logs at debug level without response payloads', () => {
    expect(getApiRequestLogLevel(200, '/api/employees')).toBe('debug');
    expect(
      buildApiRequestLog('GET', '/api/employees', 200, 18, {
        success: true,
        employees: [{ id: 1, name: '測試員工' }]
      })
    ).toBe('GET /api/employees 200 in 18ms');
  });

  it('summarizes client errors without dumping the full response body', () => {
    expect(getApiRequestLogLevel(401, '/api/update-admin-pin')).toBe('warn');
    expect(
      buildApiRequestLog('POST', '/api/update-admin-pin', 401, 24, {
        success: false,
        message: 'Current PIN is incorrect',
        errors: ['bad-pin'],
        pin: '123456'
      })
    ).toBe(
      'POST /api/update-admin-pin 401 in 24ms :: {"message":"Current PIN is incorrect","success":false,"errorCount":1}'
    );
  });

  it('downgrades expected auth-gated responses to info', () => {
    expect(
      getApiRequestLogLevel(401, '/api/dashboard/operational-metrics', {
        success: false,
        message: '缺少管理員授權，請重新登入管理員模式'
      })
    ).toBe('info');

    expect(
      getApiRequestLogLevel(401, '/api/attendance/today', {
        success: false,
        code: 'SCAN_SESSION_REQUIRED',
        message: 'Kiosk attendance is available only after the barcode kiosk is unlocked.'
      })
    ).toBe('info');
  });

  it('truncates oversized error messages for server failures', () => {
    const longMessage = 'x'.repeat(200);

    expect(getApiRequestLogLevel(500, '/api/salary-records/7')).toBe('error');
    expect(
      buildApiRequestLog('PATCH', '/api/salary-records/7', 500, 31, {
        message: longMessage
      })
    ).toBe(
      `PATCH /api/salary-records/7 500 in 31ms :: {"message":"${'x'.repeat(119)}…"}`
    );
  });
});
