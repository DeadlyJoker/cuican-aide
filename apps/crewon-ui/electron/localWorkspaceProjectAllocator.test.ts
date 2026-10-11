import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginProjectWorkspaceOwner } from "@crewon/domain";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import { LocalWorkspaceSandbox } from "./localWorkspace.ts";
import { LocalWorkspaceProjectAllocator } from "./localWorkspaceProjectAllocator.ts";
import {
  ALLOCATION_LOCK_FILE,
  LocalWorkspaceProjectAllocationJournal,
  projectAllocationWorkspaceId,
} from "./localWorkspaceProjectAllocationJournal.ts";
import { issueLocalWorkspaceProjectRegistration } from "./localWorkspaceProjectRegistration.ts";
import {
  discardInterruptedDesktopConfigWrites,
  writeDesktopConfigAtomically,
} from "./desktopConfigFile.ts";

const owner: PluginProjectWorkspaceOwner = {
  tenantId: "tenant-a",
  spaceId: "space-a",
  principalId: "principal-a",
  actorId: "actor-a",
  profileId: "profile-a",
  pluginId: "studio.example",
  publisherId: "publisher.example",
  projectId: "project-a",
};
const fixtures: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  for (const root of fixtures.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-native-project-workspace-")),
  );
  fixtures.push(base);
  const state = join(base, "state"),
    ordinary = join(base, "ordinary"),
    other = join(base, "other");
  for (const directory of [state, ordinary, other])
    mkdirSync(directory, { mode: 0o700 });
  const authority = new LocalWorkspaceAuthority(state, ordinary);
  return {
    base,
    state,
    ordinary,
    other,
    authority,
    registry: join(state, "desktop-workspace.json"),
    journal: join(state, "desktop-plugin-project-workspaces.json"),
  };
}
function mutation(expectedRevision: number) {
  return { expectedRevision, idempotencyKey: `test-${expectedRevision}` };
}

