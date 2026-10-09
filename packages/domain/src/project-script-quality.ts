import { copyExtensionJson } from "./extension-validation.ts";
import { parseProjectOutlineDocument } from "./project-outline-document.ts";
import { projectOutlineSkillView } from "./project-outline-quality.ts";
import type { ProjectOutlineDocument } from "./project-outline-document-types.ts";
import {
  parseProjectScriptDocument,
  parseProjectScriptArtReferences,
  ProjectScriptDocumentError,
} from "./project-script-document.ts";
import {
  PROJECT_SCRIPT_DOCUMENT_SCHEMA,
  DEFAULT_PROJECT_SCRIPT_BATCH_SIZE,
  MAX_PROJECT_SCRIPT_DOCUMENT_BYTES,
  type ProjectScriptDocument,
  type ProjectScriptArtReferences,
  type ProjectScriptQualityGate,
} from "./project-script-document-types.ts";
import {
  computeStats,
  gateReport,
  validateScript,
  sceneSeconds,
} from "./third-party/shuohao-script/core.mjs";

export const PROJECT_SCRIPT_SKILL_REVISION =
  "ef4ac0c313c7eeb1f918db5f0f0eb319745900bc";
export const PROJECT_SCRIPT_SKILL_SOURCE_DIGEST =
  "sha256:833511f3dcc01373687f12065cb8c843e505958fb344d015535ffb4c928bc7bc";
export type ProjectScriptQualityContext = Readonly<{
  outline?: ProjectOutlineDocument;
  art?: ProjectScriptArtReferences;
}>;

/** Seed only: selected original IDs and upstream facts; no model, write or Run authority. */
export function seedProjectScriptDocument(
  outlineInput: unknown,
  episodeIds: readonly string[],
): ProjectScriptDocument {
  const outline = parseProjectOutlineDocument(outlineInput);
  let selected: unknown;
  try {
    selected = copyExtensionJson(episodeIds, 4096);
  } catch {
    throw new ProjectScriptDocumentError(
      "project_script_batch_invalid",
      "$.episodeIds",
    );
  }
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > DEFAULT_PROJECT_SCRIPT_BATCH_SIZE ||
    new Set(selected).size !== selected.length ||
    selected.some(
      (id) =>
        typeof id !== "string" ||
        !outline.episodes.some((ep) => ep.episodeId === id),
    )
  )
    throw new ProjectScriptDocumentError(
      "project_script_batch_invalid",
      "$.episodeIds",
    );
  return parseProjectScriptDocument({
    schemaVersion: PROJECT_SCRIPT_DOCUMENT_SCHEMA,
    source: outline.source,
    episodes: selected.map((id) => {
      const episode = outline.episodes.find(
        (episode) => episode.episodeId === id,
      )!;
      return {
        episodeId: episode.episodeId,
        ep: episode.ep,
        targetSeconds: outline.params.minutesPerEpisode * 60,
        hook: episode.hook,
        cliff: episode.suspense,
        beatsClaimed: outline.beats
          .filter((beat) => beat.episodeId === episode.episodeId)
          .map((beat) => beat.id),
        hookBeat: null,
        scenes: [],
      };
    }),
  });
}

function parseContext(
  input: ProjectScriptQualityContext,
): ProjectScriptQualityContext {
  let copied: unknown;
  try {
    copied = copyExtensionJson(input, MAX_PROJECT_SCRIPT_DOCUMENT_BYTES * 2);
  } catch {
    throw new ProjectScriptDocumentError(
      "project_script_context_invalid",
      "$.context",
    );
  }
  if (
    !copied ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).some((key) => key !== "outline" && key !== "art")
  )
    throw new ProjectScriptDocumentError(
      "project_script_context_invalid",
      "$.context",
    );
  const raw = copied as Record<string, unknown>;
  return Object.freeze({
    ...(Object.hasOwn(raw, "outline")
      ? { outline: parseProjectOutlineDocument(raw.outline) }
      : {}),
    ...(Object.hasOwn(raw, "art")
      ? { art: parseProjectScriptArtReferences(raw.art) }
      : {}),
  });
}

