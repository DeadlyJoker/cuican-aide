import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const tests = (await readdir(new URL("./", import.meta.url)))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => "test/" + name);
const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...tests],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CREWON_EXAMPLE_PLUGIN_VERSION:
        process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? version,
    },
  },
);
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
