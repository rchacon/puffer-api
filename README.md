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
```
