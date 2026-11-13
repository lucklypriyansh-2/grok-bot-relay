# Contributing

Thanks for helping improve grok-bot-relay.

## Setup

```bash
npm ci
npm run build
npm test
```

Please keep the suite green. Add or update tests alongside behavior changes.

## Secrets and personal data

Do not commit webhook URLs, webhook keys, results tokens, env files, tunnel
URLs, logs, or result JSON. Keep examples as placeholders such as
`https://example.invalid/...` and `YOUR_WEBHOOK_KEY`.

The unit tests use a mock webhook and never call a real routine. Do not add
live credentials to tests. Tests must be hermetic: use `isolatedEnv()` from
`tests/test-env.ts` and never spread `process.env` into a child or `createRelay`
call. Otherwise a developer’s `GROK_RELAY_RESULTS_URL` can make tests write
into a live tasks folder or hit a real webhook.

## Style

TypeScript is strict. The webhook client and results server must not log or
raise errors that include URLs, keys, tokens, or response bodies. If you
change error handling, add a test that the secret does not appear in output.

## Pull requests

Open a pull request with a short description of the change and why it is
needed. Keep unrelated refactors out of the same PR.
