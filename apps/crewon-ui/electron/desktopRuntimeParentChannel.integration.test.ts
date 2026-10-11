import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";

const clientUrl = new URL(
  "../../control-api/src/desktop-native-project-workspace-client.ts",
  import.meta.url,
).href;

for (const provider of ["configured", "absent"] as const)
  it(`actual RuntimeSupervisor gives only Control a parent channel with provider ${provider}`, async () => {
    const f = desktopPluginManagementFixture({ provider, approval: "present" });
    const audit = join(f.directory, "parent-channel.jsonl");
    try {
      for (const role of ["control", "worker", "release"]) {
        const path = join(f.directory, `${role}.mjs`);
        const probe =
          role === "control"
            ? `const {DesktopNativeProjectWorkspaceClient}=await import(${JSON.stringify(clientUrl)});const client=new DesktopNativeProjectWorkspaceClient({signal:new AbortController().signal});await client.close();`
            : "";
        writeFileSync(
          path,
          `import {appendFileSync as recordParentChannel} from 'node:fs';${probe}recordParentChannel(${JSON.stringify(audit)},JSON.stringify({role:${JSON.stringify(role)},connected:process.connected===true,send:typeof process.send==='function'})+'\\n');\n` +
            readFileSync(path, "utf8"),
        );
      }
      await f.owner.start();
      const rows = readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.role === "control")).toEqual([
        { role: "control", connected: true, send: true },
      ]);
      for (const row of rows.filter((row) => row.role !== "control"))
        expect(row).toEqual({ role: row.role, connected: false, send: false });
      expect(rows).toHaveLength(provider === "configured" ? 3 : 1);
      // f.close stops the actual children; no Main ticket or directory allocator is installed in this transport test.
    } finally {
      await f.close();
    }
  });