describe("Native project allocation over the original workspace registry", () => {
  it("registers a real stable directory without activating it or invalidating active file operations", () => {
    const f = fixture(),
      before = f.authority.status(),
      lease = f.authority.captureRoot();
    const allocator = new LocalWorkspaceProjectAllocator(f.authority, owner);
    expect(allocator.inspect()).toMatchObject({
      phase: "unallocated",
      observation: "unregistered",
    });
    const result = allocator.provision();
    expect(result).toMatchObject({
      phase: "registered",
      observation: "registered",
      failureCode: null,
    });
    expect(f.authority.status()).toMatchObject({
      revision: 1,
      current: before.current,
    });
    expect(f.authority.root()).toBe(f.ordinary);
    expect(() => f.authority.assertRootCurrent(lease)).not.toThrow();
    const projectRoot = f.authority.root(result.workspaceId);
    expect(statSync(projectRoot).isDirectory()).toBe(true);
    expect(statSync(projectRoot).mode & 0o777).toBe(0o700);
    expect(statSync(f.journal).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(f.base);
    const persisted = JSON.parse(readFileSync(f.registry, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual([
      "activeWorkspaceId",
      "revision",
      "schemaVersion",
      "workspaces",
    ]);
    expect(
      persisted.workspaces.every(
        (entry: object) =>
          Object.keys(entry).sort().join() === "root,workspaceId",
      ),
    ).toBe(true);
    f.authority.activate(result.workspaceId, mutation(1));
    expect(() => f.authority.assertRootCurrent(lease)).toThrow(
      "workspace_changed",
    );
  });
  it("replays across a real restart without duplicate roster entries or moving saved files", () => {
    const f = fixture(),
      first = new LocalWorkspaceProjectAllocator(
        f.authority,
        owner,
      ).provision();
    const path = join(f.authority.root(first.workspaceId), "saved.txt");
    writeFileSync(path, "keep");
    const cold = new LocalWorkspaceAuthority(f.state),
      allocator = new LocalWorkspaceProjectAllocator(cold, { ...owner });
    expect(allocator.provision()).toEqual(first);
    expect(cold.status().revision).toBe(1);
    expect(cold.status().workspaces).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toBe("keep");
    expect(allocator.recover()).toEqual(first);
    expect(cold.status().revision).toBe(1);
    expect(cold.root()).toBe(f.ordinary);
  });
  it("keeps an in-flight real native file preview readable while appending a project workspace", async () => {
    const f = fixture(),
      sandbox = new LocalWorkspaceSandbox(f.authority);
    writeFileSync(join(f.ordinary, "before.txt"), "original workspace");
    const preview = sandbox.readFile("/workspace/before.txt");
    const result = new LocalWorkspaceProjectAllocator(
      f.authority,
      owner,
    ).provision();
    expect(result.observation).toBe("registered");
    expect(await preview).toMatchObject({ content: "original workspace" });
    expect(f.authority.root()).toBe(f.ordinary);
  });
  it.each(Object.keys(owner) as (keyof PluginProjectWorkspaceOwner)[])(
    "isolates stable ownership by %s",
    (field) => {
      const f = fixture();
      const first = new LocalWorkspaceProjectAllocator(
        f.authority,
        owner,
      ).provision();
      const second = new LocalWorkspaceProjectAllocator(f.authority, {
        ...owner,
        [field]: `${owner[field]}-other`,
      }).provision();
      expect(first.workspaceId).not.toBe(second.workspaceId);
      expect(f.authority.root(first.workspaceId)).not.toBe(
        f.authority.root(second.workspaceId),
      );
      expect(f.authority.root()).toBe(f.ordinary);
    },
  );
  it("rejects fake Native authorities and owner shapes before allocation", () => {
    const f = fixture();
    expect(
      () =>
        new LocalWorkspaceProjectAllocator(
          {
            projectAllocationDataDirectory: () => f.state,
          } as LocalWorkspaceAuthority,
          owner,
        ),
    ).toThrow();
    for (const bad of [
      { ...owner, version: "1" },
      { ...owner, projectId: "project\ninvalid" },
      { ...owner, actorId: null },
    ]) {
      expect(
        () =>
          new LocalWorkspaceProjectAllocator(
            f.authority,
            bad as PluginProjectWorkspaceOwner,
          ),
      ).toThrow();
    }
    expect(existsSync(f.journal)).toBe(false);
  });
  it("treats opaque owner IDs as identity, never as filesystem paths", () => {
    const f = fixture(),
      allocator = new LocalWorkspaceProjectAllocator(f.authority, {
        ...owner,
        projectId: "../../project",
      });
    const result = allocator.provision();
    expect(result.observation).toBe("registered");
    expect(f.authority.root(result.workspaceId)).toBe(
      join(f.state, "plugin-project-workspaces", result.workspaceId),
    );
  });
  it("binds the one-use Native registration proof to the actual authority instance", () => {
    const f = fixture(),
      second = new LocalWorkspaceAuthority(f.state);
    const token = issueLocalWorkspaceProjectRegistration({
      authority: f.authority,
      workspaceId: "workspace-native-proof",
      root: f.other,
    });
    expect(() => second.registerProjectAllocation(token)).toThrow(
      "registration_unavailable",
    );
    expect(() => f.authority.registerProjectAllocation({ ...token })).toThrow(
      "registration_unavailable",
    );
    expect(f.authority.registerProjectAllocation(token).outcome).toBe(
      "committed",
    );
    expect(() => f.authority.registerProjectAllocation(token)).toThrow(
      "registration_unavailable",
    );
    expect(f.authority.root()).toBe(f.ordinary);
  });
  it("does not adopt a legacy workspace with a matching canonical root", () => {
    const f = fixture(),
      allocator = new LocalWorkspaceProjectAllocator(f.authority, owner);
    const id = projectAllocationWorkspaceId(owner),
      parent = join(f.state, "plugin-project-workspaces"),
      root = join(parent, id);
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, "legacy.txt"), "legacy");
    const legacy = f.authority.select(root, mutation(0)).snapshot.current;
    const result = allocator.provision();
    expect(result).toMatchObject({
      phase: "failed",
      observation: "unobserved",
    });
    expect(f.authority.status().current).toEqual(legacy);
    expect(f.authority.status().workspaces).toHaveLength(2);
    expect(readFileSync(join(root, "legacy.txt"), "utf8")).toBe("legacy");
    expect(() => f.authority.root(id)).toThrow("unbound");
  });
  it("leaves failed allocation idle until explicit recovery, preserving active workspace selection", () => {
    const f = fixture(),
      allocator = new LocalWorkspaceProjectAllocator(f.authority, owner);
    writeFileSync(`${f.registry}.pending-v1`, "occupied", { mode: 0o600 });
    const failed = allocator.provision();
    expect(failed.phase).toBe("failed");
    expect(f.authority.status().revision).toBe(0);
    rmSync(`${f.registry}.pending-v1`);
    expect(allocator.provision()).toEqual(failed);
    expect(f.authority.status().revision).toBe(0);
    expect(allocator.recover()).toMatchObject({
      phase: "registered",
      observation: "registered",
    });
    expect(f.authority.root()).toBe(f.ordinary);
  });
  it("does not treat a persisted allocation as a ready product binding or an unavailable directory as observed", () => {
    const f = fixture(),
      allocator = new LocalWorkspaceProjectAllocator(f.authority, owner),
      result = allocator.provision();
    rmSync(f.authority.root(result.workspaceId), { recursive: true });
    expect(allocator.inspect()).toMatchObject({
      phase: "registered",
      observation: "unobserved",
      failureCode: "directoryUnavailable",
    });
    expect(JSON.stringify(allocator.inspect())).not.toMatch(
      /ready|committed|tenantId|root/,
    );
  });
  it.each(["projectEntry", "registryFile"])(
    "recovers registered intent after loss of %s with the same ID and no activation",
    (kind) => {
      const f = fixture(),
        result = new LocalWorkspaceProjectAllocator(
          f.authority,
          owner,
        ).provision();
      if (kind === "registryFile") rmSync(f.registry);
      else {
        const state = JSON.parse(readFileSync(f.registry, "utf8"));
        state.workspaces = state.workspaces.filter(
          (entry: { workspaceId: string }) =>
            entry.workspaceId !== result.workspaceId,
        );
        state.revision++;
        writeFileSync(f.registry, JSON.stringify(state), { mode: 0o600 });
      }
      const cold = new LocalWorkspaceAuthority(f.state),
        current = cold.status().current,
        allocator = new LocalWorkspaceProjectAllocator(cold, owner);
      expect(allocator.inspect()).toMatchObject({
        phase: "registered",
        observation: "unregistered",
        failureCode: "registryUnavailable",
      });
      expect(allocator.recover()).toEqual(result);
      expect(cold.status().current).toEqual(current);
      expect(
        cold
          .status()
          .workspaces.filter(
            (entry) => entry.workspaceId === result.workspaceId,
          ),
      ).toHaveLength(1);
    },
  );
  it.each([
    "symlink",
    "hardlink",
    "directory",
    "oversized",
    "public",
    "extraField",
  ])("rejects a %s private journal without overwriting it", (kind) => {
    const f = fixture(),
      allocator = new LocalWorkspaceProjectAllocator(f.authority, owner);
    const source = join(f.base, "source");
    writeFileSync(source, "{}", { mode: 0o600 });
    if (kind === "symlink") symlinkSync(source, f.journal);
    if (kind === "hardlink") linkSync(source, f.journal);
    if (kind === "directory") mkdirSync(f.journal);
    if (kind === "oversized")
      writeFileSync(f.journal, " ".repeat(128 * 1024 + 1), { mode: 0o600 });
    if (kind === "public") writeFileSync(f.journal, "{}", { mode: 0o644 });
    if (kind === "extraField")
      writeFileSync(
        f.journal,
        JSON.stringify({
          schemaVersion:
            "crewon.desktop-plugin-project-workspace-allocations.v1",
          revision: 0,
          allocations: [],
          ready: true,
        }),
        { mode: 0o600 },
      );
    expect(allocator.inspect().failureCode).toBe("journalUnavailable");
    expect(() => allocator.provision()).toThrow();
    expect(f.authority.status().revision).toBe(0);
    expect(readFileSync(source, "utf8")).toBe("{}");
    expect(existsSync(join(f.state, "plugin-project-workspaces"))).toBe(false);
  });
  it("enforces private journal target rules in the original atomic writer", () => {
    const f = fixture(),
      source = join(f.base, "source");
    writeFileSync(source, "do not modify", { mode: 0o600 });
    linkSync(source, f.journal);
    expect(() => writeDesktopConfigAtomically(f.journal, "{}")).toThrow(
      "target_invalid",
    );
    expect(readFileSync(source, "utf8")).toBe("do not modify");
    expect(existsSync(`${f.journal}.pending-v1`)).toBe(false);
  });
  it.each(["parent", "staging", "root", "marker"])(
    "rejects an unowned/symlink %s without writing outside the native registry",
    (kind) => {
      const f = fixture(),
        allocator = new LocalWorkspaceProjectAllocator(f.authority, owner),
        id = projectAllocationWorkspaceId(owner);
      const parent = join(f.state, "plugin-project-workspaces"),
        root = join(parent, id);
      if (kind === "parent") symlinkSync(f.other, parent, "dir");
      else {
        mkdirSync(parent, { mode: 0o700 });
        if (kind === "staging")
          symlinkSync(f.other, join(parent, `.${id}.pending-v1`), "dir");
        if (kind === "root") symlinkSync(f.other, root, "dir");
        if (kind === "marker") {
          mkdirSync(root, { mode: 0o700 });
          mkdirSync(join(root, ".crewon"), { mode: 0o700 });
          symlinkSync(
            join(f.base, "absent"),
            join(root, ".crewon", "native-project-workspace-owner.json"),
          );
        }
      }
      expect(allocator.provision().phase).toBe("failed");
      expect(f.authority.status().revision).toBe(0);
      expect(existsSync(join(f.other, ".crewon"))).toBe(false);
    },
  );
  it.each(["malformed", "hardlink", "symlink"])(
    "does not steal an existing %s allocation lease",
    (kind) => {
      const f = fixture(),
        allocator = new LocalWorkspaceProjectAllocator(f.authority, owner),
        lock = join(f.state, ALLOCATION_LOCK_FILE),
        source = join(f.base, "source");
      writeFileSync(source, "lease", { mode: 0o600 });
      if (kind === "malformed") writeFileSync(lock, "broken", { mode: 0o600 });
      if (kind === "hardlink") linkSync(source, lock);
      if (kind === "symlink") symlinkSync(source, lock);
      expect(() => allocator.provision()).toThrow();
      expect(existsSync(f.journal)).toBe(false);
      expect(() =>
        discardInterruptedDesktopConfigWrites({
          dataDirectory: f.state,
          ownsSingleInstance: false,
        }),
      ).toThrow("lock_required");
      const cleanup = discardInterruptedDesktopConfigWrites({
        dataDirectory: f.state,
        ownsSingleInstance: true,
      });
      expect(cleanup).toEqual(
        kind === "malformed"
          ? { removed: 1, retained: 0 }
          : { removed: 0, retained: 1 },
      );
      expect(readFileSync(source, "utf8")).toBe("lease");
      if (kind === "malformed")
        expect(allocator.provision().phase).toBe("registered");
    },
  );
  it("rejects another actual authority's stale registry write without losing its selection", () => {
    const f = fixture(),
      stale = new LocalWorkspaceAuthority(f.state);
    f.authority.select(f.other, mutation(0));
    const bytes = readFileSync(f.registry, "utf8");
    expect(() => stale.clear(mutation(0))).toThrow("authority_conflict");
    expect(() => new LocalWorkspaceProjectAllocator(stale, owner)).toThrow(
      "authority_conflict",
    );
    expect(readFileSync(f.registry, "utf8")).toBe(bytes);
    expect(new LocalWorkspaceAuthority(f.state).root()).toBe(f.other);
  });
  it("bounds the original roster without activating a failed allocation", () => {
    const f = fixture(),
      state = JSON.parse(readFileSync(f.registry, "utf8"));
    for (let i = 1; i < 100; i++)
      state.workspaces.push({
        workspaceId: `workspace-${i}`,
        root: join(f.base, `missing-${i}`),
      });
    writeFileSync(f.registry, JSON.stringify(state), { mode: 0o600 });
    const full = new LocalWorkspaceAuthority(f.state),
      result = new LocalWorkspaceProjectAllocator(full, owner).provision();
    expect(result).toMatchObject({
      phase: "failed",
      failureCode: "registryUnavailable",
    });
    expect(full.status().workspaces).toHaveLength(100);
    expect(full.root()).toBe(f.ordinary);
  });
});

const allocatorUrl = new URL(
  "./localWorkspaceProjectAllocator.ts",
  import.meta.url,
).href;
const registryUrl = new URL("./localWorkspaceRegistry.ts", import.meta.url)
  .href;
function child(script: string) {
  const process = spawn(
    globalThis.process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(process);
  let output = "",
    errors = "";
  process.stdout!.on("data", (data) => {
    output += data;
  });
  process.stderr!.on("data", (data) => {
    errors += data;
  });
  return {
    process,
    output: () => output,
    errors: () => errors,
    closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        process.once("close", (code, signal) => resolve({ code, signal })),
    ),
  };
}
async function waitForOutput(c: ReturnType<typeof child>, marker: string) {
  const until = Date.now() + 8000;
  while (!c.output().includes(marker)) {
    if (
      c.process.exitCode !== null ||
      c.process.signalCode !== null ||
      Date.now() > until
    )
      throw new Error(
        `child did not emit ${marker}: ${c.output()} ${c.errors()}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe("actual Native process CAS and interrupted allocation recovery", () => {
  it.each(["file", "hardlink", "symlink"])(
    "preserves an externally replaced %s instead of unlinking it during lease release",
    async (kind) => {
      const f = fixture(),
        lock = join(f.state, ALLOCATION_LOCK_FILE),
        replacement = join(f.base, "replacement");
      writeFileSync(replacement, "replacement must remain", { mode: 0o600 });
      const c = child(
        `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;let replaced=false;fs.renameSync=function(from,to){const result=rename(from,to);if(!replaced&&to===${JSON.stringify(f.journal)}){replaced=true;fs.unlinkSync(${JSON.stringify(lock)});if(${JSON.stringify(kind)}==='file')fs.writeFileSync(${JSON.stringify(lock)},'replacement must remain',{mode:0o600});if(${JSON.stringify(kind)}==='hardlink')fs.linkSync(${JSON.stringify(replacement)},${JSON.stringify(lock)});if(${JSON.stringify(kind)}==='symlink')fs.symlinkSync(${JSON.stringify(replacement)},${JSON.stringify(lock)});}return result;};syncBuiltinESMExports();const {LocalWorkspaceAuthority}=await import(${JSON.stringify(registryUrl)});const {LocalWorkspaceProjectAllocator}=await import(${JSON.stringify(allocatorUrl)});try{new LocalWorkspaceProjectAllocator(new LocalWorkspaceAuthority(${JSON.stringify(f.state)}),${JSON.stringify(owner)}).provision();console.log('incorrect');}catch(error){console.log(error.message);}`,
      );
      expect((await c.closed).code).toBe(0);
      expect(c.output()).toContain(
        "desktop_workspace_allocation_lease_changed",
      );
      expect(readFileSync(lock, "utf8")).toBe("replacement must remain");
      expect(readFileSync(replacement, "utf8")).toBe("replacement must remain");
      expect(() =>
        new LocalWorkspaceProjectAllocator(
          new LocalWorkspaceAuthority(f.state),
          owner,
        ).recover(),
      ).toThrow("lease_unavailable");
    },
  );
  it("preserves another process's ordinary workspace selection during a partial allocation", async () => {
    const f = fixture(),
      release = join(f.base, "release");
    const c = child(
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;let paused=false;fs.renameSync=function(from,to){const result=rename(from,to);if(!paused&&to===${JSON.stringify(f.journal)}){paused=true;console.log('intent-held');const end=Date.now()+6000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return result;};syncBuiltinESMExports();const {LocalWorkspaceAuthority}=await import(${JSON.stringify(registryUrl)});const {LocalWorkspaceProjectAllocator}=await import(${JSON.stringify(allocatorUrl)});console.log(JSON.stringify(new LocalWorkspaceProjectAllocator(new LocalWorkspaceAuthority(${JSON.stringify(f.state)}),${JSON.stringify(owner)}).provision()));`,
    );
    await waitForOutput(c, "intent-held");
    f.authority.select(f.other, mutation(0));
    const selectedBytes = readFileSync(f.registry, "utf8");
    writeFileSync(release, "release");
    expect((await c.closed).code).toBe(0);
    expect(c.output()).toContain('"failureCode":"authorityConflict"');
    expect(readFileSync(f.registry, "utf8")).toBe(selectedBytes);
    const cold = new LocalWorkspaceAuthority(f.state);
    expect(cold.root()).toBe(f.other);
    expect(
      new LocalWorkspaceProjectAllocator(cold, owner).recover().observation,
    ).toBe("registered");
    expect(cold.root()).toBe(f.other);
  }, 10000);
  it("rejects a stale write from a second actual Node process", async () => {
    const f = fixture();
    const c = child(
      `const { LocalWorkspaceAuthority } = await import(${JSON.stringify(registryUrl)}); const authority = new LocalWorkspaceAuthority(${JSON.stringify(f.state)}); console.log('ready'); await new Promise(resolve => process.stdin.once('data',resolve)); try { authority.clear({ expectedRevision: 0, idempotencyKey: 'child' }); console.log('incorrect'); } catch(error) { console.log(error.message); }`,
    );
    await waitForOutput(c, "ready");
    f.authority.select(f.other, mutation(0));
    c.process.stdin!.end("continue\n");
    expect((await c.closed).code).toBe(0);
    expect(c.output()).toContain("desktop_workspace_authority_conflict");
    expect(new LocalWorkspaceAuthority(f.state).root()).toBe(f.other);
  });
  it("excludes a second real process for the whole allocation via the fixed wx lease", async () => {
    const f = fixture(),
      release = join(f.base, "release");
    const c = child(
      `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.renameSync; fs.renameSync=function(from,to){ const result=rename(from,to); if(to===${JSON.stringify(f.journal)}){console.log('lease-held');const end=Date.now()+6000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);} return result; }; syncBuiltinESMExports(); const {LocalWorkspaceAuthority}=await import(${JSON.stringify(registryUrl)});const {LocalWorkspaceProjectAllocator}=await import(${JSON.stringify(allocatorUrl)});console.log(JSON.stringify(new LocalWorkspaceProjectAllocator(new LocalWorkspaceAuthority(${JSON.stringify(f.state)}),${JSON.stringify(owner)}).provision()));`,
    );
    await waitForOutput(c, "lease-held");
    expect(() =>
      new LocalWorkspaceProjectAllocator(f.authority, owner).recover(),
    ).toThrow();
    expect(f.authority.status().revision).toBe(0);
    writeFileSync(release, "release");
    expect((await c.closed).code).toBe(0);
    expect(c.output()).toContain('"observation":"registered"');
    expect(
      new LocalWorkspaceAuthority(f.state).status().workspaces,
    ).toHaveLength(2);
  }, 10000);
  it.each(["intent", "ownedStaging", "registry"])(
    "recovers a real SIGKILL after %s without switching the active workspace or duplicating registration",
    async (checkpoint) => {
      const f = fixture();
      const c = child(
        `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.renameSync;fs.renameSync=function(from,to){if(${JSON.stringify(checkpoint)}==='ownedStaging'&&String(from).includes('workspace-project-')&&String(from).endsWith('.pending-v1'))process.kill(process.pid,'SIGKILL');const result=rename(from,to);if((${JSON.stringify(checkpoint)}==='intent'&&to===${JSON.stringify(f.journal)})||(${JSON.stringify(checkpoint)}==='registry'&&to===${JSON.stringify(f.registry)}))process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();const {LocalWorkspaceAuthority}=await import(${JSON.stringify(registryUrl)});const {LocalWorkspaceProjectAllocator}=await import(${JSON.stringify(allocatorUrl)});new LocalWorkspaceProjectAllocator(new LocalWorkspaceAuthority(${JSON.stringify(f.state)}),${JSON.stringify(owner)}).provision();`,
      );
      expect((await c.closed).signal).toBe("SIGKILL");
      const cold = new LocalWorkspaceAuthority(f.state),
        allocator = new LocalWorkspaceProjectAllocator(cold, owner),
        revision = cold.status().revision;
      expect(allocator.inspect().phase).toBe("pending");
      expect(() => allocator.provision()).toThrow();
      expect(
        discardInterruptedDesktopConfigWrites({
          dataDirectory: f.state,
          ownsSingleInstance: true,
        }),
      ).toEqual({ removed: 1, retained: 0 });
      expect(allocator.provision().phase).toBe("pending");
      expect(allocator.recover()).toMatchObject({
        phase: "registered",
        observation: "registered",
      });
      expect(cold.status().revision).toBe(
        checkpoint === "registry" ? revision : revision + 1,
      );
      expect(cold.status().workspaces).toHaveLength(2);
      expect(cold.root()).toBe(f.ordinary);
    },
  );
  it("keeps the pending journal honest when final journal write fails after the real registry commit", async () => {
    const f = fixture();
    const c = child(
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=function(from,to){const result=rename(from,to);if(to===${JSON.stringify(f.registry)})fs.writeFileSync(${JSON.stringify(`${f.journal}.pending-v1`)},'occupied',{mode:0o600});return result;};syncBuiltinESMExports();const {LocalWorkspaceAuthority}=await import(${JSON.stringify(registryUrl)});const {LocalWorkspaceProjectAllocator}=await import(${JSON.stringify(allocatorUrl)});console.log(JSON.stringify(new LocalWorkspaceProjectAllocator(new LocalWorkspaceAuthority(${JSON.stringify(f.state)}),${JSON.stringify(owner)}).provision()));`,
    );
    expect((await c.closed).code).toBe(0);
    expect(c.output()).toContain('"phase":"pending"');
    expect(
      discardInterruptedDesktopConfigWrites({
        dataDirectory: f.state,
        ownsSingleInstance: true,
      }),
    ).toEqual({ removed: 1, retained: 0 });
    const cold = new LocalWorkspaceAuthority(f.state),
      allocator = new LocalWorkspaceProjectAllocator(cold, owner);
    expect(cold.status().revision).toBe(1);
    expect(allocator.recover().observation).toBe("registered");
    expect(cold.status().revision).toBe(1);
  });
  it("journal CAS does not overwrite another real committed allocation", () => {
    const f = fixture(),
      journal = new LocalWorkspaceProjectAllocationJournal(f.state),
      stale = journal.read();
    new LocalWorkspaceProjectAllocator(f.authority, owner).provision();
    const actual = readFileSync(f.journal, "utf8"),
      otherOwner = { ...owner, projectId: "project-other" };
    expect(() =>
      journal.write(stale, {
        owner: otherOwner,
        workspaceId: projectAllocationWorkspaceId(otherOwner),
        createdAt: new Date().toISOString(),
        phase: "pending",
        failureCode: null,
      }),
    ).toThrow("journal_conflict");
    expect(readFileSync(f.journal, "utf8")).toBe(actual);
    expect(existsSync(`${f.journal}.pending-v1`)).toBe(false);
  });
  it("rejects malformed Native journal writes before touching persisted state", () => {
    const f = fixture(),
      journal = new LocalWorkspaceProjectAllocationJournal(f.state);
    const snapshot = journal.read(),
      valid = {
        owner,
        workspaceId: projectAllocationWorkspaceId(owner),
        createdAt: new Date().toISOString(),
        phase: "pending" as const,
        failureCode: null,
      };
    for (const bad of [
      { ...valid, workspaceId: "workspace-wrong" },
      { ...valid, failureCode: "registryUnavailable" },
      { ...valid, ready: true },
      { ...valid, owner: { ...owner, version: "1" } },
    ])
      expect(() => journal.write(snapshot, bad as typeof valid)).toThrow();
    expect(existsSync(f.journal)).toBe(false);
    expect(existsSync(`${f.journal}.pending-v1`)).toBe(false);
  });
});
