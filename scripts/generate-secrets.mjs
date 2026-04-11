import {
  generateDeploymentSecrets,
  renderSecretsEnv,
  renderSecretsJson
} from './lib/secrets-generator.mjs';

function printHelp() {
  console.log(`
Usage:
  npm run secrets:generate
  npm run secrets:generate -- --json

Generates deployment secrets for:
  - SESSION_SECRET
  - ENCRYPTION_KEY
  - ENCRYPTION_SALT
  - USE_AES_ENCRYPTION=true

Default output format is an env block suitable for Zeabur Variables or .env.
  `.trim());
}

function main() {
  const rawArgs = new Set(process.argv.slice(2));

  if (rawArgs.has('--help') || rawArgs.has('-h')) {
    printHelp();
    return;
  }

  const secrets = generateDeploymentSecrets();
  const output = rawArgs.has('--json')
    ? renderSecretsJson(secrets)
    : renderSecretsEnv(secrets);

  console.log(output);
}

main();
