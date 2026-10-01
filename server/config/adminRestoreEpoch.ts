export class AdminRestoreEpochChangedError extends Error {
  readonly status = 409;
  readonly code = 'AUTH_RESTORE_CHANGED';
  constructor() { super('資料已還原，請重新登入。'); }
}
