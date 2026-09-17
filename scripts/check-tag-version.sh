#!/usr/bin/env bash
# Usage: check-tag-version.sh <tag-name> <tag-prefix> <package-json-path> [git-ref]
#
# Fails if the version implied by <tag-name> (after stripping <tag-prefix>)
# doesn't match the `version` field in <package-json-path> as of [git-ref]
# (defaults to HEAD). Mirrors cd-platform's check-tag-version.sh, adapted for
# package.json instead of pyproject.toml. When run as a GitHub Actions step,
# also emits `version=<tag-derived version>` to $GITHUB_OUTPUT so callers
# don't need to re-derive it themselves.
set -euo pipefail

tag_name="$1"
tag_prefix="$2"
package_json_path="$3"
git_ref="${4:-HEAD}"

tag_version="${tag_name#"$tag_prefix"}"
package_version=$(git show "${git_ref}:${package_json_path}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => { process.stdout.write(JSON.parse(input).version); });
')

if [ "$tag_version" != "$package_version" ]; then
  echo "error: tag '${tag_name}' implies version '${tag_version}', but ${package_json_path} (at ${git_ref}) has version '${package_version}'" >&2
  exit 1
fi

echo "OK: tag '${tag_name}' matches ${package_json_path}'s version '${package_version}'"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=${tag_version}" >> "$GITHUB_OUTPUT"
fi
