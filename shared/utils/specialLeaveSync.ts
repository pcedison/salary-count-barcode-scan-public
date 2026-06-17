export interface SpecialLeaveDateDiff {
  addedDates: string[];
  removedDates: string[];
}

export function normalizeDateToDash(date: string): string {
  return date.replace(/\//g, '-');
}

export function normalizeDateToSlash(date: string): string {
  return normalizeDateToDash(date).replace(/-/g, '/');
}

export function diffSpecialLeaveDates(
  oldDates: string[] = [],
  newDates: string[] = []
): SpecialLeaveDateDiff {
  const oldDatesNormalized = oldDates.map(normalizeDateToDash);
  const newDatesNormalized = newDates.map(normalizeDateToDash);

  return {
    addedDates: newDatesNormalized.filter(date => !oldDatesNormalized.includes(date)),
    removedDates: oldDatesNormalized.filter(date => !newDatesNormalized.includes(date))
  };
}

export function removeSpecialLeaveDate(
  currentDates: string[] = [],
  holidayDate: string
): string[] {
  const normalizedHolidayDate = normalizeDateToDash(holidayDate);

  return currentDates.filter(date => normalizeDateToDash(date) !== normalizedHolidayDate);
}

export function formatYearMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseYearMonthKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const compactMatch = trimmed.match(/^(\d{4})(\d{2})$/);
  const delimitedMatch = compactMatch ?? trimmed.match(/(\d{4})\D+(\d{1,2})/);
  if (!delimitedMatch) {
    return null;
  }

  const year = Number.parseInt(delimitedMatch[1], 10);
  const month = Number.parseInt(delimitedMatch[2], 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  return formatYearMonthKey(year, month);
}

export function matchesYearMonth(
  value: string | null | undefined,
  year: number,
  month: number
): boolean {
  return parseYearMonthKey(value) === formatYearMonthKey(year, month);
}
