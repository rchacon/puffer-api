import type { AppSyncIdentityCognito, Context } from '@aws-appsync/utils';

// This API is Cognito User Pool-authorized only, so narrow the real (much
// wider) Context['identity'] union down to the one shape we actually get.
export type CognitoContext<
  TArgs = Record<string, never>,
  TStash extends Record<string, any> = Record<string, any>,
  TResult = any,
  TPrev extends Record<string, any> | undefined = any,
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
