#!/bin/sh
# Hardening item B6: a fork can delete the example modules (Document, Jobs and
# the document-processing workflow) and still build, lint and pass. Runs in a
# temporary copy; the working tree is never touched. FORKING.md describes the
# same steps for a real fork.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/n2f-fork.XXXXXX")
trap 'rm -rf "$work"' EXIT

rsync -a --exclude .git --exclude node_modules --exclude dist --exclude reports \
  --exclude .stryker-tmp --exclude coverage "$root/" "$work/"
ln -s "$root/node_modules" "$work/node_modules"
cd "$work"

echo "Deleting the example modules in $work"
rm -rf src/modules/document src/modules/jobs src/workflows/document-processing \
  src/integration/document-access.ts src/integration/jobs-access.ts \
  test/document-processing.integration.spec.ts \
  test/document-tenant-isolation.integration.spec.ts \
  test/contracts/job-events.contract.spec.ts

# Composition lines that wire the examples end in an `example` marker.
grep -rlE '(//|#) example$' src Makefile | while IFS= read -r file; do
  sed -e '/\/\/ example$/d' -e '/# example$/d' "$file" > "$file.fork"
  mv "$file.fork" "$file"
done

if grep -rnE "modules/(document|jobs)/|workflows/document-processing" src test; then
  echo "Code outside the examples still imports them (above)." >&2
  exit 1
fi

make check test-memory
echo "Fork without the example modules: build, lint, unit and in-memory suites pass."
