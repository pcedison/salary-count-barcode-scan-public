export const PIN_VALIDATION_RULES = {
  length: 6,
  blacklist: [
    '000000',
    '111111',
    '123456',
    '654321',
    '121212',
    '101010',
    '112233',
    '123123'
  ]
};

export interface PinValidationResult {
  valid: boolean;
  errors: string[];
  strength: 'weak' | 'medium' | 'strong';
}

function isSequential(pin: string): boolean {
  const digits = pin.split('').map(Number);
  const ascending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1);
  const descending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1);
  return ascending || descending;
}

function isRepeating(pin: string): boolean {
  return pin.split('').every(digit => digit === pin[0]);
}

function isSimplePattern(pin: string): boolean {
  const pair = pin.slice(0, 2);
  return pin === pair.repeat(3);
}

function calculateStrength(pin: string): 'weak' | 'medium' | 'strong' {
  let score = 0;

  if (new Set(pin.split('')).size >= 4) {
    score += 1;
  }

  if (!isSequential(pin)) {
    score += 1;
  }

  if (!isRepeating(pin)) {
    score += 1;
  }

  if (!isSimplePattern(pin)) {
    score += 1;
  }

  if (score >= 4) {
    return 'strong';
  }

  if (score >= 2) {
    return 'medium';
  }

  return 'weak';
}

export function validatePin(pin: string): PinValidationResult {
  const errors: string[] = [];

  if (pin.includes(':')) {
    errors.push('PIN must not contain colons');
  }

  if (!/^\d{6}$/.test(pin)) {
    errors.push('PIN 必須為 6 位數字');
  }

  if (PIN_VALIDATION_RULES.blacklist.includes(pin)) {
    errors.push('此 PIN 碼過於簡單或常見');
  }

  if (pin.length === PIN_VALIDATION_RULES.length && isSequential(pin)) {
    errors.push('PIN 不能為連續數字');
  }

  if (pin.length === PIN_VALIDATION_RULES.length && isRepeating(pin)) {
    errors.push('PIN 不能為重複數字');
  }

  if (pin.length === PIN_VALIDATION_RULES.length && isSimplePattern(pin)) {
    errors.push('PIN 不能使用簡單重複模式');
  }

  return {
    valid: errors.length === 0,
    errors,
    strength: calculateStrength(pin)
  };
}
