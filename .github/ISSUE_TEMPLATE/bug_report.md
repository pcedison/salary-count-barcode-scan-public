---
name: Bug report
about: Report a reproducible defect in the public repository or deployment workflow
title: "[Bug] "
labels: bug
assignees: ""
---

## Summary

Describe the bug clearly and concisely.

## Reproduction

1. 
2. 
3. 

## Expected behavior

Describe what you expected to happen.

## Actual behavior

Describe what happened instead. Include the exact error text if it is safe to share.

## Scope

- Affected paths or features:
- Environment: local / CI / Docker / Zeabur / other
- Is this a regression? Yes / No / Unsure

## Verification

List any checks you ran, for example:

- `npm run verify:release`
- `git diff --check`
- targeted test files

## Configuration and Security Notes

Please confirm the report does **not** include:

- plaintext secrets or tokens
- raw production credentials
- unmasked personal data
- private infrastructure details that are not needed for reproduction

If the bug may be security-sensitive, stop here and use the private process in [SECURITY.md](../../SECURITY.md) instead of filing a public issue.
