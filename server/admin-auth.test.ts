import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyAdminPermission, verifySuperAdminPermission } from './admin-auth';
import { hashAdminPin } from './utils/adminPinAuth';

const storageMock = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock('./storage', () => ({ storage: storageMock }));

const ordinaryPin = 'synthetic-admin-credential';
const superPin = 'synthetic-super-credential';
const ordinaryHash = hashAdminPin(ordinaryPin);
const superHash = hashAdminPin(superPin);

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VITEST', 'true');
  vi.stubEnv('SUPER_ADMIN_PIN', undefined);
  storageMock.getSettings.mockReset().mockResolvedValue({ adminPin: ordinaryHash });
});

afterEach(() => vi.unstubAllEnvs());

describe('independent SUPER credentials', () => {
  it('keeps a valid ordinary credential at ADMIN when no SUPER hash is configured', async () => {
    expect(await verifyAdminPermission(ordinaryPin)).toBe(true);
    storageMock.getSettings.mockClear();
    expect(await verifySuperAdminPermission(ordinaryPin)).toBe(false);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
  });

  const environments = ['development', 'test', 'production', 'staging', undefined];
  it.each(environments.flatMap(nodeEnv => ['true', 'false'].map(vitest => ({ nodeEnv, vitest }))))(
    'never falls back to ordinary credentials with NODE_ENV=$nodeEnv and VITEST=$vitest',
    async ({ nodeEnv, vitest }) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('VITEST', vitest);
      expect(await verifySuperAdminPermission(ordinaryPin)).toBe(false);
      expect(storageMock.getSettings).not.toHaveBeenCalled();
    },
  );

  it.each(['development', 'test', 'production'])('rejects plaintext SUPER configuration in %s', async nodeEnv => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('SUPER_ADMIN_PIN', superPin);
    expect(await verifySuperAdminPermission(superPin)).toBe(false);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
  });

  it.each(['development', 'test', 'production'])('verifies only the independently configured SUPER hash in %s', async nodeEnv => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('SUPER_ADMIN_PIN', superHash);
    expect(await verifySuperAdminPermission(superPin)).toBe(true);
    expect(await verifySuperAdminPermission(ordinaryPin)).toBe(false);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
  });
});
