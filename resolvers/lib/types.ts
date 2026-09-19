import type { AppSyncIdentityCognito, Context } from '@aws-appsync/utils';

// "Empty object" -- Record<string, never> is a genuinely empty object type
// (any real property would need a value of type `never`, which no value can
// ever be); the plain `{}` most people reach for instead actually means "any
// non-null value" in TS's structural typing, not "no properties." Aliased
// here so it doesn't need explaining at every call site.
export type Empty = Record<string, never>;

// This API is Cognito User Pool-authorized only, so narrow the real (much
// wider) Context['identity'] union down to the one shape we actually get.
// TStash trails since it's never customized at any call site in this repo --
// trailing is what lets callers skip it and still reach TResult/TPrev, since
// TS generic parameters are positional, not named.
export type CognitoContext<
  TArgs = Empty,
  TResult = any,
  TPrev extends Record<string, any> | undefined = any,
  TStash extends Record<string, any> = Record<string, any>,
> = Omit<Context<TArgs, TStash, TPrev, undefined, TResult>, 'identity'> & {
  identity: AppSyncIdentityCognito;
};

// Mirrors the Parent type in schema.graphql.
export interface Parent {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

// Mirrors the Child type in schema.graphql.
export interface Child {
  id: string;
  parentId: string;
  name: string;
  avatar: string | null;
  birthday: string;
  createdAt: string;
}

// Mirrors the Activity enum in schema.graphql.
export type Activity = 'SIGHT_WORD';

// Mirrors the ChallengeType enum in schema.graphql.
export type ChallengeType = 'CHOOSE_FROM_BANK' | 'SPELL';

// Mirrors the Attempt type in schema.graphql.
export interface Attempt {
  id: string;
  childId: string;
  activity: Activity;
  target: string;
  challengeType: ChallengeType;
  correct: boolean;
  occurredAt: string;
  receivedAt: string;
}

// Mirrors the RecordAttemptInput input in schema.graphql.
export interface RecordAttemptInput {
  attemptId: string;
  childId: string;
  activity: Activity;
  target: string;
  challengeType: ChallengeType;
  selectedAnswer: string;
  presentedOptions?: string[] | null;
  occurredAt: string;
}

// Shape of an immutable attempt item as stored in DynamoDB (see attemptSk).
// `selectedAnswer`/`presentedOptions` are kept as evidence but aren't part of
// the GraphQL Attempt type.
export interface AttemptItem {
  PK: string;
  SK: string;
  id: string;
  childId: string;
  activity: Activity;
  target: string;
  challengeType: ChallengeType;
  selectedAnswer: string;
  presentedOptions?: string[];
  correct: boolean;
  occurredAt: string;
  receivedAt: string;
}

// Values findAttempt validates/derives once, for recordAttempt to reuse.
export type AttemptStash = { attempt: { sk: string; occurredAt: string; correct: boolean } };
