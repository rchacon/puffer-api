import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { TABLE_NAME as TableName } from '../lib/tableName.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

const client = new DynamoDBClient({
  endpoint,
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

export async function createTable() {
  try {
    await client.send(
      new CreateTableCommand({
        TableName,
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      })
    );
    console.log(`Created table ${TableName}`);
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      console.log(`Table ${TableName} already exists — skipping`);
      return;
    }
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createTable();
}
