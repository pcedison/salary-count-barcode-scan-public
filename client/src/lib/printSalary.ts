export function parseSalaryRecordId(search: string): number | null {
  const rawId = new URLSearchParams(search).get('id');

  if (!rawId || !/^\d+$/.test(rawId)) {
    return null;
  }

  const recordId = Number.parseInt(rawId, 10);
  return Number.isInteger(recordId) && recordId > 0 ? recordId : null;
}
