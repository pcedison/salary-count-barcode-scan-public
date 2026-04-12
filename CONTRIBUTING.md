# Contributing

`barcode_scan_V3` is a public infrastructure and business application. Contributions should improve reliability, operator clarity, and security without reintroducing secrets or private operational details.

## Before You Start

Read the current public-release docs first:

- [README.md](README.md)
- [SECURITY.md](SECURITY.md)
- [docs/PUBLIC_RELEASE_CHECKLIST.md](docs/PUBLIC_RELEASE_CHECKLIST.md)
- [docs/OPERATOR_RELEASE_READINESS.md](docs/OPERATOR_RELEASE_READINESS.md)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- [docs/PUBLIC_REPO_HARDENING_PLAN.md](docs/PUBLIC_REPO_HARDENING_PLAN.md)

## Local Setup

Use Node 20.x and npm 10.x.

```bash
npm install
npm run db:push
npm run dev
```

Minimum local environment variables:

```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgresql://<db-user>:<db-password>@db.example.test:5432/<db-name>
SESSION_SECRET=replace-with-at-least-32-characters
```

## Verification

Run the lightest check that matches the size of the change.

```bash
git diff --check
npm run check
npm test
npm run test:smoke
npm run verify:release
```

Use `npm run test:real-db` when your change touches persistence, migration behavior, restore flow, or any operator-facing database path.

## Version Workflow

`package.json` is the source of truth for application versioning. The release workflow keeps the footer, health metadata, and package version aligned.

Choose the version bump based on the actual impact of the change:

- `patch` for small fixes, docs, and narrowly scoped behavior corrections
- `minor` for additive features, new operator tooling, or broader but compatible workflow changes
- `major` for incompatible behavior, contract changes, or wide architectural shifts

Before applying a bump, inspect the suggestion:

```bash
npm run version:preview
```

Apply the reviewed bump only after confirming the release scope:

```bash
npm run version:auto
```

Do not hand-edit version numbers unless a maintainer has explicitly asked for a manual override.

## Secret Handling

Never commit or paste:

- `.env` files
- production database URLs
- LINE channel secrets or tokens
- session secrets
- backup archives
- employee or customer data dumps
- plaintext `SUPER_ADMIN_PIN` values for production

Use the built-in helpers instead of ad hoc scripts:

```bash
npm run secrets:generate
npm run super-pin:hash -- --raw 123456
```

If a secret may have leaked, report it privately and rotate it before merging anything else.

## Pull Request Expectations

Keep each PR focused on one change set. A good PR should include:

- a short summary of the problem and the fix
- the commands you ran
- any release-readiness impact
- any config, runtime, or deployment change
- any security or privacy impact

When behavior changes, update the relevant docs in the same PR. When tests are not run, say why.

## Review Checklist

Before asking for review, confirm:

- `git diff --check` passes
- tests relevant to the change pass
- public docs still match the code
- no secrets, personal data, or internal-only paths were added
- the version bump matches the size of the change

## Merge Discipline

Prefer small, reviewable changes. If a change affects production behavior, deployment settings, or public documentation, call that out in the PR description so operators can review it with the right context.
