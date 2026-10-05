import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CREWON_PROJECT_TOOLS_SERVICE,
  CREWON_PROJECT_TOOLS_API_VERSION,
  PROJECT_TOOL_OPERATIONS,
  MAX_PROJECT_TOOLS_RESPONSE_BYTES,
  PROJECT_TOOLS_CONTENT_CHUNK_CODE_POINTS,
} from "./plugin-project-tools-service.ts";
import type {
  ProjectToolsProject,
  ProjectToolsArtifact,
  ProjectToolsOutlineContent,
  ProjectToolsScriptContent,
} from "./plugin-project-tools-service.ts";
import type { PublicCreativeProject } from "./creative-project-control-types.ts";
import type {
  PublicProjectTextArtifact,
  ProjectTextOutlineContent,
  ProjectTextScriptContent,
} from "./project-text-control-types.ts";

/** Independent Node DTOs remain structurally compatible with the corresponding HTTP data. */
function compatibility(
  project: PublicCreativeProject,
  artifact: PublicProjectTextArtifact,
  outline: ProjectTextOutlineContent,
  script: ProjectTextScriptContent,
) {
  const nodeProject: ProjectToolsProject = project;
  const nodeArtifact: ProjectToolsArtifact = artifact;
  const nodeOutline: ProjectToolsOutlineContent = outline;
  const nodeScript: ProjectToolsScriptContent = script;
  const httpOutline: ProjectTextOutlineContent = nodeOutline;
  const httpScript: ProjectTextScriptContent = nodeScript;
  return { nodeProject, nodeArtifact, httpOutline, httpScript };
}
void compatibility;

test("portable project-tools contract is the exact public source vendored by the independently built plugin", () => {
  const canonical = readFileSync(
    new URL("./plugin-project-tools-service.ts", import.meta.url),
  );
  const plugin = readFileSync(
    new URL(
      "../../../examples/plugins/short-drama/src/project-tools-service.ts",
      import.meta.url,
    ),
  );
  assert.deepEqual(plugin, canonical);
  assert.ok(!/^import /mu.test(canonical.toString()));
  assert.equal(CREWON_PROJECT_TOOLS_SERVICE, "crewon.project-tools");
  assert.equal(CREWON_PROJECT_TOOLS_API_VERSION, "1");
  assert.equal(Object.keys(PROJECT_TOOL_OPERATIONS).length, 12);
  assert.equal(new Set(Object.values(PROJECT_TOOL_OPERATIONS)).size, 12);
  assert.equal(MAX_PROJECT_TOOLS_RESPONSE_BYTES, 8192);
  assert.equal(PROJECT_TOOLS_CONTENT_CHUNK_CODE_POINTS, 1024);
});
