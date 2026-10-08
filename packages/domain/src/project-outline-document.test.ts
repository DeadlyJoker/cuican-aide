import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseProjectOutlineDocument,
  ProjectOutlineDocumentError,
} from "./project-outline-document.ts";
import {
  evaluateProjectOutlineQuality,
  projectOutlineSkillView,
} from "./project-outline-quality.ts";
import { parseProjectOutlineContent } from "./project-text-content.ts";
import { projectOutlineAssetRequirements } from "./project-outline-asset-requirements.ts";
import type {
  ProjectOutlineDocument,
  ProjectOutlineBeat,
  ProjectOutlineEpisode,
  ProjectOutlineQualityGateId,
} from "./project-outline-document-types.ts";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
type EditableDocument = Mutable<ProjectOutlineDocument>;
type SkillFixture = Omit<
  ProjectOutlineDocument,
  "schemaVersion" | "title" | "logline" | "synopsis" | "beats" | "episodes"
> &
  Readonly<{
    beats: readonly (Omit<ProjectOutlineBeat, "episodeId"> & {
      episode: number;
    })[];
    episodes: readonly (Omit<
      ProjectOutlineEpisode,
      "episodeId" | "title" | "summary"
    > & { synopsis: string })[];
  }>;

const fixtureUrl = new URL(
  "./third-party/shuohao-outline/ferry-outline.fixture.json",
  import.meta.url,
);
const sourceBytes = await readFile(fixtureUrl);
assert.equal(
  createHash("sha256").update(sourceBytes).digest("hex"),
  "cd257e64909c7ceaef7701b826c3801870abd3c0ded37591ef5825e71627e5c0",
);
const fixture: SkillFixture = JSON.parse(sourceBytes.toString("utf8"));
function document(): ProjectOutlineDocument {
  return parseProjectOutlineDocument({
    ...fixture,
    schemaVersion: "crewon.project-outline-document.v2",
    title: "渡口",
    logline: "一船陌生人的秘密。",
    synopsis: "浓雾散去前，每个人都要亮一次底。",
    beats: fixture.beats.map((beat) => {
      const { episode, ...content } = beat;
      return { ...content, episodeId: "episode-" + episode };
    }),
    episodes: fixture.episodes.map((episode) => {
      const { synopsis, ...content } = episode;
      return {
        ...content,
        episodeId: "episode-" + content.ep,
        title: "第" + content.ep + "集",
        summary: synopsis,
      };
    }),
  });
}
function editable(): EditableDocument {
  return structuredClone(document()) as EditableDocument;
}
function gate(input: unknown, id: ProjectOutlineQualityGateId) {
  const report = evaluateProjectOutlineQuality(input, "full");
  const result = report.gates.find((item) => item.id === id);
  assert.ok(result);
  return { report, result };
}

test("the pinned licensed reference story actually passes all 14 Skill gates; source quotes remain unchecked", async () => {
  const core = await readFile(
    new URL("./third-party/shuohao-outline/core.mjs", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(core).digest("hex"),
    "f27b925bae25dbacd2fed71fbf997e57fc7a9628bca16e74f2298c651b004b83",
  );
  const report = evaluateProjectOutlineQuality(document(), "full");
  assert.equal(report.passed, true);
  assert.equal(report.gates.length, 14);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(
    report.gates
      .filter((item) => item.status === "skipped")
      .map((item) => item.id),
    [],
  );
  assert.equal(
    report.gates.find((item) => item.id === "refs")?.status,
    "passed",
  );
  assert.equal(report.sourceEvidenceVerification, "not-checked");
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.gates), true);
});

test("omitted optional props are explicitly skipped while actual character and scene references remain checked", () => {
  const value = editable();
  delete value.props;
  const report = evaluateProjectOutlineQuality(value, "full");
  assert.equal(report.passed, true);
  assert.deepEqual(
    report.gates
      .filter((item) => item.status === "skipped")
      .map((item) => item.id),
    ["prop-cap"],
  );
  const references = report.gates.find((item) => item.id === "refs");
  assert.equal(references?.status, "passed");
  assert.match(references!.detail, /道具引用未检查/u);
  value.episodes[0].characterIds.push("C99");
  assert.equal(
    evaluateProjectOutlineQuality(value, "full").gates.find(
      (item) => item.id === "refs",
    )?.status,
    "failed",
  );
});

