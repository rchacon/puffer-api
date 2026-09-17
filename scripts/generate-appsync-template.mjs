// Generates build/appsync-template.json, a CloudFormation template covering
// just the schema + resolvers + pipeline functions -- the one part of this
// system that's a genuine multi-resource batch update (N independent
// AppSync API calls on every release), so it's the one part that benefits
// from a real deploy mechanism with rollback-on-partial-failure. Everything
// else (Cognito, DynamoDB, the AppSync API itself, its data source, the
// Lambda) is managed by Terraform in puffer-infra and referenced here only
// by ID, via the ApiId/DataSourceName parameters.
//
// JSON, not YAML: resolver code and the schema definition are arbitrary
// multi-line strings (backticks, quotes, '#' characters in DynamoDB key
// literals) -- JSON.stringify escapes all of that unambiguously, where
// hand-rolled YAML block scalars have real indentation/escaping edge cases.
// CloudFormation accepts JSON templates identically to YAML ones.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const BUILD_DIR = 'build';
const RUNTIME = { Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' };

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'puffer-api GraphQL schema + resolvers + pipeline functions (generated -- see scripts/generate-appsync-template.mjs)',
  Parameters: {
    ApiId: { Type: 'String', Description: 'Existing AppSync API ID (Terraform-managed)' },
    DataSourceName: { Type: 'String', Description: 'Existing AppSync DynamoDB data source name (Terraform-managed)' },
  },
  Resources: {
    GraphQLSchema: {
      Type: 'AWS::AppSync::GraphQLSchema',
      Properties: {
        ApiId: { Ref: 'ApiId' },
        Definition: readFileSync(join(BUILD_DIR, 'schema.graphql'), 'utf8'),
      },
    },
  },
};

function pascalCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const resolversDir = join(BUILD_DIR, 'resolvers');
for (const file of readdirSync(resolversDir).filter((f) => f.endsWith('.js'))) {
  const [typeName, fieldName] = basename(file, '.js').split('.');
  const logicalId = `Resolver${pascalCase(typeName)}${pascalCase(fieldName)}`;
  template.Resources[logicalId] = {
    Type: 'AWS::AppSync::Resolver',
    DependsOn: 'GraphQLSchema',
    Properties: {
      ApiId: { Ref: 'ApiId' },
      TypeName: typeName,
      FieldName: fieldName,
      DataSourceName: { Ref: 'DataSourceName' },
      Kind: 'UNIT',
      Runtime: RUNTIME,
      Code: readFileSync(join(resolversDir, file), 'utf8'),
    },
  };
  console.log(`Added resolver ${typeName}.${fieldName} (${logicalId})`);
}

const functionsDir = join(resolversDir, 'functions');
if (existsSync(functionsDir)) {
  for (const file of readdirSync(functionsDir).filter((f) => f.endsWith('.js'))) {
    const name = basename(file, '.js');
    const logicalId = `Function${pascalCase(name)}`;
    template.Resources[logicalId] = {
      Type: 'AWS::AppSync::FunctionConfiguration',
      Properties: {
        ApiId: { Ref: 'ApiId' },
        Name: name,
        DataSourceName: { Ref: 'DataSourceName' },
        FunctionVersion: '2018-05-29',
        Runtime: RUNTIME,
        Code: readFileSync(join(functionsDir, file), 'utf8'),
      },
    };
    console.log(`Added pipeline function ${name} (${logicalId})`);
  }
}

const outPath = join(BUILD_DIR, 'appsync-template.json');
writeFileSync(outPath, JSON.stringify(template, null, 2));
console.log(`\nWrote ${outPath}`);
