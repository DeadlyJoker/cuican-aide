import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseProjectOutlineDocument } from "./project-outline-document.ts";
import type {
  ProjectOutlineDocument,
  ProjectOutlineBeat,
  ProjectOutlineEpisode,
} from "./project-outline-document-types.ts";
import {
  parseProjectScriptDocument,
  parseProjectScriptArtReferences,
  ProjectScriptDocumentError,
} from "./project-script-document.ts";
import {
  MAX_PROJECT_SCRIPT_DOCUMENT_BYTES,
  type ProjectScriptDocument,
  type ProjectScriptQualityGateId,
} from "./project-script-document-types.ts";
import {
  evaluateProjectScriptQuality,
  projectScriptStatistics,
  seedProjectScriptDocument,
} from "./project-script-quality.ts";
import { parseProjectScriptContent } from "./project-text-content.ts";
import {
  computeStats,
  gateReport,
} from "./third-party/shuohao-script/core.mjs";

type Mutable<T> = T extends readonly (infer I)[]
  ? Mutable<I>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type RawScript = {
  source: string;
  episodes: {
    ep: number;
    targetSeconds: number;
    hook: string;
    cliff: string;
    beatsClaimed: string[];
    hookBeat: [number, number];
    scenes: {
      sceneId: string;
      lighting?: string;
      characters: string[];
      props?: string[];
      flow: (
        | { action: string }
        | { speaker: string; line: string; delivery?: string }
      )[];
    }[];
  }[];
};
type RawOutline = Omit<
  ProjectOutlineDocument,
  "schemaVersion" | "title" | "logline" | "synopsis" | "beats" | "episodes"
