# Security Policy

## Supported Versions

Security fixes are provided for:

- the current `main` branch
- the latest public release documented in [CHANGELOG.md](CHANGELOG.md)

Older snapshots, forks, and private downstream deployments are not guaranteed to receive coordinated fixes.

## Reporting A Vulnerability

Please do not open a public GitHub issue for security problems.

Use GitHub Security Advisories for private reporting:

- Repository security advisories: <https://github.com/pcedison/salary-count-barcode-scan-public/security/advisories/new>

If you cannot use GitHub Security Advisories, contact the maintainers through a private channel you already trust and include a link back to this repository.

## What To Include

Please include:

- a short description of the issue
- affected area or file path
- reproduction steps
- impact assessment
- mitigation ideas if you already have them

## What Not To Include

Do not include any of the following in public or private reports unless absolutely necessary and already redacted:

- plaintext secrets, tokens, API keys, session secrets, or passwords
- full database dumps or raw production payloads
- unmasked personal data
- deployment credentials or platform access details
- workstation paths, operator-only notes, or other internal handoff material

If a proof of concept requires sensitive material, redact it first and describe the missing values in words.

## Disclosure Expectations

- Please allow reasonable time for triage, remediation, and operator coordination before public disclosure.
- If the issue involves active credential exposure, operators should rotate and revoke affected credentials immediately.
- If the issue affects deployed environments, maintainers may ask operators to redeploy after mitigation lands.

## Operator Guidance

If you operate a deployment of this project and suspect a security incident:

- rotate exposed secrets immediately
- revoke compromised tokens or credentials
- review deployment and audit logs
- verify `SUPER_ADMIN_PIN` remains hashed
- rerun `npm run verify:release`
- redeploy only after the mitigation is confirmed
