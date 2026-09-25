# Architecture

GraphQL API (AWS AppSync) for Puffer Panic: parents sign in via Cognito, create
profiles for their kids, and each kid's practice attempts are recorded so a
(not yet built) parent portal can show which words a kid needs help with.

Terraform to provision the AWS resources described here lives in a separate repo,
[`rchacon/puffer-infra`](https://github.com/rchacon/puffer-infra) — this repo owns
the GraphQL schema, resolvers, and application Lambdas only.

## DynamoDB — single table

One table, generic `PK`/`SK`, plus `GSI1` (`GSI1PK`/`GSI1SK`). Only some items carry the
`GSI1` attributes (a sparse index): attempts, so one target's history is a single `Query`,
and — once progress is derived — progress summaries, so the portal can filter by status.

| Item | PK | SK | Notes |
|---|---|---|---|
| Parent profile | `PARENT#<cognitoSub>` | `PROFILE` | `email`, `name`, `createdAt` |
| Child profile | `PARENT#<cognitoSub>` | `CHILD#<childId>` | `name`, `avatar`, `birthday`, `createdAt` — lives under the parent's partition so "parent + all children" is one `Query` |
| Attempt | `CHILD#<childId>` | `ATTEMPT#<attemptId>` | Immutable. `activity`, `target`, `challengeType`, `answer`, `presentedOptions` (multiple choice only), `correct`, `occurredAt`, `receivedAt`. `GSI1PK = CHILD#<childId>#ACTIVITY#<activity>#TARGET#<target>`, `GSI1SK = <occurredAt>#<attemptId>` |
| Progress summary | `CHILD#<childId>` | `PROGRESS#<activity>#<target>` | Derived, rebuildable. `status`, `attemptCount`, `lastPracticedAt`, `lastAttemptKey`, `policyVersion`. `GSI1PK = CHILD#<childId>#ACTIVITY#<activity>`, `GSI1SK = STATUS#<status>#TARGET#<target>` |

**Attempts are the source of truth.** Nothing about a child's progress is supplied by
the caller: `recordAttempt` stores what happened, and the server decides `correct` by
comparing `answer` to `target` (case/whitespace-insensitive). Status
(`IN_PROGRESS`/`NEEDS_SUPPORT`/`MASTERED`) and attempt counts will be *derived* from
this history, so the rule can change later without losing the evidence behind any status.
Every attempt is kept, including the options presented, because the "close decoy"
algorithm may change.

- `activity` is `SIGHT_WORD` today; `target` is the thing practiced (the word itself
  for sight words). `ChallengeType` is `MULTIPLE_CHOICE` (recognition) or `SPELL`
  (hard mode); more values can be added without breaking clients.
- `occurredAt` is the client's time (canonical UTC ISO-8601, so it sorts chronologically)
  and `receivedAt` is the server's; `occurredAt` is rejected if more than 5 minutes in the
  future or 30 days old (rejected rather than clamped, so a bad clock is visible to the
  client instead of silently rewriting the history).
- One target's full history (what progress derivation needs) is a single `Query` on
  `GSI1` with `GSI1PK = CHILD#<childId>#ACTIVITY#<activity>#TARGET#<target>`, in
  chronological order. GSI reads are eventually consistent.
- **Idempotent retries:** `attemptId` is the attempt's identity and its only idempotency
  key (the sort key is `ATTEMPT#<attemptId>`). `prepareAttempt` reads that key first; if
  the attempt exists, `recordAttempt` returns it (`runtime.earlyReturn`) instead of
  writing, ignoring the retry's `occurredAt` — the stored attempt keeps its original time,
  and this holds even if that timestamp has since aged out of the accepted window (the
  window is only checked for a new attempt). It raises `Conflict` if the same `attemptId`
  came back with a different activity, target, challenge type, answer or
  `presentedOptions`. The write itself is conditional (`attribute_not_exists(PK)`) so a
  concurrent duplicate can't overwrite the stored attempt. Clients should generate
  `attemptId` once, when the child answers, and reuse it for every retry.
- `target` is trimmed and lowercased before it is keyed, stored or returned (the same form
  `correct` is judged on), so `Cat`, `cat` and ` cat ` share one history; it must be non-empty
  after trimming. `target` and `attemptId` can't contain `#` (the delimiter in the keys built from them).
- **Trust model:** the client reports the `target`, so this blocks client-asserted
  mastery and client bugs, not a caller who knows the answer. Making correctness
  tamper-resistant would need a server-issued challenge flow (`startChallenge` stores
  the target and options; `submitAnswer` judges against them, with a server-assigned
  timestamp) — costing a round trip per question and offline play. Not planned for now.

### Derived progress

Status and counts are a *projection* of the attempts, never supplied by a caller. A
**progress projector** Lambda (`lambdas/progressProjector`) consumes the table's
DynamoDB Stream. For each newly inserted attempt it reads that target's history from
`GSI1`, merges in the attempts in its own batch (GSI reads are eventually consistent, so
the index may not have the newest one yet), runs `deriveProgress`
(`lambdas/progressProjector/derive.ts`) and overwrites the target's progress summary.
Because it recomputes every derived field from the full history rather than
incrementing, replays just rewrite the same values. It ignores everything but
inserts of `ATTEMPT#` items, including the summaries it writes itself.

**Concurrent writers.** Two writers can race on the same target's summary -- most
plausibly a manual rebuild (see below) running against a child who's actively
playing, since a rebuild sits outside the stream's per-shard ordering. Each summary
carries `lastAttemptKey` (the most recent attempt folded into it, `<occurredAt>#<id>`),
and the write is conditioned on it: a writer computed from older or smaller data than
what's already stored loses the race harmlessly (its `PutItem` is rejected, silently,
rather than clobbering the fresher summary). A tie is allowed through rather than
rejected, so a rebuild re-deriving the *same* attempts under a bumped `POLICY_VERSION`
can still overwrite the summary it's meant to correct.

