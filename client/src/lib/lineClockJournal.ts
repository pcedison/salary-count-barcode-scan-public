// A journal is scoped to the authenticated LINE user, never to a supplied employee ID.
// It contains no LINE access token or employee name. Keep even confirmed entries so
// reopening a fixed QR URL cannot silently become the next clock-out.
export interface ClockState {
  success: true;
  dateKey: string;
  stateVersion: string;
  action: 'clock-in' | 'clock-out';
  serverTimestamp: string;
}

export interface ClockResult {
  success: true;
  action: 'clock-in' | 'clock-out';
  employeeName: string;
  clockTime: string;
  department?: string;
  timestamp?: string;
}

export interface ClockAttempt {
  version: 1;
  eventId: string;
  stateVersion: string;
  clientTimestamp: string;
  phase: 'pending' | 'confirmed' | 'rejected';
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storageError = '無法安全保存打卡確認紀錄。請允許此網站儲存資料，並先核對原次結果，勿重新打卡。';

export async function clockJournalKey(userId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return `attendance-clock:v1:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function readClockAttempt(storage: Storage, key: string): ClockAttempt | null {
  let text: string | null;
  try { text = storage.getItem(key); } catch { throw new Error(storageError); }
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    if (value.version !== 1 || !uuid.test(value.eventId) ||
      typeof value.stateVersion !== 'string' || !value.stateVersion ||
      typeof value.clientTimestamp !== 'string' || !Number.isFinite(Date.parse(value.clientTimestamp)) ||
      !['pending', 'confirmed', 'rejected'].includes(value.phase)) throw new Error();
    return value as ClockAttempt;
  } catch {
    throw new Error('上次打卡的確認紀錄無法讀取。請保留瀏覽器資料並聯絡管理員核對，勿重新打卡。');
  }
}

export function saveClockAttempt(storage: Storage, key: string, attempt: ClockAttempt): void {
  const text = JSON.stringify(attempt);
  try {
    storage.setItem(key, text);
    if (storage.getItem(key) !== text) throw new Error();
  } catch { throw new Error(storageError); }
}

export type ClockTimeAnchor = { serverMs: number; receivedAt: number };

export function clockTimeAnchor(state: ClockState, receivedAt = performance.now()): ClockTimeAnchor {
  const serverMs = Date.parse(state.serverTimestamp);
  if (!Number.isFinite(serverMs)) throw new Error('無法確認伺服器時間，尚未送出打卡。請重新載入。');
  return { serverMs, receivedAt };
}

export function clockTimeFromAnchor(anchor: ClockTimeAnchor, current = performance.now()): Date {
  const elapsed = current - anchor.receivedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('打卡時間基準已失效，請重新載入。');
  return new Date(anchor.serverMs + Math.floor(elapsed));
}

export async function withClockJournalLock<T>(key: string, work: () => T | Promise<T>, locks = globalThis.navigator?.locks): Promise<T> {
  if (!locks?.request) throw new Error('此瀏覽器無法安全協調打卡紀錄。請更新 LINE／瀏覽器或使用支援的瀏覽器，並先核對原次結果。');
  return locks.request(key, { mode: 'exclusive' }, work);
}

// Caller holds the per-account Web Lock. A late response must not overwrite a
// newer attempt reserved by another tab while this request was in flight.
export function finishClockAttempt(storage: Storage, key: string, attempt: ClockAttempt, phase: 'confirmed' | 'rejected'): boolean {
  const current = readClockAttempt(storage, key);
  if (!current || current.eventId !== attempt.eventId ||
      current.stateVersion !== attempt.stateVersion || current.clientTimestamp !== attempt.clientTimestamp) return false;
  saveClockAttempt(storage, key, { ...current, phase });
  return true;
}

export function newClockAttempt(state: ClockState, now = new Date(clockTimeAnchor(state).serverMs)): ClockAttempt {
  return { version: 1, eventId: crypto.randomUUID(), stateVersion: state.stateVersion,
    clientTimestamp: now.toISOString(), phase: 'pending' };
}

export function canResendClockAttempt(attempt: ClockAttempt, now: number): boolean {
  const age = now - Date.parse(attempt.clientTimestamp);
  return attempt.phase === 'pending' && age >= 0 && age <= 5 * 60_000;
}

export class ClockRequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function clockRequest<T>(path: string, body?: Record<string, string>): Promise<T> {
  // No automatic retry for a write: consult the durable receipt before replaying.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok || data.success === false) {
      throw new ClockRequestError(response.status, data.code ?? '', data.error ?? '暫時無法確認打卡結果');
    }
    return data as T;
  } finally { clearTimeout(timeout); }
}

export function clockAttemptBody(attempt: ClockAttempt): Record<string, string> {
  return { eventId: attempt.eventId, stateVersion: attempt.stateVersion, clientTimestamp: attempt.clientTimestamp };
}
