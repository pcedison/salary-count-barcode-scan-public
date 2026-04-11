import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);

function resolveRollupNativePackage() {
  if (process.platform === 'linux' && process.arch === 'x64') {
    return {
      name: '@rollup/rollup-linux-x64-gnu',
      os: 'linux',
      cpu: 'x64'
    };
  }

  if (process.platform === 'win32' && process.arch === 'x64') {
    return {
      name: '@rollup/rollup-win32-x64-msvc',
      os: 'win32',
      cpu: 'x64'
    };
  }

  return null;
}

function hasPackage(pkg) {
  try {
    require.resolve(`${pkg.name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function installPackage(pkg, version) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'npm';
  const args = npmExecPath
    ? [
        npmExecPath,
        'install',
        '--no-save',
        `--os=${pkg.os}`,
        `--cpu=${pkg.cpu}`,
        `${pkg.name}@${version}`
      ]
    : [
        'install',
        '--no-save',
        `--os=${pkg.os}`,
        `--cpu=${pkg.cpu}`,
        `${pkg.name}@${version}`
      ];

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error(`Failed to install ${pkg}@${version}`);
  }
}

const nativePackage = resolveRollupNativePackage();
const rollupVersion = process.env.npm_package_devDependencies_rollup?.replace(/^[^\d]*/, '') || '4.60.0';

if (nativePackage && !hasPackage(nativePackage)) {
  console.warn(
    `[build] Missing ${nativePackage.name}; installing ${nativePackage.name}@${rollupVersion}...`
  );
  installPackage(nativePackage, rollupVersion);
}
