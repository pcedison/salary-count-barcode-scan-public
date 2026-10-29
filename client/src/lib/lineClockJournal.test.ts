import { afterEach, describe, expect, it, vi } from 'vitest';
import { clockJournalKey, readClockAttempt, saveClockAttempt, newClockAttempt, canResendClockAttempt,
  clockAttemptBody, clockRequest, ClockRequestError, clockTimeAnchor, clockTimeFromAnchor,
  withClockJournalLock, finishClockAttempt, type ClockState } from './lineClockJournal';

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, clear: () => entries.clear(),
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); }, key: i => [...entries.keys()][i] ?? null };
}
const state: ClockState = { success: true, action: 'clock-in', dateKey: '2026/10/29', stateVersion: 'v1.2026-10-29.hash', serverTimestamp: '2026-10-29T02:00:00.000Z' };
afterEach(() => vi.unstubAllGlobals());

describe('LINE durable attempt journal', () => {
  it('scopes journals by verified user without persisting the user ID or token', async () => {
    const alice = await clockJournalKey('U_TEST_ALICE');
    const bob = await clockJournalKey('U_TEST_BOB');
    expect(alice).not.toBe(bob);
    expect(alice).not.toContain('ALICE');
    const storage = memoryStorage();
    const attempt = newClockAttempt(state);
    saveClockAttempt(storage, alice, attempt);
    expect(readClockAttempt(storage, bob)).toBeNull();
    expect(JSON.stringify(readClockAttempt(storage, alice))).not.toMatch(/accessToken|employeeName|lineUserId/);
  });

  it('restores the same event and original payload after closing a page', () => {
    const storage = memoryStorage();
    const original = newClockAttempt(state);
    saveClockAttempt(storage, 'user', original);
    expect(clockAttemptBody(readClockAttempt(storage, 'user')!)).toEqual(clockAttemptBody(original));
    const confirmed = { ...original, phase: 'confirmed' as const };
    saveClockAttempt(storage, 'user', confirmed);
    expect(readClockAttempt(storage, 'user')?.eventId).toBe(original.eventId);
    expect(canResendClockAttempt(readClockAttempt(storage, 'user')!, Date.parse(state.serverTimestamp))).toBe(false);
  });

  it('retains rejected attempts so initialization cannot silently create a new punch', () => {
    const storage = memoryStorage();
    const rejected = { ...newClockAttempt(state), phase: 'rejected' as const };
    saveClockAttempt(storage, 'user', rejected);
    expect(readClockAttempt(storage, 'user')).toEqual(rejected);
    expect(canResendClockAttempt(rejected, Date.parse(state.serverTimestamp))).toBe(false);
  });

  it('fails closed on corrupt or inaccessible storage, preserving the original bytes', () => {
    const storage = memoryStorage();
    storage.setItem('user', '{broken');
    expect(() => readClockAttempt(storage, 'user')).toThrow('聯絡管理員');
    expect(storage.getItem('user')).toBe('{broken');
    storage.getItem = () => { throw new Error('denied'); };
    expect(() => readClockAttempt(storage, 'user')).toThrow('確認紀錄');
  });

  it('refuses writes when storage is full or silently discards data', () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error('quota'); };
    expect(() => saveClockAttempt(storage, 'user', newClockAttempt(state))).toThrow();
    storage.setItem = () => undefined;
    expect(() => saveClockAttempt(storage, 'user', newClockAttempt(state))).toThrow();
  });

  it('only permits original pending replay within the server timing window', () => {
    const now = Date.parse('2026-10-29T02:00:00.000Z');
    const attempt = newClockAttempt(state, new Date(now));
    expect(canResendClockAttempt(attempt, now + 300_000)).toBe(true);
    expect(canResendClockAttempt(attempt, now + 300_001)).toBe(false);
    expect(canResendClockAttempt(attempt, now - 1)).toBe(false);
    expect(canResendClockAttempt({ ...attempt, phase: 'confirmed' }, now)).toBe(false);
  });

  it('creates distinct IDs only for explicit new attempts without changing the supplied state version', () => {
    const first = newClockAttempt(state);
    const second = newClockAttempt(state);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.stateVersion).toBe(state.stateVersion);
    expect(clockAttemptBody(first)).toEqual({ eventId: first.eventId, stateVersion: state.stateVersion, clientTimestamp: first.clientTimestamp });
  });

  it.each([-3_600_000, 3_600_000])('ignores a phone wall clock offset of %s ms', offset => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(state.serverTimestamp) + offset);
    try {
      const anchor = clockTimeAnchor(state, 10_000);
      const attempt = newClockAttempt(state, clockTimeFromAnchor(anchor, 12_500));
      expect(attempt.clientTimestamp).toBe('2026-10-29T02:00:02.500Z');
      expect(canResendClockAttempt(attempt, Date.parse('2026-10-29T02:05:02.500Z'))).toBe(true);
      expect(canResendClockAttempt(attempt, Date.parse('2026-10-29T02:05:02.501Z'))).toBe(false);
    } finally { dateNow.mockRestore(); }
  });

  it('refuses invalid server time and a reset monotonic clock', () => {
    expect(() => clockTimeAnchor({ ...state, serverTimestamp: '' })).toThrow('伺服器時間');
    expect(() => clockTimeFromAnchor(clockTimeAnchor(state, 100), 99)).toThrow('時間基準');
  });

  it('does not let late success or rejection overwrite a newer pending event', () => {
    const storage = memoryStorage();
    const first = newClockAttempt(state); const newer = newClockAttempt(state);
    saveClockAttempt(storage, 'user', newer);
    expect(finishClockAttempt(storage, 'user', first, 'confirmed')).toBe(false);
    expect(finishClockAttempt(storage, 'user', first, 'rejected')).toBe(false);
    expect(readClockAttempt(storage, 'user')).toEqual(newer);
    expect(finishClockAttempt(storage, 'user', newer, 'confirmed')).toBe(true);
  });

  it('serializes two tab reservations so both retain the same pending event', async () => {
    const storage = memoryStorage(); let tail = Promise.resolve<unknown>(undefined);
    const request = vi.fn((_key, _options, work) => {
      const result = tail.then(work); tail = result.catch(() => undefined); return result;
    });
    const locks = { request } as unknown as LockManager;
    const reserve = () => withClockJournalLock('user', async () => {
      const current = readClockAttempt(storage, 'user');
      if (current?.phase === 'pending') return current;
      // Force an interleaving opportunity: the second tab must still wait.
      await Promise.resolve();
      const attempt = newClockAttempt(state); saveClockAttempt(storage, 'user', attempt); return attempt;
    }, locks);
    const [first, second] = await Promise.all([reserve(), reserve()]);
    expect(first.eventId).toBe(second.eventId);
    expect(readClockAttempt(storage, 'user')).toEqual(first);
    expect(request).toHaveBeenCalledWith('user', { mode: 'exclusive' }, expect.any(Function));
  });

  it('fails before reserving or sending when cross-tab locking is unavailable', async () => {
    const work = vi.fn();
    await expect(withClockJournalLock('user', work, {} as LockManager)).rejects.toThrow('更新 LINE');
    expect(work).not.toHaveBeenCalled();
  });
});

describe('clock transport', () => {
  it('never automatically replays POST on network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('response lost after commit'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(clockRequest('/api/line/clock-in', clockAttemptBody(newClockAttempt(state)))).rejects.toThrow('response lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves structured auth and conflict errors for journal recovery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: false, code: 'LINE_SESSION_REQUIRED', error: 'Login required' }), { status: 401 })));
    await expect(clockRequest('/api/line/clock-in/requests/test')).rejects.toMatchObject({ status: 401, code: 'LINE_SESSION_REQUIRED' });
    await expect(clockRequest('/api/line/clock-in/requests/test')).rejects.toBeInstanceOf(ClockRequestError);
  });

  it('uses credentials and no-store while reading a receipt without a request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, action: 'clock-in' })));
    vi.stubGlobal('fetch', fetchMock);
    await clockRequest('/api/line/clock-in/requests/test');
    expect(fetchMock).toHaveBeenCalledWith('/api/line/clock-in/requests/test', expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'include', body: undefined }));
  });
});
