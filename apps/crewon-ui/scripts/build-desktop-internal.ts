import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  PACKAGED_DEFAULT_MODEL_FILE,
  parsePackagedDefaultModel,
} from "../electron/packagedDefaultModel.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = process.env.CREWON_TEST_MODEL_ENV_FILE?.trim();
if (!envFile)
  throw new Error(
    "Set CREWON_TEST_MODEL_ENV_FILE to the authorized internal test model env file",
  );
const input = parseEnv(readFileSync(resolve(envFile), "utf8"));
const profile = parsePackagedDefaultModel({
  schemaVersion: "crewon.internal-default-model.v1",
  endpoint: "https://api.aicuican.com/v1",
  modelId: input.CREWON_MODEL_ID?.trim() || "gpt-5.5",
  apiKey: input.AICUICAN_API_KEY,
});
const stage = mkdtempSync(join(tmpdir(), "crewon-internal-model-"));
const childEnvironment = { ...process.env };
delete childEnvironment.AICUICAN_API_KEY;
delete childEnvironment.CREWON_TEST_MODEL_ENV_FILE;
const run = (args: string[]) =>
  execFileSync("pnpm", args, {
    cwd: root,
    env: childEnvironment,
    stdio: "inherit",
  });
try {
  const credentialPath = join(stage, PACKAGED_DEFAULT_MODEL_FILE);
  // The staging directory is private. Bundle resources must be readable by another Mac user.
  writeFileSync(credentialPath, JSON.stringify(profile), { mode: 0o644 });
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const configPath = join(stage, "electron-builder.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...metadata.build,
      directories: {
        ...metadata.build.directories,
        output: "release/internal",
      },
      extraResources: [
        ...metadata.build.extraResources,
        { from: credentialPath, to: PACKAGED_DEFAULT_MODEL_FILE },
      ],
      mac: { ...metadata.build.mac, identity: "-", hardenedRuntime: false },
      forceCodeSigning: true,
      publish: null,
    }),
  );
  run(["desktop:renderer:build"]);
  run(["desktop:runtime:stage"]);
  run(["desktop:host:build"]);
  run([
    "exec",
    "electron-builder",
    "--mac",
    "dmg",
    "zip",
    "--arm64",
    "--publish",
    "never",
    "--config",
    configPath,
  ]);
  run(["desktop:verify", "release/internal"]);
  console.log(
    "Internal test build ready; includes the authorized default model. Do not publish to a public update channel.",
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
