import { describe, expect, it } from 'vitest';

import { getSalaryAutomationCronSecret, isValidCronAuthorization } from './cronAuth';

const SECRET = 'a'.repeat(40);

describe('cron authorization', () => {
  it('accepts the matching bearer secret', () => {
    expect(isValidCronAuthorization(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects a missing, malformed or wrong header', () => {
    expect(isValidCronAuthorization(undefined, SECRET)).toBe(false);
    expect(isValidCronAuthorization(SECRET, SECRET)).toBe(false);
    expect(isValidCronAuthorization('Bearer wrong', SECRET)).toBe(false);
    expect(isValidCronAuthorization(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(isValidCronAuthorization('Bearer ', undefined)).toBe(false);
    expect(isValidCronAuthorization(`Bearer ${SECRET}`, undefined)).toBe(false);
  });

  it('treats a short secret as unset', () => {
    expect(getSalaryAutomationCronSecret({ SALARY_AUTOMATION_CRON_SECRET: 'short' })).toBeUndefined();
    expect(getSalaryAutomationCronSecret({ SALARY_AUTOMATION_CRON_SECRET: ` ${SECRET} ` })).toBe(SECRET);
    expect(getSalaryAutomationCronSecret({})).toBeUndefined();
  });
});