/** Only a temporary Skill view uses numeric positions and S aliases. Stored identities remain intact. */
function skillView(
  document: ProjectScriptDocument,
  context: ProjectScriptQualityContext,
) {
  const ids = [
    ...new Set([
      ...(context.art?.scenes.map((scene) => scene.id) ?? []),
      ...document.episodes.flatMap((episode) =>
        episode.scenes.map((scene) => scene.sceneId),
      ),
    ]),
  ];
  const aliases = new Map(
    ids.map((id, i) => [id, "S" + String(i + 1).padStart(2, "0")]),
  );
  const originals = new Map([...aliases].map(([id, alias]) => [alias, id]));
  const restore = (text: string) =>
    text.replace(/\bS\d{2,}\b/g, (alias) => originals.get(alias) ?? alias);
  const view = {
    source: document.source,
    params: document.params,
    episodes: document.episodes.map((episode) => {
      let hookBeat: [number, number] = [0, 0];
      episode.scenes.forEach((scene, si) =>
        scene.flow.forEach((beat, bi) => {
          if (beat.beatId === episode.hookBeat) hookBeat = [si + 1, bi + 1];
        }),
      );
      return {
        ...episode,
        hookBeat,
        beatsClaimed: episode.beatsClaimed.map(
          (id) =>
            context.outline?.beats.find((beat) => beat.id === id)?.type ?? id,
        ),
        scenes: episode.scenes.map((scene) => ({
          ...scene,
          sceneId: aliases.get(scene.sceneId)!,
          flow: scene.flow.map((beat) =>
            beat.kind === "action"
              ? { action: beat.action }
              : {
                  speaker: beat.speaker,
                  line: beat.line,
                  ...(beat.delivery === undefined
                    ? {}
                    : { delivery: beat.delivery }),
                },
          ),
        })),
      };
    }),
  };
  const art =
    context.art === undefined
      ? undefined
      : {
          scenes: context.art.scenes.map((scene) => ({
            ...scene,
            id: aliases.get(scene.id)!,
          })),
          props: context.art.props,
        };
  return {
    view,
    restore,
    context: {
      ...(context.outline === undefined
        ? {}
        : { outline: projectOutlineSkillView(context.outline) }),
      ...(art === undefined ? {} : { art }),
    },
  };
}

function sourceProblems(
  document: ProjectScriptDocument,
  outline: ProjectOutlineDocument | undefined,
) {
  const duration: string[] = [];
  const claims: string[] = [];
  if (outline === undefined) return { duration, claims };
  for (const episode of document.episodes) {
    const source = outline.episodes.find(
      (ep) => ep.episodeId === episode.episodeId,
    );
    if (source === undefined || source.ep !== episode.ep)
      claims.push(`分集 ${episode.episodeId} 与大纲身份或当前集号不匹配。`);
    if (episode.targetSeconds !== outline.params.minutesPerEpisode * 60)
      duration.push(`分集 ${episode.episodeId} 的目标秒数与大纲不匹配。`);
    const due = outline.beats
      .filter((beat) => beat.episodeId === episode.episodeId)
      .map((beat) => beat.id);
    for (const id of due)
      if (!episode.beatsClaimed.includes(id))
        claims.push(`分集 ${episode.episodeId} 未认领爽点 ${id}。`);
    for (const id of episode.beatsClaimed)
      if (!due.includes(id))
        claims.push(`分集 ${episode.episodeId} 认领了非本集爽点 ${id}。`);
  }
  return { duration, claims };
}

