import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  gitNullDevice,
  LocalWorkspaceAuthority,
  LocalWorkspaceSandbox,
} from "./localWorkspace.ts";

const temporaryRoots: string[] = [];

describe("LocalWorkspaceSandbox Git details", () => {
  beforeEach(() => {
    temporaryRoots.length = 0;
  });

  afterEach(() => {
    for (const root of temporaryRoots) {
      expect(root.startsWith(`${tmpdir()}${sep}crewon-local-workspace-`)).toBe(
        true,
      );
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes staged, unstaged, and untracked changes on a named branch", async () => {
    const { repository, sandbox } = createRepositorySandbox();
    writeFileSync(join(repository, "staged.txt"), "staged before\n");
    writeFileSync(join(repository, "unstaged.txt"), "unstaged before\n");
    writeFileSync(join(repository, "both.txt"), "both before\n");
    mkdirSync(join(repository, ".crewon"));
    writeFileSync(join(repository, ".crewon", "tracked.log"), "before\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "baseline");
    git(repository, "checkout", "-b", "feature/task-detail");

    writeFileSync(join(repository, "staged.txt"), "staged after\n");
    git(repository, "add", "staged.txt");
    writeFileSync(join(repository, "unstaged.txt"), "unstaged after\n");
    writeFileSync(join(repository, "both.txt"), "both staged\n");
    git(repository, "add", "both.txt");
    appendFileSync(join(repository, "both.txt"), "both unstaged\n");
    mkdirSync(join(repository, "nested"));
    writeFileSync(join(repository, "nested", "untracked.txt"), "new file\n");
    writeFileSync(join(repository, ".crewon", "tracked.log"), "after\n");
    writeFileSync(join(repository, ".crewon", "untracked.log"), "internal\n");

    const summary = await sandbox.readGitSummary();
    const result = await sandbox.readDiff();

    expect(summary).toEqual({
      cwd: "/workspace",
      isGitRepository: true,
      branch: "feature/task-detail",
      head: git(repository, "rev-parse", "HEAD").trim(),
      changedFiles: 4,
      additions: 5,
      deletions: 3,
      statsComplete: true,
    });
    expect("diff" in summary).toBe(false);
    expect(result).toMatchObject({
      cwd: "/workspace",
      isGitRepository: true,
      branch: "feature/task-detail",
      head: git(repository, "rev-parse", "HEAD").trim(),
      changedFiles: 4,
      additions: 5,
      deletions: 3,
      statsComplete: true,
      diffTruncated: false,
    });
    expect(result.diff).toContain("diff --git a/staged.txt b/staged.txt");
    expect(result.diff).toContain("diff --git a/unstaged.txt b/unstaged.txt");
    expect(result.diff).toContain("diff --git a/both.txt b/both.txt");
    expect(result.diff).toContain("both staged");
    expect(result.diff).toContain("both unstaged");
    expect(result.diff).toContain(
      "diff --git a/nested/untracked.txt b/nested/untracked.txt",
    );
    expect(result.diff).not.toContain(".crewon");
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(96 * 1024);
  });

  it("reports a detached HEAD without inventing a branch", async () => {
    const { repository, sandbox } = createRepositorySandbox();
    writeFileSync(join(repository, "tracked.txt"), "baseline\n");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-m", "baseline");
    const head = git(repository, "rev-parse", "HEAD").trim();
    git(repository, "checkout", "--detach", head);

    await expect(sandbox.readDiff()).resolves.toEqual({
      cwd: "/workspace",
      diff: "",
      isGitRepository: true,
      branch: null,
      head,
      changedFiles: 0,
      additions: 0,
      deletions: 0,
      statsComplete: true,
      diffTruncated: false,
    });
  });

  it("returns an explicit non-repository state for an ordinary directory", async () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const authority = new LocalWorkspaceAuthority(
      join(root, "state"),
      workspace,
    );
    const sandbox = new LocalWorkspaceSandbox(authority);

    await expect(sandbox.readGitSummary()).resolves.toEqual({
      cwd: "/workspace",
      isGitRepository: false,
      branch: null,
      head: null,
      changedFiles: 0,
      additions: 0,
      deletions: 0,
      statsComplete: false,
    });
    await expect(sandbox.readDiff()).resolves.toEqual({
      cwd: "/workspace",
      diff: "",
      isGitRepository: false,
      branch: null,
      head: null,
      changedFiles: 0,
      additions: 0,
      deletions: 0,
      statsComplete: false,
      diffTruncated: false,
    });
  });

  it("bounds a large untracked diff", async () => {
    const { repository, sandbox } = createRepositorySandbox();
    writeFileSync(join(repository, "baseline.txt"), "baseline\n");
    git(repository, "add", "baseline.txt");
    git(repository, "commit", "-m", "baseline");
    writeFileSync(join(repository, "large.txt"), "x".repeat(256 * 1024));

    const result = await sandbox.readDiff();

    expect(result.isGitRepository).toBe(true);
    expect(result.diff).toContain("diff --git a/large.txt b/large.txt");
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(96 * 1024);
    expect(result).toMatchObject({
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      statsComplete: true,
      diffTruncated: true,
    });
  });

  it("counts a binary file without inventing line changes", async () => {
    const { repository, sandbox } = createRepositorySandbox();
    writeFileSync(join(repository, "baseline.txt"), "baseline\n");
    git(repository, "add", "baseline.txt");
    git(repository, "commit", "-m", "baseline");
    writeFileSync(
      join(repository, "binary.dat"),
      Buffer.from([0, 1, 2, 3, 255]),
    );

    const result = await sandbox.readDiff();

    expect(result).toMatchObject({
      changedFiles: 1,
      additions: 0,
      deletions: 0,
      statsComplete: true,
      diffTruncated: false,
    });
    expect(result.diff).toContain("Binary files");
  });

  it("counts an empty untracked file without inventing line changes", async () => {
    const { repository, sandbox } = createRepositorySandbox();
    writeFileSync(join(repository, "baseline.txt"), "baseline\n");
    git(repository, "add", "baseline.txt");
    git(repository, "commit", "-m", "baseline");
    writeFileSync(join(repository, "empty.txt"), "");

    await expect(sandbox.readGitSummary()).resolves.toMatchObject({
      changedFiles: 1,
      additions: 0,
      deletions: 0,
      statsComplete: true,
    });
  });

  it("keeps large statistics complete independently of the diff cap", async () => {
    const { repository, sandbox } = createRepositorySandbox();
    const nested = join(
      repository,
      "a".repeat(100),
      "b".repeat(100),
      "c".repeat(100),
    );
    mkdirSync(nested, { recursive: true });
    for (let index = 0; index < 900; index += 1) {
      writeFileSync(
        join(nested, `tracked-${String(index).padStart(4, "0")}.txt`),
        "before\n",
      );
    }
    git(repository, "add", ".");
    git(repository, "commit", "-m", "large baseline");
    for (let index = 0; index < 900; index += 1) {
      writeFileSync(
        join(nested, `tracked-${String(index).padStart(4, "0")}.txt`),
        "after\n",
      );
    }

    const summary = await sandbox.readGitSummary();
    const result = await sandbox.readDiff();

    expect(summary).toMatchObject({
      isGitRepository: true,
      changedFiles: 900,
      additions: 900,
      deletions: 900,
      statsComplete: true,
    });
    expect("diff" in summary).toBe(false);
    expect(result.isGitRepository).toBe(true);
    expect(result.changedFiles).toBe(900);
    expect(result.additions).toBe(900);
    expect(result.deletions).toBe(900);
    expect(result.statsComplete).toBe(true);
    expect(result.diffTruncated).toBe(true);
  });

  it("rejects a Git summary when the selected workspace changes mid-read", async () => {
    const { authority, repository, sandbox } = createRepositorySandbox();
    writeFileSync(join(repository, "baseline.txt"), "baseline\n");
    git(repository, "add", "baseline.txt");
    git(repository, "commit", "-m", "baseline");
    const nextWorkspace = join(temporaryRoot(), "next-workspace");
    mkdirSync(nextWorkspace);

    const pending = sandbox.readGitSummary();
    authority.select(nextWorkspace, {
      expectedRevision: 0,
      idempotencyKey: "switch-during-summary",
    });

    await expect(pending).rejects.toThrow("desktop_sandbox_workspace_changed");
  });

  it("uses the platform Git null device", () => {
    expect(gitNullDevice("win32")).toBe("NUL");
    expect(gitNullDevice("darwin")).toBe("/dev/null");
    expect(gitNullDevice("linux")).toBe("/dev/null");
  });
});

function createRepositorySandbox(): {
  authority: LocalWorkspaceAuthority;
  repository: string;
  sandbox: LocalWorkspaceSandbox;
} {
  const root = temporaryRoot();
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init");
  git(repository, "config", "user.email", "tests@crewon.invalid");
  git(repository, "config", "user.name", "CrewON Tests");
  const authority = new LocalWorkspaceAuthority(
    join(root, "state"),
    repository,
  );
  return {
    authority,
    repository,
    sandbox: new LocalWorkspaceSandbox(authority),
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "crewon-local-workspace-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
