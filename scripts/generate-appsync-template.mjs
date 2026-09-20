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
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function functionLogicalId(name) {
  return `Function${pascalCase(name)}`;
}

// Functions first, so resolvers below can DependsOn / Fn::GetAtt them.
const resolversDir = join(BUILD_DIR, 'resolvers');
const functionsDir = join(resolversDir, 'functions');
if (existsSync(functionsDir)) {
  for (const file of readdirSync(functionsDir).filter((f) => f.endsWith('.js'))) {
    const name = basename(file, '.js');
    const logicalId = functionLogicalId(name);
    template.Resources[logicalId] = {
      Type: 'AWS::AppSync::FunctionConfiguration',
      DependsOn: 'GraphQLSchema',
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

for (const file of readdirSync(resolversDir).filter((f) => f.endsWith('.js'))) {
  const [typeName, fieldName] = basename(file, '.js').split('.');
  const logicalId = `Resolver${pascalCase(typeName)}${pascalCase(fieldName)}`;
  const filePath = join(resolversDir, file);
  const code = readFileSync(filePath, 'utf8');

  // A resolver whose module exports `pipelineFunctions` is a PIPELINE
  // resolver (see resolvers/Mutation.recordAttempt.ts for why) -- it
  // chains functions instead of talking to a data source directly.
  const mod = await import(pathToFileURL(resolve(filePath)).href);
  const pipelineFunctions = mod.pipelineFunctions;

  if (pipelineFunctions) {
    const functionLogicalIds = pipelineFunctions.map(functionLogicalId);
    template.Resources[logicalId] = {
      Type: 'AWS::AppSync::Resolver',
      // Not depending on the functions explicitly: PipelineConfig.Functions'
      // Fn::GetAtt references already create that dependency implicitly.
      DependsOn: 'GraphQLSchema',
      Properties: {
        ApiId: { Ref: 'ApiId' },
        TypeName: typeName,
        FieldName: fieldName,
        Kind: 'PIPELINE',
        Runtime: RUNTIME,
        Code: code,
        PipelineConfig: {
          Functions: functionLogicalIds.map((id) => ({ 'Fn::GetAtt': [id, 'FunctionId'] })),
        },
      },
    };
    console.log(`Added pipeline resolver ${typeName}.${fieldName} (${logicalId}) -> ${pipelineFunctions.join(' -> ')}`);
  } else {
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
        Code: code,
      },
    };
    console.log(`Added resolver ${typeName}.${fieldName} (${logicalId})`);
  }
}

const outPath = join(BUILD_DIR, 'appsync-template.json');
writeFileSync(outPath, JSON.stringify(template, null, 2));
console.log(`\nWrote ${outPath}`);
