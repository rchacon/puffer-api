# Architecture

GraphQL API (AWS AppSync) for Puffer Panic: parents sign in via Cognito, create
profiles for their kids, and each kid's practice attempts are recorded so a
(not yet built) parent portal can show which words a kid needs help with.

Terraform to provision the AWS resources described here lives in a separate repo,
[`rchacon/puffer-infra`](https://github.com/rchacon/puffer-infra) — this repo owns
the GraphQL schema, resolvers, and application Lambdas only.

## DynamoDB — single table

One table, generic `PK`/`SK`, no secondary indexes yet. The portal's status-filtered
progress query will need one (a `GSI1`), added together with the status-derivation
follow-up (see below).

| Item | PK | SK | Notes |
|---|---|---|---|
| Parent profile | `PARENT#<cognitoSub>` | `PROFILE` | `email`, `name`, `createdAt` |
| Child profile | `PARENT#<cognitoSub>` | `CHILD#<childId>` | `name`, `avatar`, `birthday`, `createdAt` — lives under the parent's partition so "parent + all children" is one `Query` |
| Attempt | `CHILD#<childId>` | `ATTEMPT#<activity>#<target>#<occurredAt>#<attemptId>` | Immutable. `activity`, `target`, `challengeType`, `selectedAnswer`, `presentedOptions` (choose types only), `correct`, `occurredAt`, `receivedAt` |

**Attempts are the source of truth.** Nothing about a child's progress is supplied by
the caller: `recordAttempt` stores what happened, and the server decides `correct` by
comparing `selectedAnswer` to `target` (case/whitespace-insensitive). Status
(`IN_PROGRESS`/`NEEDS_SUPPORT`/`MASTERED`) and attempt counts will be *derived* from
this history, so the rule can change later without losing the evidence behind any status.
Every attempt is kept, including the options presented, because the "close decoy"
algorithm may change.

- `activity` is `SIGHT_WORD` today; `target` is the thing practiced (the word itself
  for sight words). `ChallengeType` is `CHOOSE_FROM_BANK` (recognition) or `SPELL`
  (hard mode); more values can be added without breaking clients.
- The SK puts `<activity>#<target>` first so one target's full history (what the
  mastery rule needs) is a single `begins_with` `Query`. `occurredAt` is the client's
  time (canonical UTC ISO-8601, so it sorts chronologically) and `receivedAt` is the
  server's; `occurredAt` is rejected if more than 5 minutes in the future or 30 days
  old.
- **Idempotent retries:** the client supplies `attemptId` and `occurredAt`, so a retry
  maps to the same key. `findAttempt` reads that key first; if the attempt exists,
  `recordAttempt` returns it (`runtime.earlyReturn`) instead of writing, or raises
  `Conflict` if the same `attemptId` came back with a different answer. The write
  itself is conditional (`attribute_not_exists(PK)`) so a concurrent duplicate can't
  overwrite the stored attempt. `occurredAt` is rejected rather than clamped so the
  same request always yields the same key.
- `target` and `attemptId` can't contain `#` (the SK delimiter).
- **Trust model:** the client reports the `target`, so this blocks client-asserted
  mastery and client bugs, not a caller who knows the answer. Making correctness
  tamper-resistant would need a server-issued challenge flow (`startChallenge` stores
  the target and options; `submitAnswer` judges against them, with a server-assigned
  timestamp) — costing a round trip per question and offline play. Not planned for now.

**Deferred: derived progress.** A follow-up PR will derive status and attempt counts
from attempts into a rebuildable per-target summary item (with the `GSI1` keys it
introduces, and a `policyVersion` recording which rule produced it). Proposed mastery rule: three correct
`SPELL` attempts on three different days, the third at least a week after the first,
and the two most recent `SPELL` attempts correct; recognition attempts only inform
practice recommendations. Still to define: the `NEEDS_SUPPORT` rule and whether a
"day" is UTC or per-child time zone. Writing the summary atomically with the attempt
would need `TransactWriteItems`, which requires the table name inside resolver code —
resolvers only receive `ApiId`/`DataSourceName` today, so that follow-up has to decide
how to supply it (a template parameter, or a stream-driven projection instead).

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
their own parent/child items and their children's attempts:

- `Query.myProfile`, `Query.myChildren` — direct DynamoDB resolvers, scoped by using
  the caller's own `sub` as the partition key.
- `Mutation.createChildProfile` — direct resolver, writes under the caller's own
  parent partition.
- `Mutation.recordAttempt` — **pipeline** resolver: `functions/verifyChildOwnership.js`
  runs first and raises a `NotFound` error unless the given `childId` belongs to the
  caller, then `functions/findAttempt.js` validates the input and looks for an existing
  attempt with the same key, then `functions/recordAttempt.js` writes it (or returns the
  existing one). A single-step resolver can't check-then-act in one round trip, so
  ownership verification needs the extra pipeline function — otherwise a parent could
  pass another family's `childId` and write to their child's history. The resolver's own
  request handler copies `input.childId` into `ctx.stash.childId`, which
  `verifyChildOwnership` reads, since it can't know how each resolver nests `childId`.

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

