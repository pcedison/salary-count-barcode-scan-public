import fs from 'fs';
import https from 'https';

const NODE_RELEASE_SCHEDULE_URL =
  'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';

function readText(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'barcode-scan-runtime-update-audit' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
          res.resume();
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function parseMajor(value) {
  const match = String(value ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function parsePackageRuntime(packageJson) {
  return {
    nodeMajor: parseMajor(packageJson.engines?.node),
    npmMajor: parseMajor(packageJson.engines?.npm),
    packageManager: packageJson.packageManager ?? null,
    typesNodeMajor: parseMajor(packageJson.devDependencies?.['@types/node']),
  };
}

function parseDockerNodeMajors(dockerfile) {
  const matches = [...dockerfile.matchAll(/^FROM\s+node:(\d+)[^\s]*/gim)];
  return matches.map((match) => Number(match[1]));
}

function parseWorkflowNodeVersions(workflow) {
  const matches = [...workflow.matchAll(/node-version:\s*['"]?(\d+)/g)];
  return matches.map((match) => Number(match[1]));
}

function parseEsbuildTarget(script) {
  const match = script.match(/target:\s*['"]node(\d+)['"]/);
  return match ? Number(match[1]) : null;
}

function releaseState(release) {
  const today = new Date();
  const end = release.end ? new Date(`${release.end}T23:59:59Z`) : null;
  const maintenance = release.maintenance ? new Date(`${release.maintenance}T00:00:00Z`) : null;
  const lts = release.lts ? new Date(`${release.lts}T00:00:00Z`) : null;

  if (end && today > end) {
    return 'eol';
  }

  if (maintenance && today >= maintenance) {
    return 'maintenance';
  }

  if (lts && today >= lts) {
    return 'active-lts';
  }

  return 'current';
}

function supportedLtsReleases(schedule) {
  return Object.entries(schedule)
    .map(([key, release]) => ({
      major: Number(key.replace(/^v/, '').replace(/\.x$/, '')),
      codename: release.codename ?? '',
      end: release.end,
      state: releaseState(release),
      lts: release.lts,
    }))
    .filter((release) => release.lts && ['active-lts', 'maintenance'].includes(release.state))
    .sort((a, b) => a.major - b.major);
}

function formatRelease(release) {
  return `Node ${release.major}${release.codename ? ` (${release.codename})` : ''}: ${release.state}, EOL ${release.end}`;
}

function assertAligned(name, values, expectedMajor, findings) {
  const unique = [...new Set(values.filter((value) => Number.isFinite(value)))];
  if (unique.length === 0) {
    findings.push({ level: 'warn', message: `${name} version was not detected.` });
    return;
  }

  const mismatched = unique.filter((value) => value !== expectedMajor);
  if (mismatched.length > 0) {
    findings.push({
      level: 'fail',
      message: `${name} uses Node ${unique.join(', ')}, but package.json engines.node is Node ${expectedMajor}.`,
    });
  }
}

async function main() {
  const packageJson = JSON.parse(readText('package.json'));
  const dockerfile = readText('Dockerfile');
  const ciWorkflow = readText('.github/workflows/ci.yml');
  const buildScript = readText('scripts/build-server.mjs');
  const runtime = parsePackageRuntime(packageJson);
  const findings = [];

  if (!runtime.nodeMajor) {
    findings.push({ level: 'fail', message: 'package.json engines.node is missing or unparsable.' });
  }

  if (!runtime.npmMajor) {
    findings.push({ level: 'warn', message: 'package.json engines.npm is missing or unparsable.' });
  }

  if (!runtime.packageManager) {
    findings.push({ level: 'warn', message: 'package.json packageManager is missing.' });
  }

  if (runtime.nodeMajor) {
    assertAligned('Dockerfile base images', parseDockerNodeMajors(dockerfile), runtime.nodeMajor, findings);
    assertAligned('GitHub Actions setup-node', parseWorkflowNodeVersions(ciWorkflow), runtime.nodeMajor, findings);

    const esbuildTarget = parseEsbuildTarget(buildScript);
    if (esbuildTarget && esbuildTarget !== runtime.nodeMajor) {
      findings.push({
        level: 'fail',
        message: `scripts/build-server.mjs targets node${esbuildTarget}, but package.json engines.node is Node ${runtime.nodeMajor}.`,
      });
    }

    if (runtime.typesNodeMajor && runtime.typesNodeMajor !== runtime.nodeMajor) {
      findings.push({
        level: 'fail',
        message: `@types/node is pinned to major ${runtime.typesNodeMajor}, but package.json engines.node is Node ${runtime.nodeMajor}.`,
      });
    }
  }

  try {
    const schedule = await fetchJson(NODE_RELEASE_SCHEDULE_URL);
    const supportedLts = supportedLtsReleases(schedule);
    const configuredRelease = supportedLts.find((release) => release.major === runtime.nodeMajor);
    const latestLts = supportedLts.at(-1);

    console.log('Node.js supported LTS lines:');
    for (const release of supportedLts) {
      console.log(`- ${formatRelease(release)}`);
    }

    if (!configuredRelease && runtime.nodeMajor) {
      const release = schedule[`v${runtime.nodeMajor}`];
      const state = release ? releaseState(release) : 'unknown';
      findings.push({
        level: 'fail',
        message: `Configured Node ${runtime.nodeMajor} is ${state}; plan a runtime migration before the next deployment.`,
      });
    } else if (configuredRelease?.state === 'maintenance') {
      findings.push({
        level: 'warn',
        message: `Configured ${formatRelease(configuredRelease)}. Prepare migration before EOL.`,
      });
    }

    if (latestLts && runtime.nodeMajor && latestLts.major > runtime.nodeMajor) {
      findings.push({
        level: 'warn',
        message: `A newer supported LTS exists: ${formatRelease(latestLts)}. Test locally before changing Zeabur.`,
      });
    }
  } catch (error) {
    findings.push({
      level: 'warn',
      message: `Could not fetch Node.js release schedule: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  console.log('\nRuntime contract:');
  console.log(`- package.json engines.node: ${packageJson.engines?.node ?? 'missing'}`);
  console.log(`- package.json engines.npm: ${packageJson.engines?.npm ?? 'missing'}`);
  console.log(`- package.json packageManager: ${runtime.packageManager ?? 'missing'}`);
  console.log(`- Dockerfile Node majors: ${parseDockerNodeMajors(dockerfile).join(', ') || 'missing'}`);
  console.log(`- GitHub Actions Node versions: ${parseWorkflowNodeVersions(ciWorkflow).join(', ') || 'missing'}`);
  console.log(`- esbuild target: node${parseEsbuildTarget(buildScript) ?? 'missing'}`);
  console.log(`- @types/node major: ${runtime.typesNodeMajor ?? 'missing'}`);

  if (findings.length > 0) {
    console.log('\nFindings:');
    for (const finding of findings) {
      console.log(`- [${finding.level.toUpperCase()}] ${finding.message}`);
    }
  } else {
    console.log('\nFindings: none');
  }

  if (findings.some((finding) => finding.level === 'fail')) {
    process.exitCode = 1;
  }
}

await main();
