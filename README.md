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
npm run build   # bundles resolvers + zips the Lambda into build/
```

Releases (tag `v<version>` matching `package.json`, e.g. `v0.2.0`) trigger
`.github/workflows/deploy.yml`, which builds and deploys directly to AWS — see
[docs/architecture.md](docs/architecture.md#deployment-pipeline).
