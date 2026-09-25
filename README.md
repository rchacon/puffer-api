# Puffer Panic API

GraphQL API (AWS AppSync) for Puffer Panic. See [docs/architecture.md](docs/architecture.md)
for the data model and design decisions. Infrastructure (Terraform) lives in
[`puffer-infra`](https://github.com/rchacon/puffer-infra).

## Development

```
npm install
docker compose up -d
npm run create-table
npm test
npm run typecheck
npm run build   # bundles resolvers + zips the Lambdas into build/
```

The Lambdas and the GraphQL app (schema + resolvers) are versioned and deployed
independently — see [docs/architecture.md](docs/architecture.md#deployment-pipeline):

- `postconfirmation-v<version>` (matching `lambdas/postConfirmation/VERSION`)
  triggers `.github/workflows/deploy-postconfirmation.yml`.
- `progressprojector-v<version>` (matching `lambdas/progressProjector/VERSION`)
  triggers `.github/workflows/deploy-progressprojector.yml`.
- `graphql-v<version>` (matching `package.json`'s `version`) triggers
  `.github/workflows/deploy-graphql.yml`.
