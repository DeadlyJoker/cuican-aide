import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/desktop-release.yml", import.meta.url),
  "utf8",
);

test("desktop stable and prerelease tags publish with distinct latest authority", () => {
  assert.ok(
    workflow.includes(
      '[[ "$RELEASE_TAG" =~ ^desktop-v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]',
    ),
  );
  assert.match(workflow, /version="\$\{RELEASE_TAG#desktop-v\}"/u);
  assert.match(workflow, /prerelease=false\s+latest=true/u);
  assert.match(
    workflow,
    /if \[\[ "\$version" == \*-\* \]\]; then\s+prerelease=true\s+latest=false\s+fi/u,
  );
  assert.match(
    workflow,
    /\[\[ "\$prerelease" == true \]\] && flags\+=\(--prerelease\)/u,
  );
  assert.match(
    workflow,
    /gh release edit "\$RELEASE_TAG" --draft=false \\\s+--prerelease="\$prerelease" --latest="\$latest"/u,
  );
});
