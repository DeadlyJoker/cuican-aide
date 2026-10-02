import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstalledBusinessPluginExamples } from "../../../scripts/build-installed-business-plugin-example.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const ownedRoot = await mkdtemp(join(tmpdir(), "crewon-plugin-examples-"));
let child;
let signal;
function stop(value) {
  signal = value;
  child?.kill(value);
}
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  // SDK pack/prepack finishes before any consumer test starts importing SDK artifacts.
  const examples = await buildInstalledBusinessPluginExamples(ownedRoot, {
    includeKrea: true,
  });
  if (signal) throw new Error("installed_plugin_example_test_interrupted");
  const tests = (await readdir(join(app, "src")))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(app, "src", name));
  child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--test",
      ...process.argv.slice(2),
      ...tests,
    ],
    {
      cwd: app,
      stdio: "inherit",
      env: {
        ...process.env,
        CREWON_TEST_BUSINESS_PLUGIN_V1_DIR: examples.v1Directory,
        CREWON_TEST_BUSINESS_PLUGIN_V2_DIR: examples.v2Directory,
        CREWON_TEST_KREA_PLUGIN_DIR: examples.kreaV1Directory,
        CREWON_TEST_KREA_PLUGIN_V2_DIR: examples.kreaV2Directory,
      },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, killedBy) => resolve(code ?? (killedBy ? 1 : 0)));
  });
  process.exitCode = code;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  await rm(ownedRoot, { recursive: true });
}
