# Operator Release Readiness

This is the operator-facing go or no-go document for publishing `barcode_scan_V3` as a public release.

## Current Recommendation

Current state:

- code and test readiness: pass
- runtime path hardening: pass
- backup and restore readiness: pass
- operator observability: pass
- external platform follow-up: still required

Recommendation:

- controlled public release: approved
- broad public rollout: approved only after the operator closes the external platform items below

## Validated Baseline

Latest verified baseline for this release candidate:

- `npm run verify:release`
- `npm run test:real-db`
- `git diff --check`

Latest known results:

- `npm test`: `52` files and `241` tests passed
- `npm run test:smoke`: `17` files and `94` tests passed
- `npm run test:real-db`: `2` files and `7` tests passed

## Go Or No-Go Matrix

| Area | Status | Operator action |
| --- | --- | --- |
| Code verification | Pass | Keep `verify:release` green before publish. |
| Real database verification | Pass | Keep `test:real-db` green before publish. |
| Runtime path policy | Pass | Confirm backups and logs stay outside the workspace. |
| Backup readiness | Pass | Create a fresh manual backup before widening traffic. |
| Operator observability | Pass | Monitor `/api/dashboard/operational-metrics` during canary. |
| Production secret rotation | Required | Rotate secrets in the deployment platform. |
| Branch protection on `main` | Pass | `required-checks` and `docker-smoke` are enforced on `main`, including admins. |
| Public documentation set | Pass | Publish using the updated operator and deployment docs. |
| Legacy doc cleanup | Follow-up | Archive or rewrite remaining historical docs over time. |

## Required Operator Closures

These items must be completed by an operator outside repository code:

1. Rotate live production secrets in the deployment platform.
2. Confirm production does not rely on a workspace `.env`.
3. Keep GitHub checks on `main` enforced:
   - `required-checks`
   - `docker-smoke`
4. Keep direct pushes to `main` restricted except for a documented incident process.

## Pre-Publish Checklist

Before pushing a public release:

1. Run:

```bash
npm run verify:release
npm run test:real-db
git diff --check
```

2. Confirm:

- `DATABASE_URL` points to the intended production database
- `SESSION_SECRET` is production-grade
- backup and log paths are outside the workspace
- any LINE secrets are complete and current
- the latest backup passes `npm run restore:check`

3. Review:

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)
- [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md)

## Post-Deploy Smoke

Run or verify all of the following immediately after deployment:

```bash
BASE_URL="https://your-app.example.com"

curl "$BASE_URL/api/health"
curl "$BASE_URL/ready"
curl "$BASE_URL/live"
```

Then validate:

- admin login and logout
- employee list
- attendance list
- salary record list
- dashboard backup list
- dashboard operational metrics

If LINE is enabled, also validate:

- LINE login
- LINE callback
- LINE webhook
- LINE clock-in flow

## Canary Monitoring Window

Keep the first public rollout narrow and monitor:

- admin login failure spikes
- invalid webhook signatures
- stale webhook events
- attendance list latency
- salary record list latency
- backup create, restore, and delete failures

Expand traffic only after the canary window stays stable.

## Release Sign-Off

Use this sign-off template in the release note or operator log:

- release candidate:
- operator:
- deployment time:
- `verify:release` result:
- `test:real-db` result:
- backup ID before rollout:
- canary cohort:
- canary observation window:
- go or no-go decision:
