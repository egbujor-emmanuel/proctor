# PROCTOR sentinel

A Cloudflare Worker that runs PROCTOR's surprise re-tests on a schedule. A Cron Trigger (`17 * * * *`) wakes it every hour. Each tick:

1. reads every certificate from the registry (keyless NEAR RPC views);
2. expires any re-test whose OutLayer callback never came (`expire_sitting`), because a stuck re-test blocks its certificate;
3. with probability `CHANCE` (0.2), so the hours cannot be predicted, picks one live certificate uniformly at random and pays for its re-test (`retest`), signing from `proctor-sentinel.testnet` with near-api-js;
4. reads the verdict from the transaction's `sitting_resolved` event, and fails the invocation if the re-test ended without one.

The selection rules are the tested ones in [`../scripts/retest/pick.mjs`](../scripts/retest/pick.mjs), shared with the manual GitHub workflow. `GET /` reports the configuration and whether the Worker is armed. The full history is the sentinel account's transactions: https://testnet.near.rocks/account/proctor-sentinel.testnet

**Why a Worker.** GitHub Actions' `schedule` trigger never fired for this repository. That is a known problem with private repositories on the Free plan. Cloudflare's Cron Trigger was checked first with a two-minute schedule and fired on time.

## Run and test

```bash
npm ci
npm test            # 10 tests: planning, verdict parsing, a full tick against a faked chain
npm run typecheck

# Local, against testnet: put SENTINEL_PRIVATE_KEY=ed25519:... in .dev.vars (git-ignored)
npx wrangler dev --test-scheduled
curl "http://127.0.0.1:8787/__scheduled?cron=17+*+*+*+*"
```

## Deploy

```bash
npx wrangler deploy
npx wrangler secret put SENTINEL_PRIVATE_KEY    # the testnet key of proctor-sentinel.testnet
```