test("derived asset requirements retain real entity and episode relationships; no model-written inventory or generated image is implied", () => {
  const value = editable();
  const index = projectOutlineAssetRequirements(value);
  assert.equal(index.characters.length, value.characters.length);
  assert.equal(index.scenes.length, value.scenes.length);
  assert.equal(index.props.length, value.props?.length);
  for (const character of index.characters) {
    assert.deepEqual(
      character.episodes.map((episode) => episode.episodeId),
      value.episodes
        .filter((episode) => episode.characterIds.includes(character.entityId))
        .map((episode) => episode.episodeId),
    );
  }
  value.characters[0].name = "改名的主角";
  const changed = projectOutlineAssetRequirements(value);
  assert.equal(changed.characters[0]!.entityId, index.characters[0]!.entityId);
  assert.deepEqual(
    changed.characters[0]!.episodes,
    index.characters[0]!.episodes,
  );
  assert.equal(index.characters[0]!.name, fixture.characters[0]!.name);
  assert.equal(Object.isFrozen(changed.characters[0]!.episodes), true);
  value.episodes[0].characterIds.push("C99");
  assert.equal(
    projectOutlineAssetRequirements(value).characters.some(
      (character) => character.entityId === "C99",
    ),
    false,
  );
  delete value.props;
  assert.deepEqual(projectOutlineAssetRequirements(value).props, []);
});

test("optional cast and prop count caps may explicitly be zero; beat spacing still requires a positive threshold", () => {
  const value = editable();
  value.params.thresholds = { maxFunctional: 0, maxProps: 0 };
  const parsed = parseProjectOutlineDocument(value);
  assert.equal(parsed.params.thresholds?.maxFunctional, 0);
  const checked = evaluateProjectOutlineQuality(parsed, "full");
  assert.equal(checked.passed, false);
  assert.equal(
    checked.gates.find((item) => item.id === "functional-cap")?.status,
    "failed",
  );
  assert.equal(
    checked.gates.find((item) => item.id === "prop-cap")?.status,
    "failed",
  );
});

const failingGates: readonly [
  ProjectOutlineQualityGateId,
  (value: EditableDocument) => void,
][] = [
  [
    "lead-cap",
    (value) => {
      for (const character of value.characters)
        if (character.tier === "lead") character.tier = "support";
    },
  ],
  [
    "support-cap",
    (value) => {
      for (let index = 10; index < 21; index++)
        value.characters.push({
          id: "C" + index,
          name: "重要配角",
          role: "推进线索",
          tier: "support",
          arc: "发现真相",
          from: ["原创"],
        });
    },
  ],
  [
    "functional-cap",
    (value) => {
      for (let index = 30; index < 41; index++)
        value.characters.push({
          id: "C" + index,
          name: "渡口店员",
          role: "报时",
          tier: "functional",
          from: ["原创"],
        });
    },
  ],
  [
    "scene-cap",
    (value) => {
      for (let index = 20; index < 26; index++)
        value.scenes.push({ id: "S" + index, name: "备用场景", primary: true });
    },
  ],
  [
    "prop-cap",
    (value) => {
      value.props = Array.from({ length: 9 }, (_, index) => ({
        id: "P" + (index + 10),
        name: "信物",
        function: "承载翻案线索",
      }));
    },
  ],
  [
    "once-scene",
    (value) => {
      value.scenes.push({ id: "S99", name: "一次性码头", primary: false });
      value.episodes[0].sceneIds.push("S99");
    },
  ],
  [
    "beat-gap",
    (value) => {
      value.beats = [];
    },
  ],
  [
    "ep1-hook",
    (value) => {
      value.episodes[0].hook = "";
    },
  ],
  [
    "major-early",
    (value) => {
      for (const beat of value.beats)
        if (beat.weight === "major")
          beat.episodeId = value.episodes.at(-1)!.episodeId;
    },
  ],
  [
    "ep-fields",
    (value) => {
      value.episodes[1].summary = "";
    },
  ],
  [
    "crowd-plan",
    (value) => {
      value.episodes[0].characterIds = ["C01", "C02", "C03"];
      delete value.episodes[0].crowdPlan;
    },
  ],
  [
    "risk-flag",
    (value) => {
      value.episodes[0].summary += "雨中有人牵手，众人围观指尖。";
      value.episodes[0].warnings = [];
    },
  ],
  [
    "refs",
    (value) => {
      value.episodes[0].characterIds.push("C99");
    },
  ],
  [
    "no-dialogue",
    (value) => {
      value.episodes[0].hook = "她喊道：“把皮箱留下。”";
    },
  ],
];
for (const [id, change] of failingGates) {
  test(`actual Skill gate ${id} rejects the corresponding flawed story`, () => {
    const value = editable();
    change(value);
    const checked = gate(value, id);
    assert.equal(checked.report.passed, false);
    assert.equal(checked.result.status, "failed");
    assert.ok(checked.report.problems.length > 0);
  });
}

