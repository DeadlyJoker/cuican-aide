import { parseTaskPack, TaskPackError, type TaskPack } from "./task-pack.ts";
import { meetingNotesPack } from "./meeting-notes.ts";

/** Only the host's bundled allowlist is registered. Never loads a path or URL. */
export const createTaskPackRegistry = (bundles: readonly unknown[]) => {
  if (bundles.length > 64) throw new TaskPackError("task_pack_registry_limit");
  const byVersion = new Map<string, TaskPack>();
  for (const input of bundles) {
    const pack = parseTaskPack(input);
    const key = `${pack.id}@${pack.version}`;
    if (byVersion.has(key))
      throw new TaskPackError("task_pack_duplicate_version");
    byVersion.set(key, pack);
  }
  return Object.freeze({
    list: () => Object.freeze([...byVersion.values()]),
    require: (id: string, version: string) => {
      const pack = byVersion.get(`${id}@${version}`);
      if (!pack) throw new TaskPackError("task_pack_version_not_bundled");
      return pack;
    },
  });
};

export const bundledTaskPacks = createTaskPackRegistry([meetingNotesPack]);
