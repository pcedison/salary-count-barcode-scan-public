export function parseSalaryRecordId(search: string): number | null {
  const rawId = new URLSearchParams(search).get('id');

  if (!rawId || !/^\d+$/.test(rawId)) {
    return null;
  }

  const recordId = Number.parseInt(rawId, 10);
  return Number.isInteger(recordId) && recordId > 0 ? recordId : null;
}

export function parseSalaryRecordIds(search: string): number[] {
  const rawIds = new URLSearchParams(search).get('ids');
  if (!rawIds) {
    return [];
  }

  const ids = rawIds
    .split(',')
    .map((rawId) => Number.parseInt(rawId, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  return Array.from(new Set(ids));
}
