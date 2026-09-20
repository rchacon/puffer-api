// `@aws-appsync/utils` ships only TypeScript types — `util` is an empty object at
// runtime, since real behavior only exists inside AppSync's managed JS runtime.
// This shim implements the handful of `util.*` functions our resolvers use, so
// resolver source (written the same way AWS's own docs and CDK bundling expect)
// can actually execute in Node against DynamoDB Local for tests. It is wired in
// only for tests via vitest.config.js's alias — deployed resolvers still resolve
// `util` to AppSync's real runtime implementation.
import { randomUUID } from 'node:crypto';
import { marshall } from '@aws-sdk/util-dynamodb';

export const util = {
  dynamodb: {
    toMapValues(obj) {
      return marshall(obj, { removeUndefinedValues: true });
    },
  },
  time: {
    nowISO8601() {
      return new Date().toISOString();
    },
    nowEpochMilliSeconds() {
      return Date.now();
    },
    parseISO8601ToEpochMilliSeconds(timestamp) {
      return Date.parse(timestamp);
    },
    epochMilliSecondsToISO8601(milliseconds) {
      return new Date(milliseconds).toISOString();
    },
  },
  autoId() {
    return randomUUID();
  },
  error(message, errorType) {
    const err = new Error(message);
    err.errorType = errorType;
    throw err;
  },
};

// runtime.earlyReturn(obj) in a function's request() skips the data source
// call and response(), making `obj` that function's result. Modeled here as a
// tagged throw that the pipeline harness catches (see dynamoResolverHarness.js).
export const runtime = {
  earlyReturn(obj) {
    const err = new Error('runtime.earlyReturn');
    err.earlyReturn = true;
    err.value = obj;
    throw err;
  },
};