The Lambda and the GraphQL app (schema + resolvers) are versioned and deployed
**independently** — different tag prefixes, different workflows, different deploy
mechanisms — because they have genuinely different change profiles and risk
shapes. Almost everything else (Cognito, DynamoDB, the AppSync API resource
itself, the Lambda's shell, the custom domain) is **managed by Terraform** in
`puffer-infra`, provisioned once and rarely touched again; these two pipelines
only ever push new *code* to what Terraform already created.

### `postconfirmation-v*` → `.github/workflows/deploy-postconfirmation.yml`

Matches `cd-platform`'s `cd-api-deploy.yml`/`cd-server-deploy.yml` convention
exactly: builds and deploys directly via an OIDC-assumed AWS role, no
CloudFormation. Chosen deliberately, not by default — this Lambda's scope is
narrow and stable (it only upserts a parent profile), so the added complexity of
a rolling/canary deploy (Lambda aliases + AWS CodeDeploy + CloudWatch alarms —
the actual AWS mechanism for gradual-traffic-shift-with-automatic-rollback,
which plain CloudFormation does *not* give you just by deploying a Lambda
through it) isn't justified here.

1. `scripts/check-tag-version.sh` checks the tag against
   `lambdas/postConfirmation/VERSION` (a bare version string, versioned
   independently of the GraphQL app's `package.json` version).
2. Tests + `tsc --noEmit` run again here (not just relying on `main` already
   being green), since a tag could in principle point at any commit.
3. `scripts/build.mjs` bundles the Lambda (CJS — the AWS SDK's CJS internals
   don't survive esbuild's ESM output without an interop shim) into
   `build/lambda/postConfirmation.zip`.
4. A sanity check imports the built bundle and confirms `handler` is a function,
   and a size check fails clearly if the zip would exceed Lambda's 50MB
   direct-upload limit — both mirror `cd-api-deploy.yml`'s equivalent steps.
5. `aws lambda update-function-code` + `aws lambda wait function-updated`,
   authenticated via an OIDC-assumed role (`vars.POSTCONFIRMATION_DEPLOY_ROLE_ARN`).

### `graphql-v*` → `.github/workflows/deploy-graphql.yml`

The schema + resolvers + pipeline functions are the one part of this system
that's a genuine multi-resource batch update on every release (N independent
resolvers/functions) — so it's the one part that actually benefits from
CloudFormation's rollback-on-partial-apply-failure. CDK was seriously considered
for this (to get that same rollback behavior) and dropped once it was clear the
need was this narrowly scoped — a generated template covers it without a second
IaC tool.

1. `scripts/check-tag-version.sh` checks the tag against `package.json`'s
   `version`.
2. Tests + `tsc --noEmit`, same as above.
3. `scripts/build.mjs` bundles each resolver (esbuild, `@aws-appsync/utils` kept
   external so it resolves to AppSync's real runtime at deploy time) into
   `build/resolvers/**/*.js`, and copies `schema.graphql`.
4. `scripts/generate-appsync-template.mjs` generates `build/appsync-template.json`
   — a CloudFormation template (JSON, not YAML: resolver code and the schema
   definition are arbitrary multi-line strings, and `JSON.stringify` escapes
   that unambiguously where hand-rolled YAML block scalars have real
   indentation/escaping edge cases) covering just `AWS::AppSync::GraphQLSchema`
   plus one `AWS::AppSync::Resolver` per built resolver file (addressed by
   `TypeName.fieldName`, read straight from each file's name — so adding a
   resolver needs no template-generation-code change) and one
   `AWS::AppSync::FunctionConfiguration` per pipeline function file. It takes
   `ApiId`/`DataSourceName` as plain template parameters — it never creates the
   AppSync API or data source itself, those are Terraform's. Being hand-built
   (plain object literals, no schema checking), a typo'd or missing property
   would otherwise only surface as a deploy-time AWS API error — `cfn-lint`
   validates the generated template against AWS's actual published resource
   specs before anything touches AWS, catching that class of mistake for free.
5. `aws cloudformation deploy` applies that template, authenticated via a
   separate OIDC-assumed role (`vars.GRAPHQL_DEPLOY_ROLE_ARN`).

Pipeline *resolvers* (as opposed to pipeline *functions*) — `recordAttempt` — are
`Kind: PIPELINE` in the generated template, not `UNIT`.
`generate-appsync-template.mjs` tells the two apart by dynamically importing each
built resolver module and checking for a `pipelineFunctions` export (e.g.
`resolvers/Mutation.recordAttempt.ts` exports `pipelineFunctions =
['verifyChildOwnership', 'findAttempt', 'recordAttempt']`) — present means `PIPELINE`, with
`PipelineConfig.Functions` built from `Fn::GetAtt`ing each named function's
`FunctionId` (no explicit `DependsOn` on those functions needed; the `Fn::GetAtt`
references already create that dependency implicitly — `cfn-lint` caught this
exact redundancy when it was first written with an explicit `DependsOn` too).
Absent means `UNIT`, wired directly to the data source as before.

### What Terraform needs to expose

For `postconfirmation-v*`: an OIDC-trusted role ARN (`lambda:UpdateFunctionCode`,
`lambda:GetFunction`) trusted for
`repo:rchacon/puffer-api:ref:refs/tags/postconfirmation-v*`, `AWS_REGION`, and
the Lambda's function name.

For `graphql-v*`: a separate OIDC-trusted role ARN (CloudFormation deploy
permissions for the generated stack, plus the `appsync:*` actions its resources
need) trusted for `repo:rchacon/puffer-api:ref:refs/tags/graphql-v*`, the
AppSync API ID, and the data source name.

## Local development & testing

- **DynamoDB**: `docker compose up` runs `amazon/dynamodb-local`, then
  `npm run create-table` creates the table against it.
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
