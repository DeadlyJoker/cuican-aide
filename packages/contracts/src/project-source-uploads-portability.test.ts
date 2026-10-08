import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("source-upload public declarations compile in ES2022 Node without DOM or ambient types", () => {
  const workspace = mkdtempSync(join(tmpdir(), "crewon-upload-portable-"));
  const source = fileURLToPath(new URL("./", import.meta.url));
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const run = (config: string) => {
    const result = spawnSync(process.execPath, [compiler, "-p", config], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    const emitConfig = join(workspace, "emit.json");
    writeFileSync(
      emitConfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          types: [],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          declaration: true,
          emitDeclarationOnly: true,
          allowImportingTsExtensions: true,
          rootDir: source,
          outDir: join(workspace, "declarations"),
        },
        files: [join(source, "project-source-uploads.ts")],
      }),
    );
    run(emitConfig);
    const packageJson = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    );
    assert.equal(
      packageJson.exports["./project-source-uploads"],
      "./src/project-source-uploads.ts",
    );
    writeFileSync(
      join(workspace, "consumer.ts"),
      `
import {
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS as actions,
  projectSourceUploadsCodec,
  parseProjectSourceUploadRequest,
  parseProjectSourceUploadResponse,
  parsePublicProjectSourceUpload,
  parseProjectSourceUploadPartLocator,
  parseProjectSourceUploadPartPath,
  projectSourceUploadPartPath,
  ProjectSourceUploadContractError,
  type ProjectSourceUploadRequestFor,
  type ProjectSourceUploadResponseFor,
  type ProjectSourceUploadResponseMap,
  type PublicProjectSourceUpload,
} from "./declarations/project-source-uploads.js";
declare const data: unknown;
declare const upload: PublicProjectSourceUpload;
const prepare: ProjectSourceUploadRequestFor<"prepare"> = {
  action: actions.prepare, input: {uploadId: "upload", expectedRevision: 1},
};
const prepared: ProjectSourceUploadResponseFor<typeof prepare> = parseProjectSourceUploadResponse(data, prepare);
const disposition: "ready" | "pending" | "rejected" = prepared.disposition;
const status: ProjectSourceUploadRequestFor<"status"> = {action: actions.status,input:{uploadId:"upload"}};
const viewed = projectSourceUploadsCodec.parseResponse(data, status);
const visible: PublicProjectSourceUpload = viewed.upload;
// @ts-expect-error status responses have no disposition
viewed.disposition;
// @ts-expect-error preparation is not a commit receipt
const wrong: ProjectSourceUploadResponseMap["prepare"] = {disposition:"committed",upload};
const locator = parseProjectSourceUploadPartLocator(data);
const path: string = projectSourceUploadPartPath("mount", locator);
const roundtrip = parseProjectSourceUploadPartPath(path);
parsePublicProjectSourceUpload(visible);
parseProjectSourceUploadRequest(data);
new ProjectSourceUploadContractError();
void disposition; void roundtrip;
`,
    );
    const consumeConfig = join(workspace, "consumer.json");
    writeFileSync(
      consumeConfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          types: [],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          allowImportingTsExtensions: true,
        },
        files: [join(workspace, "consumer.ts")],
      }),
    );
    run(consumeConfig);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