/** Pinned deterministic estimates; ordered dialogue retains stable IDs for later TTS and storyboard consumers. */
export function projectScriptStatistics(input: unknown) {
  const document = parseProjectScriptDocument(input);
  const stats = computeStats(document);
  const scenes = document.episodes.flatMap((episode) =>
    episode.scenes.map((scene) => ({ episodeId: episode.episodeId, scene })),
  );
  const dialogue = document.episodes.flatMap((episode) =>
    episode.scenes.flatMap((scene) =>
      scene.flow.flatMap((beat) =>
        beat.kind === "action"
          ? []
          : [
              Object.freeze({
                episodeId: episode.episodeId,
                ep: episode.ep,
                sceneKey: scene.sceneKey,
                sceneId: scene.sceneId,
                beatId: beat.beatId,
                speaker: beat.speaker,
                line: beat.line,
                delivery: beat.delivery ?? "",
                estimatedSeconds: sceneSeconds(
                  { flow: [beat] },
                  document.params,
                ).total,
              }),
            ],
      ),
    ),
  );
  return Object.freeze({
    params: document.params,
    episodes: Object.freeze(
      stats.episodes.map((episode, i) =>
        Object.freeze({
          ...episode,
          episodeId: document.episodes[i]!.episodeId,
        }),
      ),
    ),
    scenes: Object.freeze(
      stats.sceneTable.map((scene, i) =>
        Object.freeze({
          ...scene,
          characters: scenes[i]!.scene.characters,
          props: scenes[i]!.scene.props ?? Object.freeze([]),
          episodeId: scenes[i]!.episodeId,
          sceneKey: scenes[i]!.scene.sceneKey,
        }),
      ),
    ),
    dialogue: Object.freeze(dialogue),
    voices: Object.freeze(
      stats.castLines.map((cast) =>
        Object.freeze({
          speaker: cast.id,
          count: cast.count,
          chars: cast.chars,
          lines: Object.freeze(
            dialogue.filter((line) => line.speaker === cast.id),
          ),
        }),
      ),
    ),
    totals: Object.freeze(stats.totals),
  });
}

export function evaluateProjectScriptQuality(
  input: unknown,
  rawContext: ProjectScriptQualityContext = {},
) {
  const document = parseProjectScriptDocument(input);
  const context = parseContext(rawContext);
  const skill = skillView(document, context);
  const extra = sourceProblems(document, context.outline);
  const gates: readonly ProjectScriptQualityGate[] = Object.freeze(
    gateReport(skill.view, skill.context).map((gate) => {
      const additions =
        gate.id === "duration"
          ? extra.duration
          : gate.id === "beats-claimed"
            ? extra.claims
            : [];
      const skipped =
        ((gate.id === "beats-claimed" || gate.id === "refs-characters") &&
          context.outline === undefined) ||
        (gate.id === "refs-scenes" && context.art === undefined);
      return Object.freeze({
        id: gate.id as ProjectScriptQualityGate["id"],
        label: gate.label,
        status: skipped
          ? ("skipped" as const)
          : gate.ok && additions.length === 0
            ? ("passed" as const)
            : ("failed" as const),
        detail: skipped
          ? "未提供对应上游资料，本项未核验。"
          : [skill.restore(gate.detail), ...additions]
              .filter(Boolean)
              .join("；"),
      });
    }),
  );
  const problems = Object.freeze([
    ...validateScript(skill.view, skill.context).map(skill.restore),
    ...extra.duration,
    ...extra.claims,
  ]);
  return Object.freeze({
    schemaVersion: "crewon.project-script-quality.v1" as const,
    valid: problems.length === 0,
    allGatesPassed:
      problems.length === 0 && gates.every((gate) => gate.status === "passed"),
    skill: Object.freeze({
      name: "novel-script" as const,
      revision: PROJECT_SCRIPT_SKILL_REVISION,
      sourceDigest: PROJECT_SCRIPT_SKILL_SOURCE_DIGEST,
    }),
    gates,
    problems,
    statistics: projectScriptStatistics(document),
    sourceEvidenceVerification: "not-checked" as const,
  });
}
