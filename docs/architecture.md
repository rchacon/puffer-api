# Architecture

GraphQL API (AWS AppSync) for Puffer Panic: parents sign in via Cognito, create
profiles for their kids, and each kid's per-word learning progress is tracked so a
(not yet built) parent portal can show which words a kid needs help with.

Terraform to provision the AWS resources described here lives in a separate repo,
[`rchacon/puffer-infra`](https://github.com/rchacon/puffer-infra) — this repo owns
the GraphQL schema, resolvers, and application Lambdas only.

## DynamoDB — single table

One table, generic `PK`/`SK`, plus `GSI1` for the portal's status-filtered query.

| Item | PK | SK | Notes |
|---|---|---|---|
| Parent profile | `PARENT#<cognitoSub>` | `PROFILE` | `email`, `name`, `createdAt` |
| Child profile | `PARENT#<cognitoSub>` | `CHILD#<childId>` | `name`, `avatar`, `birthday`, `createdAt` — lives under the parent's partition so "parent + all children" is one `Query` |
| Word progress | `CHILD#<childId>` | `WORD#<word>` | `status` (`IN_PROGRESS`/`NEEDS_SUPPORT`/`MASTERED`), `attempts`, `lastPracticedAt` |

`GSI1PK = CHILD#<childId>`, `GSI1SK = STATUS#<status>#WORD#<word>` — only word-progress
items carry these attributes (a sparse index), letting the portal query "this kid's
words needing support" directly instead of scanning and filtering.

Why single-table with one item per word, instead of an embedded map on the child
item: a child's vocabulary can grow past what comfortably fits (and is efficiently
updatable) in one 400KB item, and the portal's core query — "words needing support"
— is a first-class access pattern that a GSI serves directly.

Deferred, not built for v1: rollup counters (e.g. `totalMastered`) on the child item
kept in sync via DynamoDB Streams, useful for a portal dashboard but unnecessary
while the portal is read-only and usage is small.

## Cognito

One User Pool shared by both apps (true SSO) with two App Clients: `game` and
`portal`. A **Post Confirmation** Lambda trigger (`lambdas/postConfirmation`) upserts
the `PARENT#<sub>/PROFILE` item on sign-up, keyed by the Cognito `sub` so it's
idempotent regardless of duplicate trigger invocations.

MFA / preventing a kid (who switched to their profile in the game) from reaching the
parent portal is **explicitly out of scope for v1** — the portal is read-only
initially. Revisit when paid plans or child-experience configuration ship in the
portal. At that point, native per-user Cognito MFA won't work as-is: the
MFA-required flag is per-user, not per-app-client, so enrolling a parent for portal
access would also start challenging them on the game. The two real options then are:
(a) app-layer step-up using Cognito's TOTP primitives
(`AssociateSoftwareToken`/`VerifySoftwareToken`) called directly by the portal
without ever setting the account-wide MFA flag, or (b) a custom Cognito auth flow
(`CUSTOM_AUTH` + `Define/Create/Verify Auth Challenge` triggers) that reads
`ClientMetadata` to inject an extra challenge only for the `portal` app client. Both
preserve single-password SSO across game and portal.

## GraphQL API (AppSync)

Cognito User Pool authorizer on the API (`schema.graphql`). Every resolver scopes by
the caller's Cognito `sub` from the identity context, so a parent can only read/write
their own parent/child/word items:

- `Query.myProfile`, `Query.myChildren` — direct DynamoDB resolvers, scoped by using
  the caller's own `sub` as the partition key.
- `Mutation.createChildProfile` — direct resolver, writes under the caller's own
  parent partition.
- `Query.childWordProgress`, `Mutation.recordWordAttempt` — **pipeline** resolvers:
  `functions/verifyChildOwnership.js` runs first and raises a `NotFound` error unless
  the given `childId` belongs to the caller, then `functions/queryChildWordProgress.js`
  or `functions/recordWordAttempt.js` runs the actual operation. A single-step
  resolver can't check-then-act in one round trip, so ownership verification needs
  the extra pipeline function — otherwise a parent could pass another family's
  `childId` and read or write their word-progress data.

