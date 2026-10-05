import type {
  ProjectTextOutlineContent,
  ProjectTextScriptContent,
} from "../project-texts-ui-service";

export type OutlineDraft = ProjectTextOutlineContent;
export type ScriptDraft = ProjectTextScriptContent;
export type TextDraft = OutlineDraft | ScriptDraft;

export const textBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const valid = (value: string, limit: number, empty = false): boolean => {
  if (!empty && !value.trim()) return false;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return false;
  }
  return new TextEncoder().encode(value).byteLength <= limit;
};
const title = (value: string): boolean =>
  valid(value, 640) && value === value.trim() && [...value].length <= 160;
export function outlineValid(draft: OutlineDraft): boolean {
  return (
    title(draft.title) &&
    valid(draft.logline, 2048) &&
    valid(draft.synopsis, 8192) &&
    draft.episodes.length > 0 &&
    draft.episodes.length <= 16 &&
    new Set(draft.episodes.map((episode) => episode.episodeId)).size ===
      draft.episodes.length &&
    draft.episodes.every(
      (episode) => title(episode.title) && valid(episode.summary, 8192),
    ) &&
    textBytes(draft) <= 16384
  );
}
export function scriptValid(draft: ScriptDraft): boolean {
  return (
    title(draft.title) &&
    draft.scenes.length > 0 &&
    draft.scenes.length <= 32 &&
    new Set(draft.scenes.map((scene) => scene.sceneId)).size ===
      draft.scenes.length &&
    draft.scenes.every(
      (scene) =>
        valid(scene.location, 640) &&
        valid(scene.timeOfDay, 320) &&
        valid(scene.action, 8192, true) &&
        (Boolean(scene.action.trim()) || scene.dialogue.length > 0) &&
        scene.dialogue.length <= 64 &&
        scene.dialogue.every(
          (line) => valid(line.speaker, 640) && valid(line.text, 8192),
        ),
    ) &&
    textBytes(draft) <= 32768
  );
}
export function emptyOutline(projectTitle: string): OutlineDraft {
  return { title: projectTitle, logline: "", synopsis: "", episodes: [] };
}
export function emptyScript(episodeTitle: string): ScriptDraft {
  return { title: episodeTitle, scenes: [] };
}
export function newEpisode() {
  return { episodeId: crypto.randomUUID(), title: "", summary: "" };
}
export function newScene() {
  return {
    sceneId: crypto.randomUUID(),
    location: "",
    timeOfDay: "",
    action: "",
    dialogue: [],
  };
}
