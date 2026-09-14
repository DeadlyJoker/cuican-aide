import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as { version: string };
const output = resolve(root, process.argv[2] ?? "release");
const bundle = resolve(output, "mac-arm64/CrewON.app");
const image = resolve(output, `CrewON-${version}-arm64.dmg`);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: "inherit",
});
execFileSync("/usr/bin/hdiutil", ["verify", image], { stdio: "inherit" });
console.log(
  `Verified application signature and disk image integrity: ${image}`,
);
