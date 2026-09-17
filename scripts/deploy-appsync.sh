#!/usr/bin/env bash
# Deploys build/schema.graphql and every build/resolvers/**/*.js file directly
# to an existing AppSync API via the AWS CLI -- no Terraform involved. Terraform
# (puffer-infra) provisions the API/data source/IAM role once; this script
# just pushes code to what already exists, every tagged release.
#
# Requires env vars: APPSYNC_API_ID, APPSYNC_DATA_SOURCE_NAME. AWS credentials
# must already be configured (e.g. via aws-actions/configure-aws-credentials).
#
# Unit resolvers (build/resolvers/*.js) are addressed by TypeName.fieldName,
# read straight from the filename -- matches this repo's naming convention
# (see resolvers/Query.myChildren.ts etc.), so adding a new resolver file
# needs no change here. Pipeline functions (build/resolvers/functions/*.js)
# are addressed by AppSync's own generated functionId, looked up by name.
#
# NOTE: pipeline *resolvers* (a resolver that runs a sequence of functions,
# e.g. what childWordProgress/recordWordAttempt need) aren't handled here yet
# -- this repo doesn't have any yet (word-progress is still on a separate
# unmerged branch). Those need --kind PIPELINE --pipeline-config
# functions=<id1>,<id2> instead of --kind UNIT, and no --data-source-name.
# Extend the unit-resolver loop below when that branch lands.
set -euo pipefail

: "${APPSYNC_API_ID:?APPSYNC_API_ID must be set}"
: "${APPSYNC_DATA_SOURCE_NAME:?APPSYNC_DATA_SOURCE_NAME must be set}"

RUNTIME="name=APPSYNC_JS,runtimeVersion=1.0.0"

echo "== Schema =="
aws appsync start-schema-creation \
  --api-id "$APPSYNC_API_ID" \
  --definition fileb://build/schema.graphql >/dev/null

for _ in $(seq 1 30); do
  status=$(aws appsync get-schema-creation-status --api-id "$APPSYNC_API_ID" --query status --output text)
  echo "schema status: $status"
  case "$status" in
    SUCCESS) break ;;
    FAILED|ACTIVE_FAILED)
      aws appsync get-schema-creation-status --api-id "$APPSYNC_API_ID" --query details --output text >&2
      echo "::error::schema creation failed ($status)" >&2
      exit 1
      ;;
    *) sleep 2 ;;
  esac
done

echo "== Unit resolvers =="
for file in build/resolvers/*.js; do
  [ -e "$file" ] || continue
  base=$(basename "$file" .js)
  type_name="${base%%.*}"
  field_name="${base#*.}"
  echo "Updating resolver ${type_name}.${field_name}"
  aws appsync update-resolver \
    --api-id "$APPSYNC_API_ID" \
    --type-name "$type_name" \
    --field-name "$field_name" \
    --data-source-name "$APPSYNC_DATA_SOURCE_NAME" \
    --kind UNIT \
    --runtime "$RUNTIME" \
    --code "fileb://$file" >/dev/null
done

if [ -d build/resolvers/functions ]; then
  echo "== Pipeline functions =="
  for file in build/resolvers/functions/*.js; do
    [ -e "$file" ] || continue
    name=$(basename "$file" .js)
    function_id=$(aws appsync list-functions --api-id "$APPSYNC_API_ID" \
      --query "functions[?name=='${name}'].functionId | [0]" --output text)
    if [ -z "$function_id" ] || [ "$function_id" = "None" ]; then
      echo "::error::no existing AppSync function named '${name}' -- create it in Terraform first, this script only updates code" >&2
      exit 1
    fi
    echo "Updating function ${name} (${function_id})"
    aws appsync update-function \
      --api-id "$APPSYNC_API_ID" \
      --function-id "$function_id" \
      --name "$name" \
      --data-source-name "$APPSYNC_DATA_SOURCE_NAME" \
      --function-version 2018-05-29 \
      --runtime "$RUNTIME" \
      --code "fileb://$file" >/dev/null
  done
fi

echo "AppSync deploy complete"
