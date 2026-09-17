#!/usr/bin/env bash
# Usage: check-tag-version.sh <tag-name> <tag-prefix> <version-file-path> [git-ref]
#
# Fails if the version implied by <tag-name> (after stripping <tag-prefix>)
# doesn't match the version recorded in <version-file-path> as of [git-ref]
# (defaults to HEAD). Mirrors cd-platform's check-tag-version.sh, generalized
# to two version-file shapes so it covers both of puffer-api's independently
# versioned components: package.json's "version" field (the GraphQL app) and
# a bare VERSION file (the postConfirmation Lambda). When run as a GitHub
# Actions step, also emits `version=<tag-derived version>` to $GITHUB_OUTPUT
# so callers don't need to re-derive it themselves.
set -euo pipefail

tag_name="$1"
tag_prefix="$2"
version_file_path="$3"
git_ref="${4:-HEAD}"

tag_version="${tag_name#"$tag_prefix"}"
raw_content=$(git show "${git_ref}:${version_file_path}")

if [[ "$version_file_path" == *.json ]]; then
  recorded_version=$(echo "$raw_content" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => { process.stdout.write(JSON.parse(input).version); });
  ')
else
  recorded_version=$(echo "$raw_content" | tr -d '[:space:]')
fi

if [ "$tag_version" != "$recorded_version" ]; then
  echo "error: tag '${tag_name}' implies version '${tag_version}', but ${version_file_path} (at ${git_ref}) has version '${recorded_version}'" >&2
  exit 1
fi

echo "OK: tag '${tag_name}' matches ${version_file_path}'s version '${recorded_version}'"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=${tag_version}" >> "$GITHUB_OUTPUT"
fi
