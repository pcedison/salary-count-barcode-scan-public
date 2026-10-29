import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run ordinary repository checks without inheriting application credentials or loading .env.
// This runner never starts the application or provisions/migrates a database.
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] || 'all';
if (!['all', 'test', 'check', 'build'].includes(mode)) throw new Error('Use all, test, check, or build');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, 'tmp/implementation-20261029/verifier', `${mode}-${runId}`);
mkdirSync(path.join(output, 'os-temp'), { recursive: true });
mkdirSync(path.join(output, 'guard'), { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const sourcePaths = git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'server', 'client', 'shared', 'scripts', 'tests/fixtures', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'vitest.config.ts', 'vite.config.ts', 'tsconfig.json')
  .split(/\r?\n/).filter(file => /\.(?:[cm]?[jt]sx?|json|sql|sh|cjs|mjs)$/.test(file) || ['Dockerfile', '.dockerignore'].includes(file));
const snapshot = () => Object.fromEntries(sourcePaths.filter(file => existsSync(path.join(root, file))).map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
const sourcesBefore = snapshot();
writeFileSync(path.join(output, 'sources-before.json'), JSON.stringify(sourcesBefore, null, 2));
const config = path.join(output, 'vitest.isolated.config.mjs');
writeFileSync(config, `import original from ${JSON.stringify(pathToFileURL(path.join(root, 'vitest.config.ts')).href)};\nexport default { ...original, root: ${JSON.stringify(root)}, envDir: false, cacheDir: ${JSON.stringify(path.join(output, 'vite-cache'))} };\n`);
const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'number_of_processors', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'temp', 'tmp']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
const preload = path.join(root, 'tests/fixtures/attendance-isolation.cjs');
Object.assign(env, {
  CI: 'true', NO_COLOR: '1',
  ATTENDANCE_ISOLATION_LOG: path.join(output, 'guard'),
  NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
  APP_RUNTIME_DIR: path.join(output, 'runtime'),
  APP_BACKUP_DIR: path.join(output, 'runtime/backups'),
  APP_LOG_DIR: path.join(output, 'runtime/logs'),
});
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npm)) throw new Error('npm CLI must be installed alongside the selected Node runtime');
const commands = mode === 'all' ? ['test', 'check', 'build'] : [mode];
const results = [];
for (const step of commands) {
  const args = step === 'test' ? ['test', '--', '--config', config, '--reporter=default', '--reporter=json', `--outputFile=${path.join(output, 'tests.json')}`] : ['run', step];
  const logPath = path.join(output, step + '.log');
  const log = createWriteStream(logPath);
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [npm, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => log.write(chunk));
  child.stderr.on('data', chunk => log.write(chunk));
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => log.end(resolve));
  const result = { command: ['npm', ...args], startedAt, finishedAt: new Date().toISOString(), exitCode, logPath };
  results.push(result);
  console.log(JSON.stringify(result));
  console.log(readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-18).join('\n'));
}
const sourcesAfter = snapshot();
writeFileSync(path.join(output, 'sources-after.json'), JSON.stringify(sourcesAfter, null, 2));
const changedDuringRun = [...new Set([...Object.keys(sourcesBefore), ...Object.keys(sourcesAfter)])].filter(file => sourcesBefore[file] !== sourcesAfter[file]);
const testReportPath = path.join(output, 'tests.json');
const testReport = existsSync(testReportPath) ? JSON.parse(readFileSync(testReportPath, 'utf8')) : null;
const testCounts = testReport ? Object.fromEntries(['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'success'].map(key => [key, testReport[key]])) : null;
const testFiles = testReport?.testResults.map(file => ({ path: path.relative(root, file.name), status: file.assertionResults.length && file.assertionResults.every(test => ['skipped', 'pending', 'todo'].includes(test.status)) ? 'skipped' : file.status }));
const incompleteGuardFiles = [];
const guardEvents = readdirSync(path.join(output, 'guard')).filter(file => file.endsWith('.json')).flatMap(file => {
  try { return [JSON.parse(readFileSync(path.join(output, 'guard', file), 'utf8'))]; }
  catch { incompleteGuardFiles.push(file); return []; }
});
const guardTotals = Object.fromEntries(['dotenvReadsBlocked', 'forbiddenConnections', 'loopbackConnections'].map(key => [key, guardEvents.reduce((sum, event) => sum + event[key], 0)]));
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ node: process.version, npm: JSON.parse(readFileSync(path.join(path.dirname(npm), '../package.json'), 'utf8')).version, head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), output, inheritedEnvironment: 'OS runtime only', dotenv: 'blocked before file read', network: 'loopback only', changedDuringRun, incompleteGuardFiles, guardTotals, testCounts, testFiles, results }, null, 2));
process.exitCode = results.some(result => result.exitCode !== 0) || incompleteGuardFiles.length ? 1 : 0;
