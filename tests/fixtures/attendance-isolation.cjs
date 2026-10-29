'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const events = { processId: process.pid, threadId, dotenvReadsBlocked: 0, forbiddenConnections: 0, loopbackConnections: 0 };
const isDotenv = value => (typeof value === 'string' || value instanceof URL) && /^\.env(?:\.|$)/.test(path.basename(value instanceof URL ? value.pathname : value));
const absentEnv = () => Object.assign(new Error('Isolated verification does not read environment files'), { code: 'ENOENT' });
const originalExists = fs.existsSync;
fs.existsSync = function (file) { return isDotenv(file) ? false : originalExists.call(this, file); };
for (const method of ['statSync', 'lstatSync']) {
  const original = fs[method];
  fs[method] = function (file, ...args) { if (isDotenv(file)) { if (args[0]?.throwIfNoEntry === false) return undefined; throw absentEnv(); } return original.call(this, file, ...args); };
}
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) { if (isDotenv(file)) { events.dotenvReadsBlocked++; throw absentEnv(); } return originalRead.call(this, file, ...args); };
const originalAsyncRead = fs.readFile;
fs.readFile = function (file, ...args) { if (isDotenv(file)) { events.dotenvReadsBlocked++; const callback = args.at(-1); queueMicrotask(() => callback(absentEnv())); return; } return originalAsyncRead.call(this, file, ...args); };
const originalPromiseRead = fs.promises.readFile;
fs.promises.readFile = async function (file, ...args) { if (isDotenv(file)) { events.dotenvReadsBlocked++; throw absentEnv(); } return originalPromiseRead.call(this, file, ...args); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  // Existing child-process IPC uses pipes, never an external host.
  if (typeof options === 'string' && !/^\d+$/.test(options)) return originalConnect.apply(this, args);
  if (options && typeof options === 'object' && options.path) return originalConnect.apply(this, args);
  const host = typeof options === 'object' ? options.host || 'localhost' : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    events.forbiddenConnections++;
    throw new Error('Isolated verification refuses external network connections');
  }
  events.loopbackConnections++;
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
process.on('exit', () => {
  const directory = process.env.ATTENDANCE_ISOLATION_LOG;
  if (directory) {
    const destination = path.join(directory, `${process.pid}-${threadId}.json`);
    const temporary = destination + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(events, null, 2));
    fs.renameSync(temporary, destination);
  }
});
