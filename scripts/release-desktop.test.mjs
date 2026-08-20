import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  githubRepositoryFromUpdaterEndpoint,
  resolveGithubReleaseRemote,
} from "./release-desktop.mjs";

const repository = "DeadlyJoker/cuican-aide";
const remotes = [
  {
    name: "origin",
    url: "git@codeup.aliyun.com:team/crewon.git",
  },
  {
    name: "github",
    url: "git@github.com:DeadlyJoker/cuican-aide.git",
  },
];

test("derives the release repository from the committed updater endpoint", () => {
  assert.equal(
    githubRepositoryFromUpdaterEndpoint(
      "https://github.com/DeadlyJoker/cuican-aide/releases/latest/download/latest.json",
    ),
    repository,
  );
  assert.throws(
    () =>
      githubRepositoryFromUpdaterEndpoint("https://example.com/latest.json"),
    /updater repository is invalid/u,
  );
});

test("selects only the exact updater GitHub push remote", () => {
  assert.equal(resolveGithubReleaseRemote({ remotes, repository }), "github");
  assert.equal(
    resolveGithubReleaseRemote({ remotes, repository, requested: "github" }),
    "github",
  );
  assert.throws(
    () =>
      resolveGithubReleaseRemote({ remotes, repository, requested: "origin" }),
    /is not the updater GitHub repository/u,
  );
  assert.throws(
    () =>
      resolveGithubReleaseRemote({
        remotes: [remotes[1], { name: "mirror", url: remotes[1].url }],
        repository,
      }),
    /exactly one GitHub remote/u,
  );
});

test("release launcher and docs do not direct tags to origin", () => {
  const launcher = readFileSync(
    new URL("./release-desktop.mjs", import.meta.url),
    "utf8",
  );
  const documentation = readFileSync(
    new URL("../docs/desktop-release.md", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(launcher, /git push origin/u);
  assert.doesNotMatch(documentation, /git push origin/u);
  assert.match(documentation, /--remote <github-remote-name>/u);
});