**Rules (policy version 1)**, all in `derive.ts`, kept apart so they can change:

- `MASTERED`: correct `SPELL` attempts on at least three different **UTC days**, the
  earliest and latest at least seven days apart, and the two most recent `SPELL`
  attempts both correct. Recognition (`MULTIPLE_CHOICE`) attempts never establish
  mastery, so they can't push a word to `MASTERED`, but they still count as attempts.
  A later wrong spelling loses mastery.
- `NEEDS_SUPPORT`: not mastered, and at least two of the last three attempts (any
  challenge type) were wrong. It clears itself as the child improves.
- Otherwise `IN_PROGRESS`.

**Changing the rules.** Edit `derive.ts` and bump `POLICY_VERSION`, deploy, then rebuild
from the attempts by invoking the Lambda with `{"rebuild":{"childId":"<id>"}}` (one
child) or `{"rebuild":{}}` (every child; a table `Scan`, fine at this scale). Nothing in
a summary is authoritative — `policyVersion` records which rule produced it.

**Why a stream projector, not a resolver.** Writing the summary in the same request as
the attempt would need `TransactWriteItems`, which requires the table name inside
resolver code — resolvers only receive `ApiId`/`DataSourceName`. A projector keeps the
attempt write a single atomic conditional `PutItem`, owns the rebuild path, and needs
no table name in the resolvers. The cost is that progress **trails** attempts by a
moment (`childProgress` may not yet reflect an attempt recorded a second ago).

Known limits: `childProgress` returns one page of results (no pagination yet), which
is ample for a child's word list; and "day" is UTC, so an evening attempt in a western
time zone can land on the next UTC day.

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
- `Query.childProgress(childId, activity, status)` — **pipeline** resolver
  (`verifyChildOwnership` → `queryChildProgress`): lists a child's derived progress for
  an activity from `GSI1`, optionally for one status. Results come back grouped by
  status, then target.
- `Mutation.recordAttempt` — **pipeline** resolver: `functions/verifyChildOwnership.js`
  runs first and raises a `NotFound` error unless the given `childId` belongs to the
  caller, then `functions/prepareAttempt.js` validates the input and looks for an existing
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
['verifyChildOwnership', 'prepareAttempt', 'recordAttempt']`) — present means `PIPELINE`, with
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

For `progressprojector-v*`: the same shape as `postconfirmation-v*` (an OIDC-trusted role
ARN with `lambda:UpdateFunctionCode`/`lambda:GetFunction`, trusted for
`repo:rchacon/puffer-api:ref:refs/tags/progressprojector-v*`, and the function name in
`vars.PROGRESS_PROJECTOR_FUNCTION_NAME`).

For `graphql-v*`: a separate OIDC-trusted role ARN (CloudFormation deploy
permissions for the generated stack, plus the `appsync:*` actions its resources
need) trusted for `repo:rchacon/puffer-api:ref:refs/tags/graphql-v*`, the
AppSync API ID, and the data source name.

### What `puffer-infra` needs for derived progress

Nothing here is deployed by this repo; the Terraform in `puffer-infra` must provide:

- `GSI1` on the table: partition key `GSI1PK` (S), sort key `GSI1SK` (S), projecting all
  attributes. (`npm run create-table` creates it locally.)
- A DynamoDB Stream on the table with `NEW_IMAGE`.
- The `progressProjector` Lambda (Node 20, handler `index.handler`, `TABLE_NAME` set to
  the table name) with an event source mapping on that stream: `ReportBatchItemFailures`
  enabled, and a filter so it only sees inserted attempts, e.g.
  `{"eventName":["INSERT"],"dynamodb":{"NewImage":{"SK":{"S":[{"prefix":"ATTEMPT#"}]}}}}`.
  (The Lambda re-checks this itself, so the filter is an optimization, but without it the
  summaries it writes would each trigger an invocation.)
- Its IAM role: stream read (`dynamodb:GetRecords`, `GetShardIterator`, `DescribeStream`,
  `ListStreams`), `dynamodb:Query` on the table and `index/GSI1`, `dynamodb:PutItem`, and
  `dynamodb:Scan` (only for the all-children rebuild).
- The AppSync data source role must be able to `dynamodb:Query` the `index/GSI1` (for
  `childProgress`), in addition to the item access it already has.

## Local development & testing

- **DynamoDB**: `docker compose up` runs `amazon/dynamodb-local`, then
  `npm run create-table` creates the table against it.
- **Resolver/schema logic**: `npm test` runs `test/resolvers.test.js`,
  `lambdas/postConfirmation/index.test.js` and `lambdas/progressProjector/*.test.js`
  against the real Dockerized DynamoDB via
  `test/dynamoResolverHarness.js`, which executes each resolver's `request()` output
  as a real DynamoDB call and feeds the (unmarshalled) response back into
  `response()` — so tests exercise actual read/write behavior, not mocked SDK calls.
- **CI**: `.github/workflows/test.yml` runs the same suite against a
  `dynamodb-local` GitHub Actions service container on every push/PR, so local and CI
  runs exercise identical DynamoDB behavior.
- **Streams**: the projector's tests call its handler with stream records built from
  stored items, so the DynamoDB Stream → Lambda wiring itself (event source mapping,
  filter, batch-failure reporting) is only exercised against a real `dev` stack.
- **AppSync & Cognito**: no solid open-source Docker/LocalStack story exists for
  these (LocalStack's coverage is Pro-only) — end-to-end checks of AppSync's own
  request/response mapping and Cognito authorization happen against a real, cheap
  on-demand `dev` AWS stack instead.
