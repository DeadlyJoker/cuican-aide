import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/server-release.yml", import.meta.url),
  "utf8",
);

test("server release binds trusted checks and least-privilege publication", () => {
  assert.match(workflow, /tags: \["server-v\*"\]/u);
  assert.match(workflow, /permissions: \{\}/u);
  assert.match(workflow, /checks: read/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /packages: write/u);
  assert.match(workflow, /verify-release-checks/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /git ls-remote --refs origin/u);
  assert.match(workflow, /Revalidate PostgreSQL production Workflow recovery/u);
  assert.match(workflow, /postgres:16-alpine@sha256:[a-f0-9]{64}/u);
  assert.match(workflow, /postgres-store-contract-gate\.mjs/u);
  assert.match(workflow, /pnpm production:postgres-smoke/u);
  assert.match(workflow, /needs: \[trust, postgres-production-workflow\]/u);
  const actions = [
    ...workflow.matchAll(/^\s*- uses: ([^\s]+)(?:\s+#.*)?$/gmu),
  ].map((match) => match[1]);
  assert.equal(actions.length, 8);
  for (const action of actions) assert.match(action, /@[a-f0-9]{40}$/u);
});

test("server release publishes exactly four attested and signed images", () => {
  for (const component of ["control-api", "runtime-worker", "web-bff", "web"]) {
    assert.match(
      workflow,
      new RegExp(`deploy/crewon/${component}\\.Dockerfile`, "u"),
    );
    assert.match(workflow, new RegExp(`crewon-${component}`, "u"));
  }
  assert.match(workflow, /--platform linux\/amd64/u);
  assert.match(workflow, /--sbom=true/u);
  assert.match(workflow, /--provenance=mode=max/u);
  assert.match(workflow, /\.SBOM\.SPDX/u);
  assert.match(workflow, /\.Provenance\.SLSA/u);
  assert.match(workflow, /cosign sign --yes/u);
  assert.match(workflow, /cosign verify/u);
  assert.match(workflow, /cosign sign-blob --yes/u);
  assert.match(workflow, /server-release-manifest\.sigstore\.json/u);
  assert.ok(
    workflow.indexOf("gh release upload") <
      workflow.indexOf('gh release edit "$RELEASE_TAG" --draft=false'),
  );
});
