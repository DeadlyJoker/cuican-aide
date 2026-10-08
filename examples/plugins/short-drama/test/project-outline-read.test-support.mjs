// Public DTO fixtures for UI and codec checks; not database, Agent, or supplier evidence.
export function outlineReadFixture(projectId = "outline-project") {
  const calls = [],
    at = "2026-10-08T00:00:00.000Z";
  const digest = (revision) => "sha256:" + String(revision).repeat(64);
  const summary = (revision) => ({
    projectId,
    artifactId: "outline-artifact",
    contentRevision: revision,
    contentDigest: digest(revision),
    brief: { briefRevision: 1, contentDigest: digest(3) },
    format: "structured-v2",
    title: revision === 1 ? "雨夜来信" : "雨夜来信·新版本",
    createdAt: at,
    counts: { episodes: 12, characters: 1, scenes: 1, props: 1, beats: 1 },
    quality: { passed: false, problemCount: 1, failedGateCount: 1 },
  });
  const revisions = [summary(1), summary(2)];
  const view = {
    artifact: {
      projectId,
      artifactId: "outline-artifact",
      kind: "outline",
      episodeId: null,
      revision: 3,
      latestContentRevision: 2,
      selectedContentRevision: 1,
      locked: false,
      createdAt: at,
      updatedAt: at,
    },
    latestRevision: revisions[1],
    selectedRevision: revisions[0],
    staleReasons: [],
  };
  const items = (section, revision = 1) => {
    switch (section) {
      case "overview":
        return [
          {
            title: summary(revision).title,
            logline: "摄影师在雨夜收到未来来信。",
            synopsis: " 保留换行\n寻找父亲，回到港口。 ",
            source: "来信.md",
            lang: "zh",
            params: {
              episodes: 12,
              minutesPerEpisode: 2,
              genre: "悬疑",
              adaptMode: "抽核",
            },
          },
        ];
      case "episodes":
        return Array.from({ length: 12 }, (_, index) => ({
          episodeId: "episode-" + (index + 1),
          ep: index + 1,
          title: "来信" + (index + 1),
          summary: "第" + (index + 1) + "集故事正文",
          hook: "来信出现",
          suspense: "谁寄出了信？",
          sceneIds: ["S1"],
          characterIds: ["C1"],
          propIds: ["P1"],
          warnings: [],
          crowdPlan: "",
        }));
      case "characters":
        return [
          {
            id: "C1",
            name: "林雨",
            role: "摄影师",
            tier: "lead",
            arc: "从等待到主动寻找",
            from: ["第一章"],
          },
        ];
      case "scenes":
        return [
          {
            id: "S1",
            name: "港口",
            primary: true,
            reusePlan: "重逢和告别复用",
          },
        ];
      case "props":
        return [
          {
            id: "P1",
            name: "旧信",
            function: "引出父亲的线索",
            beatIds: ["B1"],
          },
        ];
      case "beats":
        return [
          {
            id: "B1",
            type: "真相揭露",
            weight: "major",
            setup: "旧信",
            payoff: "找到寄件人",
            episodeId: "episode-1",
          },
        ];
      case "adaptation":
        return [{ core: "保留父女重逢的情感主线" }];
      case "keep":
        return [
          { what: "来信", why: "贯穿主线", evidence: "雨夜收到未来来信。" },
        ];
      case "problems":
        return [{ index: 0, message: "补充角色在各集的出场关系。" }];
      default:
        return [];
    }
  };
  async function invoke(action, input) {
    calls.push({ action, input: structuredClone(input) });
    if (action === "crewon.project-outlines.v2.getOutline")
      return structuredClone({ view });
    if (action === "crewon.project-outlines.v2.listRevisions")
      return structuredClone({
        revisions: revisions
          .filter((r) => r.contentRevision > input.afterContentRevision)
          .slice(0, input.limit),
        nextContentRevision: null,
      });
    if (action !== "crewon.project-outlines.v2.getSection")
      throw Error("unknown_action");
    const all = items(input.section, input.contentRevision),
      end = Math.min(all.length, input.afterIndex + input.limit);
    return structuredClone({
      revision: summary(input.contentRevision),
      section: input.section,
      startIndex: input.afterIndex,
      totalItems: all.length,
      items: all.slice(input.afterIndex, end),
      nextIndex: end < all.length ? end : null,
    });
  }
  return { calls, view, revisions, items, services: { invoke } };
}
