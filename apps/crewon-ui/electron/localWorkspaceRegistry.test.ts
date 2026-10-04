import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("LocalWorkspaceAuthority registry", () => {
  it("adds distinct workspaces, activates by stable ID, and keeps all IDs across restart and clear", () => {
    const fixture = createFixture();
    const authority = new LocalWorkspaceAuthority(fixture.state);
    const first = authority.select(fixture.first, mutation(0)).snapshot
      .current!;
    const second = authority.select(fixture.second, mutation(1)).snapshot
      .current!;
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(authority.status().workspaces).toEqual([first, second]);
    expect(authority.root(first.workspaceId)).toBe(fixture.first);
    authority.activate(first.workspaceId, mutation(2));
    expect(authority.root()).toBe(fixture.first);
    authority.clear(mutation(3));
    const restarted = new LocalWorkspaceAuthority(
      fixture.state,
      fixture.second,
    );
    expect(restarted.status()).toMatchObject({
      revision: 4,
      current: null,
      workspaces: [first, second],
    });
    expect(() => restarted.root()).toThrow("desktop_sandbox_workspace_unbound");
    expect(restarted.root(second.workspaceId)).toBe(fixture.second);
    expect(JSON.stringify(restarted.status())).not.toContain(fixture.root);
    expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
  });

  it("deduplicates a symlink to the same canonical directory", () => {
    const fixture = createFixture();
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.first, alias, "dir");
    const authority = new LocalWorkspaceAuthority(fixture.state);
    const first = authority.select(fixture.first, mutation(0)).snapshot.current;
    const repeated = authority.select(alias, mutation(1));
    expect(repeated.snapshot).toMatchObject({
      revision: 2,
      current: first,
      workspaces: [first],
    });
  });

  it("migrates v1 in place without changing the revision or an existing binding on restart", () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.path,
      JSON.stringify({
        schemaVersion: "crewon.desktop-workspace-authority.v1",
        revision: 9,
        root: fixture.first,
      }),
    );
    const authority = new LocalWorkspaceAuthority(fixture.state);
    const current = authority.status().current!;
    expect(authority.status().revision).toBe(9);
    expect(authority.root(current.workspaceId)).toBe(fixture.first);
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toEqual({
      schemaVersion: "crewon.desktop-workspace-authority.v2",
      revision: 9,
      activeWorkspaceId: current.workspaceId,
      workspaces: [{ workspaceId: current.workspaceId, root: fixture.first }],
    });
    expect(new LocalWorkspaceAuthority(fixture.state).status()).toEqual(
      authority.status(),
    );
  });

  it.each(["v1", "v2"])(
    "preserves an unavailable directory when loading %s",
    (version) => {
      const fixture = createFixture();
      if (version === "v1") {
        writeFileSync(
          fixture.path,
          JSON.stringify({
            schemaVersion: "crewon.desktop-workspace-authority.v1",
            revision: 7,
            root: fixture.first,
          }),
        );
      } else {
        new LocalWorkspaceAuthority(fixture.state).select(
          fixture.first,
          mutation(0),
        );
      }
      rmSync(fixture.first, { recursive: true });
      const authority = new LocalWorkspaceAuthority(fixture.state);
      const current = authority.status().current!;
      expect(current.displayName).toBe("first");
      expect(authority.status().workspaces).toEqual([current]);
      expect(() => authority.root()).toThrow();
      authority.select(fixture.second, mutation(authority.status().revision));
      expect(authority.status().workspaces).toHaveLength(2);
      expect(() =>
        authority.activate(
          current.workspaceId,
          mutation(authority.status().revision),
        ),
      ).toThrow();
      expect(authority.status().workspaces).toHaveLength(2);
    },
  );

  it("keeps canceled and conflicting mutations unchanged", () => {
    const fixture = createFixture();
    const authority = new LocalWorkspaceAuthority(fixture.state, fixture.first);
    const before = readFileSync(fixture.path, "utf8");
    expect(authority.canceled(mutation(0)).outcome).toBe("userCanceled");
    expect(() => authority.select(fixture.second, mutation(1))).toThrow(
      "desktop_workspace_authority_conflict",
    );
    expect(() => authority.activate("unknown", mutation(0))).toThrow(
      "desktop_sandbox_workspace_unbound",
    );
    expect(() => authority.activate("/private/path", mutation(0))).toThrow(
      "desktop_workspace_id_invalid",
    );
    expect(readFileSync(fixture.path, "utf8")).toBe(before);
  });

  it("retains the prior in-memory state when the atomic rename cannot commit", () => {
    const fixture = createFixture();
    const authority = new LocalWorkspaceAuthority(fixture.state, fixture.first);
    const before = authority.status();
    renameSync(fixture.path, `${fixture.path}.saved`);
    mkdirSync(fixture.path);
    expect(() => authority.select(fixture.second, mutation(0))).toThrow();
    expect(authority.status()).toEqual(before);
    rmSync(fixture.path, { recursive: true });
    renameSync(`${fixture.path}.saved`, fixture.path);
    expect(new LocalWorkspaceAuthority(fixture.state).status()).toEqual(before);
  });

  it("rejects corrupt and oversized persisted state without overwriting it", () => {
    const fixture = createFixture();
    for (const content of [
      "{broken",
      " ".repeat(128 * 1024 + 1),
      JSON.stringify({
        schemaVersion: "crewon.desktop-workspace-authority.v2",
        revision: 0,
        activeWorkspaceId: "missing",
        workspaces: [],
      }),
    ]) {
      writeFileSync(fixture.path, content);
      expect(() => new LocalWorkspaceAuthority(fixture.state)).toThrow(
        "desktop_workspace_registry_invalid",
      );
      expect(readFileSync(fixture.path, "utf8")).toBe(content);
    }
  });

  it("bounds the roster and still allows switching among a full registry", () => {
    const fixture = createFixture();
    const workspaces = Array.from({ length: 100 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      root:
        index === 0 ? fixture.first : join(fixture.root, `missing-${index}`),
    }));
    writeFileSync(
      fixture.path,
      JSON.stringify({
        schemaVersion: "crewon.desktop-workspace-authority.v2",
        revision: 0,
        activeWorkspaceId: "workspace-0",
        workspaces,
      }),
    );
    const authority = new LocalWorkspaceAuthority(fixture.state);
    expect(() => authority.select(fixture.second, mutation(0))).toThrow(
      "desktop_workspace_limit_reached",
    );
    expect(
      authority.select(fixture.first, mutation(0)).snapshot.workspaces,
    ).toHaveLength(100);
  });
});

function mutation(revision: number) {
  return { expectedRevision: revision, idempotencyKey: `test-${revision}` };
}
function createFixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-workspace-registry-")),
  );
  // macOS /var is a symlink; native roots are always canonical.
  const first = join(root, "first");
  const second = join(root, "second");
  const state = join(root, "state");
  for (const directory of [first, second, state]) mkdirSync(directory);
  roots.push(root);
  return {
    root,
    first,
    second,
    state,
    path: join(state, "desktop-workspace.json"),
  };
}
