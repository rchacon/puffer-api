import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    alias: {
      '@aws-appsync/utils': path.resolve(__dirname, 'test/appsyncUtilShim.js'),
    },
    env: {
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
    },
  },
});
