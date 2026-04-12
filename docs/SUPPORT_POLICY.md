# Support Policy

This repository is maintained on a best-effort basis.

## What Maintainers Will Usually Help With

- reproducible bugs in the public codebase
- release-readiness regressions
- documentation mismatches that block safe deployment
- security triage through the private process in [SECURITY.md](../SECURITY.md)

## What Maintainers May Not Provide

- hands-on production operations for third-party deployments
- custom feature development on demand
- recovery of lost credentials, tokens, or database content
- support for modified forks that diverge significantly from `main`

## Expected Response Shape

- security reports should use the private path in [SECURITY.md](../SECURITY.md)
- public bugs and feature requests should use the GitHub templates
- maintainers may ask for logs, exact reproduction steps, version, and deployment context before acting

## Deployment Responsibility

Operators remain responsible for:

- rotating secrets
- aligning live callback URLs and LIFF endpoint configuration
- validating canary deployments
- confirming database backups and restore readiness
- enforcing repository and platform access controls

## Version and Maintenance Scope

- `main` and the latest public release documented in [CHANGELOG.md](../CHANGELOG.md) are the primary supported lines
- best-effort guidance may be provided for older snapshots, but fixes are not guaranteed