test("skeleton and beats are genuine intermediate gates; incomplete episodes are not falsely marked checked", () => {
  const value = editable();
  value.episodes[0].summary = "";
  value.episodes[0].hook = "";
  const skeleton = evaluateProjectOutlineQuality(value, "skeleton");
  assert.equal(skeleton.passed, true);
  assert.equal(
    skeleton.gates.find((item) => item.id === "ep-fields")?.status,
    "skipped",
  );
  assert.equal(evaluateProjectOutlineQuality(value, "beats").passed, true);
  assert.equal(evaluateProjectOutlineQuality(value, "full").passed, false);
  value.beats = value.beats.filter(
    (beat: { weight: string }) => beat.weight !== "major",
  );
  assert.equal(evaluateProjectOutlineQuality(value, "skeleton").passed, true);
  assert.equal(evaluateProjectOutlineQuality(value, "beats").passed, false);
});

test("missing core, unconfirmed genre and non-faithful adaptation with no cuts cannot pass even if the visible caps pass", () => {
  const value = editable();
  value.adaptation.core = "";
  value.adaptation.cut = [];
  value.params.genre = "";
  const report = evaluateProjectOutlineQuality(value, "skeleton");
  assert.equal(report.passed, false);
  assert.ok(
    report.problems.some((problem) => problem.includes("adaptation.core")),
  );
  assert.ok(report.problems.some((problem) => problem.includes("genre")));
  assert.ok(
    report.problems.some((problem) => problem.includes("一条线都没砍")),
  );
});

test("stable episode references survive rename and display-order changes; unknown targets are diagnosed instead of reassigned", () => {
  const value = editable();
  const targetId = value.beats[0].episodeId;
  const target = value.episodes.find(
    (episode: { episodeId: string }) => episode.episodeId === targetId,
  );
  assert.ok(target);
  for (const episode of value.episodes) episode.title = "同名分集";
  value.episodes.splice(value.episodes.indexOf(target), 1);
  value.episodes.unshift(target);
  value.episodes.forEach((episode: { ep: number }, index: number) => {
    episode.ep = index + 1;
  });
  const parsed = parseProjectOutlineDocument(value);
  assert.equal(parsed.beats[0]!.episodeId, targetId);
  assert.equal(projectOutlineSkillView(parsed).beats[0]!.episode, 1);
  value.beats[0].episodeId = "missing-episode";
  const failed = gate(value, "refs");
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.report.passed, false);
  assert.match(failed.result.detail, /missing-episode/u);
  assert.ok(
    failed.report.problems.some((problem) =>
      problem.includes("beats[0].episodeId"),
    ),
  );
  assert.equal(
    parseProjectOutlineDocument(value).beats[0]!.episodeId,
    "missing-episode",
  );
});

