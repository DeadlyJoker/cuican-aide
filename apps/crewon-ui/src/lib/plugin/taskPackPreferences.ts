import {
  parseTaskPackConfiguration,
  taskPackDefaults,
  type TaskPack,
  type TaskPackConfiguration,
} from "@crewon/capability-packs";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const key = (userId: number, pack: TaskPack) =>
  `crewon:task-pack-preferences:v1:${userId}:${pack.id}@${pack.version}`;

export function taskPackPreferenceStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readTaskPackPreferences(
  pack: TaskPack,
  userId: number,
  storage = taskPackPreferenceStorage(),
): {
  configuration: TaskPackConfiguration;
  warning: boolean;
} {
  try {
    const raw = storage?.getItem(key(userId, pack));
    return {
      configuration: raw
        ? parseTaskPackConfiguration(pack, JSON.parse(raw))
        : taskPackDefaults(pack),
      warning: !storage,
    };
  } catch {
    return { configuration: taskPackDefaults(pack), warning: true };
  }
}

/** Never persists meeting material, generated text, credentials or permission grants. */
export function saveTaskPackPreferences(
  pack: TaskPack,
  userId: number,
  configuration: unknown,
  storage = taskPackPreferenceStorage(),
): TaskPackConfiguration {
  const validated = parseTaskPackConfiguration(pack, configuration);
  if (!storage) throw new Error("task_pack_storage_unavailable");
  storage.setItem(key(userId, pack), JSON.stringify(validated));
  return validated;
}
