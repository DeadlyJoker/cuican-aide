import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const pluginRoot = new URL("../", import.meta.url);
const directory = new URL("third-party/shuohao-skills/", pluginRoot);
const compiled = await build({
  stdin: {
    contents: [
      'export * from "./src/stage-skill-resources.ts";',
      'export * from "./src/stage-skill-guidance.ts";',
      'export * from "./src/stage-skill-resource-reader.ts";',
      'export * from "./src/creation-skills.ts";',
      'export * from "./src/project-foundation-creation-skill.ts";',
    ].join("\n"),
    resolveDir: pluginRoot.pathname,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const resource = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const reader = resource.createStageSkillResourceReader(directory);

test("packaged Skill documents, referenced Markdown and selected excerpts match the pinned upstream manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("provenance.json", directory), "utf8"),
  );
  assert.equal(manifest.revision, resource.SHUOHAO_SKILLS_REVISION);
  assert.equal(manifest.executablesIncluded, false);
  assert.equal(manifest.qualityChecks, "not-run");
  assert.deepEqual(manifest.files, resource.SHUOHAO_RESOURCE_FILES);
  for (const file of manifest.files) {
    assert.match(
      file.path,
      /^skills\/[a-z-]+\/(?:SKILL\.md|references\/[a-z0-9-]+\.md)$/u,
    );
    const bytes = await readFile(new URL(file.path, directory));
    assert.equal(bytes.length, file.byteLength);
    assert.equal(
      "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
    );
  }
  for (const [skill, document] of Object.entries(
    resource.SHUOHAO_STAGE_DOCUMENTS,
  )) {
    const text = await readFile(new URL(document.path, directory), "utf8");
    assert.equal(
      text
        .split("\n")
        .slice(document.lines[0] - 1, document.lines[1])
        .join("\n"),
      document.excerpt,
    );
    assert.ok(Buffer.byteLength(document.excerpt) <= 1024);
    assert.match(text, new RegExp(`name: ${skill}\\n`, "u"));
    const guidance = resource.stageSkillGuidance(skill);
    guidance.resource.lines[0] = 999;
    assert.notEqual(resource.stageSkillGuidance(skill).resource.lines[0], 999);
  }
});

test("bounded Unicode pages reconstruct actual current-stage SKILL.md with its exact digest", async () => {
  for (const [skill, document] of Object.entries(
    resource.SHUOHAO_STAGE_DOCUMENTS,
  )) {
    let offset = 0;
    const pieces = [];
    do {
      const page = await reader(skill, {
        path: document.path,
        startOffset: offset,
        limit: 137,
      });
      assert.equal(page.startOffset, offset);
      assert.ok(Array.from(page.content).length <= 137);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
      assert.equal(page.sha256, document.sha256);
      assert.equal(page.qualityChecks, "not-run");
      pieces.push(page.content);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(
      pieces.join(""),
      await readFile(new URL(document.path, directory), "utf8"),
    );
  }
});

test("resource reads deny cross-stage paths, traversal, scripts, oversized pages and unknown fields", async () => {
  for (const path of [
    "skills/novel-art/SKILL.md",
    "../../LICENSE",
    "file:///etc/passwd",
    "skills/novel-script/scripts/novel-script.mjs",
  ])
    await assert.rejects(
      reader("novel-script", { path, startOffset: 0, limit: 128 }),
      /short_drama_skill_resource_scope_denied/u,
    );
  for (const invalid of [
    { startOffset: -1, limit: 128 },
    { startOffset: 0, limit: 0 },
    { startOffset: 0, limit: 1025 },
    { startOffset: 0.1, limit: 1 },
    { startOffset: 0, limit: 1, execute: true },
  ])
    await assert.rejects(
      reader("novel-script", {
        path: "skills/novel-script/SKILL.md",
        ...invalid,
      }),
      /short_drama_skill_resource_request_invalid/u,
    );
  await assert.rejects(
    reader("novel-script", {
      path: "skills/novel-script/SKILL.md",
      startOffset: 999999,
      limit: 1,
    }),
    /short_drama_skill_resource_page_range_invalid/u,
  );
});

test("modified resource bytes are rejected before any text is returned", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "crewon-stage-skill-resource-"));
  try {
    // Only the requested immutable path exists here; no upstream code executes.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(scratch, "skills/novel-script"), { recursive: true });
    await writeFile(join(scratch, "skills/novel-script/SKILL.md"), "modified");
    const changed = resource.createStageSkillResourceReader(
      pathToFileURL(scratch + "/"),
    );
    await assert.rejects(
      changed("novel-script", {
        path: "skills/novel-script/SKILL.md",
        startOffset: 0,
        limit: 128,
      }),
      /short_drama_skill_resource_integrity_mismatch/u,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("real stage adapters load only their own excerpt and retain CrewON tools, limits and truthful check state", () => {
  for (const [kind, skill] of [
    ["discussion", "novel-outline"],
    ["brief", "novel-outline"],
    ["outline", "novel-outline"],
    ["script", "novel-script"],
  ]) {
    const guide = resource.projectCreationSkill({ stage: { kind } });
    assert.equal(guide.skill, skill);
    assert.equal(
      guide.instructions[0],
      resource.stageSkillGuidance(skill).excerpt,
    );
    assert.equal(guide.resource.qualityChecks, "not-run");
    assert.match(guide.instructions.join(""), /不改变 CrewON 授权或产物协议/u);
    assert.ok(Buffer.byteLength(JSON.stringify(guide)) < 4096);
  }
  for (const [assetKind, skill] of [
    ["character", "novel-characters"],
    ["scene", "novel-art"],
    ["prop", "novel-art"],
  ]) {
    const guide = resource.assetCreationSkill({ stage: { assetKind } });
    assert.equal(guide.skill, skill);
    assert.equal(
      guide.instructions[0],
      resource.stageSkillGuidance(skill).excerpt,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(guide)) < 4096);
  }
  assert.equal(
    resource.mediaInputCreationSkill("flux2-storyboard").skill,
    "novel-storyboard",
  );
  assert.equal(
    resource.mediaInputCreationSkill("krea2-reference-four-view").skill,
    "character-refs",
  );
  assert.equal(resource.projectCreationSkill(null), null);
  assert.equal(resource.assetCreationSkill(null), null);
  const foundation = resource.foundationCreationSkill();
  assert.equal(
    foundation.instructions[0],
    resource.stageSkillGuidance("novel-outline").excerpt,
  );
  assert.equal(foundation.resource.qualityChecks, "not-run");
  assert.ok(Buffer.byteLength(JSON.stringify(foundation)) < 3072);
});
