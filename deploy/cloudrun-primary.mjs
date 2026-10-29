import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const secretNames = new Set(['DATABASE_URL', 'SESSION_SECRET', 'BACKUP_ENCRYPTION_KEY', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'SUPER_ADMIN_PIN', 'SCAN_DEVICE_TOKEN', 'LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET', 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN', 'LINE_MESSAGING_CHANNEL_SECRET', 'RESEND_API_KEY', 'SMTP_USER', 'SMTP_PASS', 'SALARY_PRINT_TOKEN_SECRET']);
const requiredSecrets = ['DATABASE_URL', 'SESSION_SECRET', 'BACKUP_ENCRYPTION_KEY', 'LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET', 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN', 'LINE_MESSAGING_CHANNEL_SECRET'];
const reject = message => { throw new Error(message); };

// Produces a reviewable manifest only: no gcloud, network, resource creation or deploy.
export function buildPrimaryService(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) reject('Expected primary configuration object');
  const keys = ['projectId', 'region', 'service', 'image', 'runtimeServiceAccount', 'origin', 'bucket', 'liffId', 'useAesEncryption', 'secrets'];
  if (Object.keys(config).some(key => !keys.includes(key))) reject('Unknown configuration field; primary runtime values cannot be overridden');
  for (const key of ['projectId', 'region', 'service', 'bucket']) if (typeof config[key] !== 'string' || !/^[a-z][a-z0-9.-]{2,62}$/.test(config[key])) reject(`Invalid ${key}`);
  if (config.service.includes('standby')) reject('Primary service must not target the historical standby service');
  if (!/^[a-z][a-z0-9-]*-docker\.pkg\.dev\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(config.image || '')) reject('Image must use an Artifact Registry digest');
  if (!new RegExp(`^[a-z][a-z0-9-]+@${config.projectId.replaceAll('.', '\\.') }\\.iam\\.gserviceaccount\\.com$`).test(config.runtimeServiceAccount || '')) reject('Runtime service account must belong to the configured project');
  let origin;
  try { origin = new URL(config.origin); } catch { reject('Invalid primary origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== config.origin || origin.username || origin.password) reject('Primary origin must be an exact HTTPS origin');
  if (!/^\d+-[A-Za-z0-9]+$/.test(config.liffId || '')) reject('Explicit public LIFF ID is required for the image build and endpoint checklist');
  if (!config.secrets || typeof config.secrets !== 'object' || Array.isArray(config.secrets)) reject('Secret references are required');
  for (const key of requiredSecrets) if (!config.secrets[key]) reject(`Missing secret reference: ${key}`);
  if (typeof config.useAesEncryption !== 'boolean') reject('Explicit existing useAesEncryption setting is required');
  if (config.useAesEncryption && (!config.secrets.ENCRYPTION_KEY || !config.secrets.ENCRYPTION_SALT)) reject('AES requires references to the existing encryption key and salt; do not generate replacements');
  const env = Object.entries({
    NODE_ENV: 'production', APP_DEPLOYMENT_MODE: 'cloudrun', APP_BACKGROUND_SERVICES: 'disabled',
    APP_AUDIT_SINK: 'stdout', APP_PUBLIC_ORIGIN: origin.origin, ALLOWED_ORIGINS: origin.origin,
    SALARY_AUTOMATION_PUBLIC_BASE_URL: origin.origin, LINE_LOGIN_CALLBACK_URL: `${origin.origin}/api/line/callback`,
    SALARY_AUTOMATION_ENABLED: 'false', SESSION_SECURE: 'true', SESSION_SAME_SITE: 'lax', TRUST_PROXY: 'true',
    USE_AES_ENCRYPTION: String(config.useAesEncryption),
    APP_STORAGE_MOUNT: '/mnt/attendance', APP_STORAGE_BUCKET: config.bucket,
    APP_RUNTIME_DIR: '/mnt/attendance/runtime', APP_BACKUP_DIR: '/mnt/attendance/backups',
    APP_LOG_DIR: '/tmp/attendance-unused-audit',
  }).map(([name, value]) => ({ name, value }));
  for (const [name, reference] of Object.entries(config.secrets)) {
    if (!secretNames.has(name) || !reference || typeof reference !== 'object' || Array.isArray(reference)
      || Object.keys(reference).sort().join(',') !== 'name,version'
      || !/^[A-Za-z0-9_-]{1,255}$/.test(reference.name || '') || !/^[1-9]\d*$/.test(String(reference.version || ''))) reject('Invalid or unsupported secret reference; use name and numeric version only');
    env.push({ name, valueFrom: { secretKeyRef: { name: reference.name, key: String(reference.version) } } });
  }
  return {
    apiVersion: 'serving.knative.dev/v1', kind: 'Service',
    metadata: { name: config.service, namespace: config.projectId, labels: { 'cloud.googleapis.com/location': config.region, 'attendance-role': 'primary' },
      annotations: { 'attendance.liff-id': config.liffId } },
    spec: { template: { metadata: { labels: { 'attendance-role': 'primary' }, annotations: {
      'autoscaling.knative.dev/minScale': '1', 'autoscaling.knative.dev/maxScale': '1',
      'run.googleapis.com/cpu-throttling': 'false', 'run.googleapis.com/execution-environment': 'gen2',
    } }, spec: { serviceAccountName: config.runtimeServiceAccount, containerConcurrency: 20, timeoutSeconds: 300,
      containers: [{ image: config.image, ports: [{ containerPort: 8080 }], env,
        resources: { limits: { cpu: '1', memory: '2Gi' } },
        startupProbe: { httpGet: { path: '/ready', port: 8080 }, periodSeconds: 3, timeoutSeconds: 3, failureThreshold: 40 },
        livenessProbe: { httpGet: { path: '/live', port: 8080 }, periodSeconds: 30, timeoutSeconds: 5 },
        volumeMounts: [{ name: 'attendance-storage', mountPath: '/mnt/attendance' }],
      }], volumes: [{ name: 'attendance-storage', csi: { driver: 'gcsfuse.run.googleapis.com', readOnly: false,
        volumeAttributes: { bucketName: config.bucket, mountOptions: 'uid=1000,gid=1000,file-mode=0600,dir-mode=0700,implicit-dirs' } } }],
    } } },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output' || basename(args[1]).startsWith('.env')) reject('Usage: node deploy/cloudrun-primary.mjs --config nonsecret.json --output new-service.json');
  const config = JSON.parse(await readFile(resolve(args[1]), 'utf8'));
  const service = buildPrimaryService(config);
  await writeFile(resolve(args[3]), `${JSON.stringify(service, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Primary manifest generated; no platform action was performed. Review image, LIFF build ID, mounts, secrets and IAM before deployment.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Primary manifest generation failed; check nonsecret config and unused output path.'); process.exitCode = 1; });
}