Resolvers are TypeScript, using `import { util } from '@aws-appsync/utils'` — the
same pattern AWS's own docs and CDK bundling use, and typed against that package's
real `.d.ts` declarations (`Context`, `DynamoDBGetItemRequest`, etc. — see
`resolvers/lib/types.ts`). Note: the package ships only types (`util` is an empty
object outside AppSync's managed runtime); `scripts/build.mjs` bundles each resolver
with esbuild, keeping `@aws-appsync/utils` external so the bare import survives into
the built output for AppSync's runtime to resolve for real at deploy time — see
"Deployment pipeline" below. Locally, `test/appsyncUtilShim.js` implements just the
handful of `util.*` calls these resolvers use, wired in for tests only via
`vitest.config.js`'s alias.

## Deployment pipeline

`.github/workflows/deploy.yml`, triggered on pushing a `v*` tag, matching the
convention `cd-platform`'s `cd-api-deploy.yml`/`cd-server-deploy.yml` already use:
one workflow builds artifacts *and* deploys them directly, via an OIDC-assumed AWS
role — no GitHub Release, no artifact publishing, no Terraform-side version pin.
Terraform (`puffer-infra`) provisions the AppSync API/data source/Lambda/IAM role
*once*; this pipeline only ever pushes new code to what already exists:

1. `scripts/check-tag-version.sh` fails the run if the pushed tag doesn't match
   `package.json`'s `version` (mirrors `cd-platform`'s script, adapted from
   `pyproject.toml` to `package.json`).
2. Tests + `tsc --noEmit` run again here (not just relying on `main` already being
   green), since a tag could in principle point at any commit.
3. `scripts/build.mjs` bundles each resolver (esbuild, `@aws-appsync/utils` kept
   external) into `build/resolvers/**/*.js`, bundles+zips the Lambda (CJS — the AWS
   SDK's CJS internals don't survive esbuild's ESM output without an interop shim)
   into `build/lambda/postConfirmation.zip`, and copies `schema.graphql`.
4. A sanity check imports the built Lambda bundle and confirms `handler` is a
   function, and a size check fails clearly if the zip would exceed Lambda's 50MB
   direct-upload limit — both mirror `cd-api-deploy.yml`'s equivalent steps.
5. `aws-actions/configure-aws-credentials` assumes an OIDC-trusted role
   (`vars.PUFFER_API_DEPLOY_ROLE_ARN`), then:
   - `aws lambda update-function-code` deploys the Lambda directly.
   - `scripts/deploy-appsync.sh` deploys the schema (`start-schema-creation`, polled
     via `get-schema-creation-status`) and every unit resolver
     (`aws appsync update-resolver`, addressed by `TypeName.fieldName` read straight
     from each built file's name) and pipeline function (`aws appsync
     update-function`, addressed by a `functionId` looked up via `list-functions`
     since AppSync assigns those, not us).

Not yet handled: pipeline *resolvers* (as opposed to pipeline *functions*) — this
repo doesn't have any yet, since word-progress (which needs
`childWordProgress`/`recordWordAttempt` as pipeline resolvers) is still on a
separate, unmerged branch. `deploy-appsync.sh` has a note marking where to add
`--kind PIPELINE --pipeline-config functions=<id1>,<id2>` handling when that lands.

This means `puffer-infra`'s Terraform needs to expose, as GitHub Actions repository
variables on `puffer-api`: an OIDC-trusted IAM role ARN (permissions:
`lambda:UpdateFunctionCode`, `lambda:GetFunction`, `appsync:StartSchemaCreation`,
`appsync:GetSchemaCreationStatus`, `appsync:UpdateResolver`, `appsync:UpdateFunction`,
`appsync:ListFunctions`) trusting `repo:rchacon/puffer-api:ref:refs/tags/v*`, plus the
AWS region, the Lambda's function name, the AppSync API ID, and the data source name.

## Local development & testing

- **DynamoDB**: `docker compose up` runs `amazon/dynamodb-local`, then
  `npm run create-table` creates the table + GSI1 against it.
- **Resolver/schema logic**: `npm test` runs `test/resolvers.test.js` and
  `lambdas/postConfirmation/index.test.js` against the real Dockerized DynamoDB via
  `test/dynamoResolverHarness.js`, which executes each resolver's `request()` output
  as a real DynamoDB call and feeds the (unmarshalled) response back into
  `response()` — so tests exercise actual read/write behavior, not mocked SDK calls.
- **CI**: `.github/workflows/test.yml` runs the same suite against a
  `dynamodb-local` GitHub Actions service container on every push/PR, so local and CI
  runs exercise identical DynamoDB behavior.
- **AppSync & Cognito**: no solid open-source Docker/LocalStack story exists for
  these (LocalStack's coverage is Pro-only) — end-to-end checks of AppSync's own
  request/response mapping and Cognito authorization happen against a real, cheap
  on-demand `dev` AWS stack instead.
