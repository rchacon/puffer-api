import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME ?? 'PufferPanicTable';

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

// Executes the DynamoDB request object an AppSync JS resolver's request() returns
// against a real DynamoDB table, and shapes the raw response the way AppSync would
// before handing it to the resolver's response() as ctx.result.
async function executeDynamoDbRequest(op) {
  switch (op.operation) {
    case 'GetItem': {
      const { Item } = await client.send(
        new GetItemCommand({ TableName: TABLE_NAME, Key: op.key })
      );
      return Item ? unmarshall(Item) : null;
    }
    case 'PutItem': {
      await client.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: { ...op.key, ...op.attributeValues },
          ...(op.condition && {
            ConditionExpression: op.condition.expression,
            ExpressionAttributeValues: op.condition.expressionValues,
          }),
        })
      );
      return unmarshall({ ...op.key, ...op.attributeValues });
    }
    case 'UpdateItem': {
      const { Attributes } = await client.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: op.key,
          UpdateExpression: op.update.expression,
          ExpressionAttributeValues: op.update.expressionValues,
          ExpressionAttributeNames: op.update.expressionNames,
          ReturnValues: 'ALL_NEW',
        })
      );
      return unmarshall(Attributes);
    }
    case 'Query': {
      const { Items } = await client.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: op.index,
          KeyConditionExpression: op.query.expression,
          ExpressionAttributeValues: op.query.expressionValues,
          ExpressionAttributeNames: op.query.expressionNames,
        })
      );
      return { items: (Items ?? []).map(unmarshall) };
    }
    default:
      throw new Error(`Unsupported operation in test harness: ${op.operation}`);
  }
}

// Runs a single (non-pipeline) resolver module's request/response against real DynamoDB.
export async function runUnitResolver(resolverModule, ctx) {
  ctx.stash ??= {};
  const op = resolverModule.request(ctx);
  ctx.result = await executeDynamoDbRequest(op);
  return resolverModule.response(ctx);
}

// Runs an ordered list of resolver function modules as an AppSync pipeline resolver:
// each function's response() output becomes ctx.prev.result for the next function.
export async function runPipelineResolver(functionModules, ctx) {
  ctx.stash ??= {};
  ctx.prev = { result: null };
  for (const fn of functionModules) {
    const op = fn.request(ctx);
    ctx.result = await executeDynamoDbRequest(op);
    ctx.prev = { result: fn.response(ctx) };
  }
  return ctx.prev.result;
}

export { TABLE_NAME, client as dynamoClient, marshall, unmarshall };