> & {
  beats: (Omit<ProjectOutlineBeat, "episodeId"> & { episode: number })[];
  episodes: (Omit<ProjectOutlineEpisode, "episodeId" | "title" | "summary"> & {
    synopsis: string;
  })[];
};
const fixtureBytes = await readFile(
  new URL(
    "./third-party/shuohao-script/ferry-script.fixture.json",
    import.meta.url,
  ),
);
const artBytes = await readFile(
  new URL(
    "./third-party/shuohao-script/ferry-art.fixture.json",
    import.meta.url,
  ),
);
const fixture: RawScript = JSON.parse(fixtureBytes.toString());
const rawOutline: RawOutline = JSON.parse(
  await readFile(
    new URL(
      "./third-party/shuohao-outline/ferry-outline.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const rawArt: {
  scenes: { id: string; lighting: { state: string }[] }[];
  props: { id: string }[];
} = JSON.parse(artBytes.toString());
function outline(): ProjectOutlineDocument {
  return parseProjectOutlineDocument({
    ...rawOutline,
    schemaVersion: "crewon.project-outline-document.v2",
    title: "渡口",
    logline: "渡船上的秘密。",
    synopsis: "雾散前，秘密逐个揭开。",
    beats: rawOutline.beats.map(({ episode, ...beat }) => ({
      ...beat,
      episodeId: "episode-" + episode,
    })),
    episodes: rawOutline.episodes.map(({ synopsis, ...episode }) => ({
      ...episode,
      episodeId: "episode-" + episode.ep,
      title: "第" + episode.ep + "集",
      summary: synopsis,
    })),
  });
}
function art() {
  return parseProjectScriptArtReferences({
    scenes: rawArt.scenes.map((scene) => ({
      id: scene.id,
      lighting: scene.lighting.map((light) => ({ state: light.state })),
    })),
    props: rawArt.props.map((prop) => ({ id: prop.id })),
  });
}
function document(): ProjectScriptDocument {
  return parseProjectScriptDocument({
    schemaVersion: "crewon.project-script-document.v2",
    source: fixture.source,
    episodes: fixture.episodes.map((episode) => ({
      ...episode,
      episodeId: "episode-" + episode.ep,
      beatsClaimed: rawOutline.beats
        .filter((beat) => beat.episode === episode.ep)
        .map((beat) => beat.id),
      hookBeat: `beat-${episode.ep}-${episode.hookBeat[0]}-${episode.hookBeat[1]}`,
      scenes: episode.scenes.map((scene, si) => ({
        ...scene,
        sceneKey: `scene-${episode.ep}-${si + 1}`,
        flow: scene.flow.map((beat, bi) => ({
          ...beat,
          beatId: `beat-${episode.ep}-${si + 1}-${bi + 1}`,
          kind: "action" in beat ? "action" : "dialogue",
        })),
      })),
    })),
  });
}
function editable(): Mutable<ProjectScriptDocument> {
  return structuredClone(document()) as Mutable<ProjectScriptDocument>;
}
function report(input: unknown) {
  return evaluateProjectScriptQuality(input, {
    outline: outline(),
    art: art(),
  });
}

test("the pinned six-episode reference passes the actual ten gates with exact upstream timing and fixture provenance", async () => {
  for (const [bytes, expected] of [
    [
      fixtureBytes,
      "74dd50ba759f86644ca92e150f75b3a4fbddf8708106782f4ff6adcfebc95417",
    ],
    [
      artBytes,
      "5fda31a22043fda47c78a4a04eaa20289b46325a76d502fb36454f849c084500",
    ],
    [
      await readFile(
        new URL("./third-party/shuohao-script/core.mjs", import.meta.url),
      ),
      "229b7989994cf8f68f63cf07fa337192789421542f1c06c6e62023cbc8cde8fa",
    ],
  ] as const)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  const original = gateReport(fixture, { outline: rawOutline, art: rawArt });
  assert.equal(
    original.every((gate) => gate.ok),
    true,
  );
  const actual = report(document());
  assert.equal(actual.valid, true);
  assert.equal(actual.allGatesPassed, true);
  assert.equal(actual.gates.length, 10);
  assert.deepEqual(actual.problems, []);
  assert.deepEqual(
    actual.gates.map((gate) => [gate.id, gate.status]),
    original.map((gate) => [gate.id, "passed"]),
  );
  const expected = computeStats(fixture);
  assert.deepEqual(actual.statistics.totals, expected.totals);
  assert.deepEqual(
    actual.statistics.episodes.map(({ episodeId, ...value }) => value),
    expected.episodes,
  );
  assert.deepEqual(
    actual.statistics.scenes.map(({ episodeId, sceneKey, ...value }) => value),
    expected.sceneTable,
  );
  assert.equal(actual.statistics.dialogue.length, 123);
  assert.equal(actual.sourceEvidenceVerification, "not-checked");
  assert.equal(Object.isFrozen(actual.statistics.voices[0]!.lines), true);
});

test("seed batches retain original IDs, hooks, suspense and budgets while a full document is not restricted to three episodes", () => {
  const upstream = outline();
  const seed = seedProjectScriptDocument(upstream, ["episode-3", "episode-1"]);
  assert.deepEqual(
    seed.episodes.map((ep) => ep.episodeId),
    ["episode-3", "episode-1"],
  );
  for (const episode of seed.episodes) {
    const original = upstream.episodes.find(
      (ep) => ep.episodeId === episode.episodeId,
    )!;
    assert.equal(episode.hook, original.hook);
    assert.equal(episode.cliff, original.suspense);
    assert.equal(episode.targetSeconds, upstream.params.minutesPerEpisode * 60);
    assert.deepEqual(episode.scenes, []);
    assert.equal(episode.hookBeat, null);
  }
  assert.equal(report(seed).valid, false);
  assert.equal(document().episodes.length, 6);
  for (const ids of [
    [],
    ["episode-1", "episode-1"],
    ["missing"],
    upstream.episodes.slice(0, 4).map((ep) => ep.episodeId),
  ])
    assert.throws(
      () => seedProjectScriptDocument(upstream, ids),
      ProjectScriptDocumentError,
    );
});

const gateCases: readonly [
  ProjectScriptQualityGateId,
  (value: Mutable<ProjectScriptDocument>) => void,
][] = [
  [
    "duration",
    (value) => {
      value.episodes[0]!.targetSeconds = 10;
    },
  ],
  [
    "line-length",
    (value) => {
      const beat = value.episodes[0]!.scenes[0]!.flow.find(
        (beat) => beat.kind === "dialogue",
      )!;
      if (beat.kind === "dialogue") beat.line = "字".repeat(40);
    },
  ],
  [
    "speaker",
    (value) => {
      const beat = value.episodes[0]!.scenes[0]!.flow.find(
        (beat) => beat.kind === "dialogue",
      )!;
      if (beat.kind === "dialogue") beat.speaker = "C99";
    },
  ],
  [
    "hook-cliff",
    (value) => {
      value.episodes[0]!.cliff = "";
    },
  ],
  [
    "hook-open",
    (value) => {
      value.episodes[0]!.hookBeat =
        value.episodes[0]!.scenes[0]!.flow.at(-1)!.beatId;
    },
  ],
  [
    "has-action",
    (value) => {
      value.episodes[0]!.scenes[0]!.flow =
        value.episodes[0]!.scenes[0]!.flow.filter(
          (beat) => beat.kind === "dialogue",
        );
    },
  ],
  [
    "action-prose",
    (value) => {
      const beat = value.episodes[0]!.scenes[0]!.flow.find(
        (beat) => beat.kind === "action",
      )!;
      if (beat.kind === "action") beat.action = "她说：“等一下。”";
    },
  ],
  [
    "beats-claimed",
    (value) => {
      value.episodes[0]!.beatsClaimed = [];
    },
  ],
  [
    "refs-characters",
    (value) => {
      value.episodes[0]!.scenes[0]!.characters.push("C99");
    },
  ],
  [
    "refs-scenes",
    (value) => {
      value.episodes[0]!.scenes[0]!.sceneId = "missing-scene";
    },
  ],
];
for (const [id, mutate] of gateCases)
  test(`the real ${id} gate rejects invalid content`, () => {
    const value = editable();
    mutate(value);
    const actual = report(value);
    assert.equal(actual.gates.find((gate) => gate.id === id)?.status, "failed");
    assert.equal(actual.valid, false);
    assert.equal(actual.allGatesPassed, false);
    if (id === "refs-scenes")
      assert.match(actual.problems.join("\n"), /missing-scene/);
  });

test("lighting, props, same-type beat omissions and current episode order are independently checked", () => {
  const value = editable();
  value.episodes[0]!.scenes[0]!.lighting = "unknown-state";
  assert.equal(
    report(value).gates.find((gate) => gate.id === "refs-scenes")?.status,
    "failed",
  );
  const props = editable();
  props.episodes[0]!.scenes[0]!.props = ["P99"];
  assert.equal(
    report(props).gates.find((gate) => gate.id === "refs-scenes")?.status,
    "failed",
  );
  const source = structuredClone(outline()) as Mutable<ProjectOutlineDocument>;
  source.beats.push({ ...source.beats[0]!, id: "B99" });
  const claims = evaluateProjectScriptQuality(document(), {
    outline: source,
    art: art(),
  });
  assert.equal(
    claims.gates.find((gate) => gate.id === "beats-claimed")?.status,
    "failed",
  );
  assert.match(claims.problems.join("\n"), /B99/);
  const renumbered = editable();
  renumbered.episodes[0]!.ep = 7;
  assert.equal(
    report(renumbered).gates.find((gate) => gate.id === "beats-claimed")
      ?.status,
    "failed",
  );
});

test("missing upstream references remain skipped, never reported as fully verified", () => {
  const actual = evaluateProjectScriptQuality(document());
  assert.equal(actual.valid, true);
  assert.equal(actual.allGatesPassed, false);
  assert.deepEqual(
    actual.gates
      .filter((gate) => gate.status === "skipped")
      .map((gate) => gate.id),
    ["beats-claimed", "refs-characters", "refs-scenes"],
  );
});

test("opaque art IDs and stable hook IDs are preserved; cross-episode hook references fail without positional reinterpretation", () => {
  const value = editable();
  const refs = structuredClone(art()) as Mutable<ReturnType<typeof art>>;
  const old = refs.scenes[0]!.id;
  const originalScene = value.episodes
    .flatMap((episode) => episode.scenes)
    .find((scene) => scene.sceneId === old);
  assert.ok(originalScene);
  refs.scenes[0]!.id = "original-art-scene-a7c";
  for (const episode of value.episodes)
    for (const scene of episode.scenes)
      if (scene.sceneId === old) scene.sceneId = refs.scenes[0]!.id;
  assert.equal(
    evaluateProjectScriptQuality(value, { outline: outline(), art: refs })
      .allGatesPassed,
    true,
  );
  assert.equal(originalScene.sceneId, refs.scenes[0]!.id);
  value.episodes[0]!.hookBeat = value.episodes[1]!.scenes[0]!.flow[0]!.beatId;
  assert.equal(
    evaluateProjectScriptQuality(value, {
      outline: outline(),
      art: refs,
    }).gates.find((gate) => gate.id === "hook-open")?.status,
    "failed",
  );
});

test("reference context rejects getters and unknown fields without executing accessors; null timing parameters do not silently default", () => {
  let touched = false;
  const context = {};
  Object.defineProperty(context, "outline", {
    enumerable: true,
    get() {
      touched = true;
      return outline();
    },
  });
  assert.throws(
    () => evaluateProjectScriptQuality(document(), context),
    ProjectScriptDocumentError,
  );
  assert.equal(touched, false);
  assert.throws(
    () =>
      evaluateProjectScriptQuality(document(), { unexpected: true } as never),
    ProjectScriptDocumentError,
  );
  assert.throws(
    () => parseProjectScriptArtReferences({ ...art(), extra: true }),
    ProjectScriptDocumentError,
  );
  for (const key of Object.keys(document().params))
    assert.throws(
      () =>
        parseProjectScriptDocument({
          ...document(),
          params: { ...document().params, [key]: null },
        }),
      ProjectScriptDocumentError,
    );
  const raw = { ...document() };
  Reflect.deleteProperty(raw, "params");
  assert.deepEqual(parseProjectScriptDocument(raw).params, document().params);
});

test("stable flow, occurrence and voice IDs survive names and display order changes; ordered dialogue is exact", () => {
  const value = editable();
  const before = projectScriptStatistics(value);
  value.episodes.reverse();
  const after = projectScriptStatistics(value);
  assert.deepEqual(
    new Set(after.dialogue.map((line) => line.beatId)),
    new Set(before.dialogue.map((line) => line.beatId)),
  );
  for (const line of after.dialogue)
    assert.deepEqual(
      line,
      before.dialogue.find((old) => old.beatId === line.beatId),
    );
  const upstream = structuredClone(
    outline(),
  ) as Mutable<ProjectOutlineDocument>;
  upstream.characters[0]!.name = "改名";
  upstream.scenes[0]!.name = "新场景名";
  assert.equal(
    evaluateProjectScriptQuality(value, { outline: upstream, art: art() })
      .allGatesPassed,
    true,
  );
  const first = value.episodes[0]!.scenes[0]!;
  const repeated = structuredClone(first);
  repeated.sceneKey = "new-occurrence";
  repeated.flow = repeated.flow.map((beat) => ({
    ...beat,
    beatId: "new-" + beat.beatId,
  }));
  value.episodes[0]!.scenes.push(repeated);
  assert.equal(
    parseProjectScriptDocument(value).episodes[0]!.scenes.at(-1)!.sceneId,
    first.sceneId,
  );
});

test("scene counts above the legacy limit are supported within the byte budget, without invented screenplay caps", () => {
  const value = editable();
  value.episodes = [value.episodes[0]!];
  value.episodes[0]!.scenes = Array.from({ length: 40 }, (_, i) => ({
    sceneKey: "occurrence-" + i,
    sceneId: "S01",
    characters: [],
    flow: [
      { kind: "action" as const, beatId: "action-" + i, action: "她走上船。" },
    ],
  }));
  assert.equal(
    parseProjectScriptDocument(value).episodes[0]!.scenes.length,
    40,
  );
});

test("strict content boundaries reject ambiguity, duplicate IDs, executable objects and legacy reinterpretation", () => {
  const first = editable();
  first.episodes[0]!.scenes[0]!.flow[0] = {
    ...first.episodes[0]!.scenes[0]!.flow[0]!,
    line: "混写",
  } as never;
  assert.throws(
    () => parseProjectScriptDocument(first),
    ProjectScriptDocumentError,
  );
  for (const mutate of [
    (v: Mutable<ProjectScriptDocument>) => {
      v.episodes[1]!.episodeId = v.episodes[0]!.episodeId;
    },
    (v: Mutable<ProjectScriptDocument>) => {
      v.episodes[1]!.scenes[0]!.sceneKey = v.episodes[0]!.scenes[0]!.sceneKey;
    },
    (v: Mutable<ProjectScriptDocument>) => {
      v.episodes[1]!.scenes[0]!.flow[0]!.beatId =
        v.episodes[0]!.scenes[0]!.flow[0]!.beatId;
    },
  ]) {
    const value = editable();
    mutate(value);
    assert.throws(
      () => parseProjectScriptDocument(value),
      ProjectScriptDocumentError,
    );
  }
  let touched = false;
  const getter = { ...document() };
  Object.defineProperty(getter, "source", {
    enumerable: true,
    get() {
      touched = true;
      return "bad";
    },
  });
  assert.throws(
    () => parseProjectScriptDocument(getter),
    ProjectScriptDocumentError,
  );
  assert.equal(touched, false);
  assert.throws(
    () =>
      parseProjectScriptDocument(Object.assign(Object.create({}), document())),
    ProjectScriptDocumentError,
  );
  const cycle = { ...document(), cycle: {} };
  cycle.cycle = cycle;
  assert.throws(
    () => parseProjectScriptDocument(cycle),
    ProjectScriptDocumentError,
  );
  assert.throws(
    () =>
      parseProjectScriptDocument({
        ...document(),
        source: "x".repeat(MAX_PROJECT_SCRIPT_DOCUMENT_BYTES),
      }),
    ProjectScriptDocumentError,
  );
  for (const bad of [null, -1, NaN, Infinity, -Number.EPSILON])
    assert.throws(
      () =>
        parseProjectScriptDocument({
          ...document(),
          params: { ...document().params, tolerance: bad },
        }),
      ProjectScriptDocumentError,
    );
  assert.equal(
    parseProjectScriptDocument({
      ...document(),
      params: { ...document().params, tolerance: 0 },
    }).params.tolerance,
    0,
  );
  assert.throws(() => parseProjectScriptContent(document()));
  assert.throws(
    () => parseProjectScriptDocument({ title: "旧剧本", scenes: [] }),
    ProjectScriptDocumentError,
  );
  assert.equal(
    Object.isFrozen(document().episodes[0]!.scenes[0]!.flow[0]!),
    true,
  );
});
