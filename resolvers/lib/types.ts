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

// Mirrors the WordStatus enum in schema.graphql.
export type WordStatus = 'IN_PROGRESS' | 'NEEDS_SUPPORT' | 'MASTERED';

// Mirrors the WordProgress type in schema.graphql.
export interface WordProgress {
  childId: string;
  word: string;
  status: WordStatus;
  attempts: number;
  lastPracticedAt: string;
}
