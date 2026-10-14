// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyStartupBuild } from "../scripts/verify-startup-build.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function artifact(
  files: Record<string, string>,
  script = '<script data-cfasync="false" type="module" src="./assets/entry.js"></script>',
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-startup-build-"));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><head></head><body><div id="root">正在启动 CrewON…</div>' +
      script +
      "</body></html>",
  );
  for (const [name, value] of Object.entries(files))
    await writeFile(join(directory, "assets", name), value);
  return directory;
}

it("keeps lazy Mermaid/xlsx out of the real static import/export closure, including shared helpers", async () => {
  const directory = await artifact({
    "entry.js":
      'import { helper } from "./runtime.js"; import "./react.js"; helper(); import("./WorkspaceApp.js");',
    "runtime.js": "export const helper=()=>{};",
    "react.js": "export const React={};",
    "WorkspaceApp.js":
      'import "./mermaid-feature.js"; import("./xlsx-feature.js");',
    "mermaid-feature.js": "export const graph={};",
    "xlsx-feature.js": "export const workbook={};",
  });
  const report = await verifyStartupBuild(directory);
  expect(report.eagerChunks).toEqual([
    "assets/entry.js",
    "assets/runtime.js",
    "assets/react.js",
  ]);
  expect(report.cloudflareEntryExcluded).toBe(true);
});

it.each(["mermaid", "xlsx"])(
  "rejects hidden %s static dependencies even without an HTML preload",
  async (feature) => {
    const directory = await artifact({
      "entry.js": 'import { helper } from "./runtime.js"; helper();',
      "runtime.js": `export { helper } from "./${feature}-feature.js";`,
      [`${feature}-feature.js`]: "export const helper=()=>{};",
    });
    await expect(verifyStartupBuild(directory)).rejects.toThrow(
      `startup_build_lazy_feature_eager:assets/${feature}-feature.js`,
    );
  },
);

it("rejects eager feature modulepreloads and excludes parser false positives in comments/strings", async () => {
  const directory = await artifact({
    "entry.js":
      'const example="import \\\"./mermaid-example.js\\\""; // import "./xlsx-example.js"\nexport {example};',
    "mermaid-feature.js": "export const helper=()=>{};",
  });
  expect((await verifyStartupBuild(directory)).eagerChunks).toEqual([
    "assets/entry.js",
  ]);
  await writeFile(
    join(directory, "index.html"),
    '<script data-cfasync="false" type="module" src="/plugin-next/assets/entry.js"></script><link crossorigin href="/plugin-next/assets/mermaid-feature.js" rel="modulepreload">',
  );
  await expect(verifyStartupBuild(directory)).rejects.toThrow(
    "startup_build_lazy_feature_eager",
  );
});

it("requires the Cloudflare exclusion on the built module script and rejects rewritten types", async () => {
  const directory = await artifact(
    { "entry.js": "export const ready=true;" },
    '<script type="module" crossorigin src="./assets/entry.js"></script>',
  );
  await expect(verifyStartupBuild(directory)).rejects.toThrow(
    "startup_build_cloudflare_exclusion_missing",
  );
  await writeFile(
    join(directory, "index.html"),
    '<script type="123-module" src="./assets/entry.js"></script>',
  );
  await expect(verifyStartupBuild(directory)).rejects.toThrow(
    "startup_build_module_type_rewritten",
  );
});

it("rejects arbitrary external module imports and a bloated initial bundle", async () => {
  const directory = await artifact({
    "entry.js": 'import "https://foreign.example/private.js";',
  });
  await expect(verifyStartupBuild(directory)).rejects.toThrow(
    "startup_build_external_module_denied",
  );
  await writeFile(
    join(directory, "assets/entry.js"),
    "//" + "x".repeat(512 * 1024),
  );
  await expect(verifyStartupBuild(directory)).rejects.toThrow(
    "startup_build_eager_javascript_budget_exceeded",
  );
});
