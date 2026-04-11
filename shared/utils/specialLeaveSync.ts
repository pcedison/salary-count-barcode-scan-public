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