test("the structured format supports a real 120-episode outline without increasing the legacy 16-episode limit", () => {
  const value = editable();
  const original = value.episodes;
  value.params.episodes = 120;
  value.episodes = Array.from({ length: 120 }, (_, index) => ({
    ...structuredClone(original[index % original.length]),
    ep: index + 1,
    episodeId: "long-episode-" + (index + 1),
  }));
  value.beats = Array.from({ length: 40 }, (_, index) => ({
    id: "B" + String(index + 1).padStart(2, "0"),
    type: "揭破",
    weight: index === 0 ? "major" : "minor",
    episodeId: value.episodes[index * 3].episodeId,
    setup: "追查线索",
    payoff: "秘密推进",
  }));
  const parsed = parseProjectOutlineDocument(value);
  assert.equal(parsed.episodes.length, 120);
  assert.equal(evaluateProjectOutlineQuality(parsed, "full").passed, true);
  const legacy = {
    title: "旧大纲",
    logline: "故事",
    synopsis: "梗概",
    episodes: Array.from({ length: 16 }, (_, index) => ({
      episodeId: "old-" + index,
      title: "旧集",
      summary: "旧故事",
    })),
  };
  assert.equal(parseProjectOutlineContent(legacy).episodes.length, 16);
  assert.throws(() =>
    parseProjectOutlineContent({
      ...legacy,
      episodes: [
        ...legacy.episodes,
        { episodeId: "old-extra", title: "额外", summary: "旧故事" },
      ],
    }),
  );
  assert.throws(() => parseProjectOutlineContent(parsed));
  assert.throws(() => parseProjectOutlineDocument(legacy));
});

test("the new document is detached and deeply immutable; quotes, whitespace and Unicode remain exact", () => {
  const value = editable();
  value.episodes[0].summary = " 第一行\n第二行🌙 ";
  const parsed = parseProjectOutlineDocument(value);
  value.episodes[0].summary = "later mutation";
  assert.equal(parsed.episodes[0]!.summary, " 第一行\n第二行🌙 ");
  assert.equal(Object.isFrozen(parsed.episodes[0]), true);
  assert.equal(Object.isFrozen(parsed.adaptation.keep[0]), true);
  assert.equal(
    parsed.adaptation.keep[0]!.evidence,
    fixture.adaptation.keep[0].evidence,
  );
});

test("unknown fields, invalid identities, duplicate references, non-JSON inputs and oversized documents fail with a field or limit", () => {
  const invalidInputs: readonly [string, (value: EditableDocument) => void][] =
    [
      [
        "$",
        (value) => {
          Object.assign(value, { ownerPrincipalId: "forged" });
        },
      ],
      [
        "$.episodes",
        (value) => {
          value.episodes[1].episodeId = value.episodes[0].episodeId;
        },
      ],
      [
        "$.episodes[0].characterIds",
        (value) => {
          value.episodes[0].characterIds = ["C01", "C01"];
        },
      ],
      [
        "$.characters[0].id",
        (value) => {
          value.characters[0].id = "../person";
        },
      ],
      [
        "$.params",
        (value) => {
          Object.assign(value.params, { authorized: true });
        },
      ],
      [
        "$.params.thresholds.maxBeatGap",
        (value) => {
          value.params.thresholds = { maxBeatGap: 0 };
        },
      ],
    ];
  for (const [path, change] of invalidInputs) {
    const value = editable();
    change(value);
    assert.throws(
      () => parseProjectOutlineDocument(value),
      (error) =>
        error instanceof ProjectOutlineDocumentError && error.path === path,
    );
  }
  const oversized = editable();
  oversized.synopsis = "文".repeat(100_000);
  assert.throws(
    () => parseProjectOutlineDocument(oversized),
    (error) =>
      error instanceof ProjectOutlineDocumentError &&
      error.code === "project_outline_document_limit",
  );
  let reads = 0;
  const accessor = editable();
  Object.defineProperty(accessor, "source", {
    enumerable: true,
    get() {
      reads++;
      return "forged";
    },
  });
  assert.throws(() => parseProjectOutlineDocument(accessor));
  assert.equal(reads, 0);
  const surrogate = editable();
  surrogate.episodes[0].summary = "\ud800";
  assert.throws(() => parseProjectOutlineDocument(surrogate));
  assert.throws(() =>
    evaluateProjectOutlineQuality(document(), "invalid" as never),
  );
});
