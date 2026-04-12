import crypto from 'crypto';
import { createLogger } from '../utils/logger';

const log = createLogger('line-service');

const LINE_TOKEN_ENDPOINT = 'https://api.line.me/oauth2/v2.1/token';
const LINE_PROFILE_ENDPOINT = 'https://api.line.me/v2/profile';
const LINE_AUTHORIZE_ENDPOINT = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_API_TIMEOUT_MS = 8_000;

function maskLineUserId(lineUserId: string): string {
  const normalized = lineUserId.trim();
  if (normalized.length <= 8) {
    return '***';
  }

  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

export interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

async function fetchLineApi(
  url: string,
  init: RequestInit,
  operation: string
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINE_API_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${operation} timed out after ${LINE_API_TIMEOUT_MS}ms`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function isLineConfigured(): boolean {
  return !!(
    process.env.LINE_LOGIN_CHANNEL_ID &&
    process.env.LINE_LOGIN_CHANNEL_SECRET &&
    process.env.LINE_LOGIN_CALLBACK_URL &&
    process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN &&
    process.env.LINE_MESSAGING_CHANNEL_SECRET
  );
}

export function getLineLoginUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINE_LOGIN_CHANNEL_ID!,
    redirect_uri: process.env.LINE_LOGIN_CALLBACK_URL!,
    state,
    scope: 'profile openid'
  });
  return `${LINE_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<{ access_token: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.LINE_LOGIN_CALLBACK_URL!,
    client_id: process.env.LINE_LOGIN_CHANNEL_ID!,
    client_secret: process.env.LINE_LOGIN_CHANNEL_SECRET!
  });

  const response = await fetchLineApi(LINE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }, 'LINE token exchange');

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LINE token exchange failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<{ access_token: string }>;
}

export async function getLineProfile(accessToken: string): Promise<LineProfile> {
  const response = await fetchLineApi(LINE_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  }, 'LINE profile fetch');

  if (!response.ok) {
    throw new Error(`LINE profile fetch failed: ${response.status}`);
  }

  return response.json() as Promise<LineProfile>;
}

export async function verifyLiffAccessToken(accessToken: string): Promise<LineProfile | null> {
  try {
    const verifyRes = await fetchLineApi(
      `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`,
      {},
      'LINE access token verification'
    );
    if (!verifyRes.ok) return null;

    const verifyData = await verifyRes.json() as { client_id: string; expires_in: number };
    if (verifyData.client_id !== process.env.LINE_LOGIN_CHANNEL_ID) return null;
    if (verifyData.expires_in <= 0) return null;

    return getLineProfile(accessToken);
  } catch {
    return null;
  }
}

export function verifyWebhookSignature(body: Buffer, signature: string): boolean {
  const secret = process.env.LINE_MESSAGING_CHANNEL_SECRET;
  if (!secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function getMessagingClient() {
  const { messagingApi } = await import('@line/bot-sdk');
  return new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN!
  });
}

export async function pushMessage(lineUserId: string, message: string): Promise<void> {
  try {
    const client = await getMessagingClient();
    await client.pushMessage({
      to: lineUserId,
      messages: [{ type: 'text', text: message }]
    });
  } catch (err) {
    log.warn(`LINE push message failed for ${maskLineUserId(lineUserId)}:`, err);
  }
}

export async function sendClockInNotification(
  lineUserId: string,
  employeeName: string,
  clockTime: string,
  isClockIn: boolean
): Promise<void> {
  const emoji = isClockIn ? '✅' : '⏰';
  const actionZh = isClockIn ? '簽到' : '簽退';
  const actionVi = isClockIn ? 'Chấm công vào' : 'Chấm công ra';
  const closingZh = isClockIn ? '祝您今天工作順利！' : '辛苦了，請好好休息。';
  const closingVi = isClockIn ? 'Chúc bạn làm việc suôn sẻ!' : 'Cảm ơn bạn, nhớ nghỉ ngơi nhé.';
  const message = `${emoji} LINE 打卡成功!\n\n員工 / Nhân viên: ${employeeName}\n動作 / Loại: ${actionZh} / ${actionVi}\n時間 / Thời gian: ${clockTime}\n\n${closingZh}\n${closingVi}`;
  await pushMessage(lineUserId, message);
}
