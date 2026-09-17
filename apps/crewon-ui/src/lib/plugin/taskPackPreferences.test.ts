import { describe, expect, it } from "vitest";
import { bundledTaskPacks, taskPackDefaults } from "@crewon/capability-packs";
import {
  readTaskPackPreferences,
  saveTaskPackPreferences,
} from "./taskPackPreferences";

const pack = bundledTaskPacks.list()[0];
const storage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
describe("task pack preferences", () => {
  it("persists only enum preferences and isolates accounts and versions", () => {
    const local = storage();
    const config = { ...taskPackDefaults(pack), "output-language": "en" };
    saveTaskPackPreferences(pack, 1, config, local);
    expect(readTaskPackPreferences(pack, 1, local).configuration).toEqual(
      config,
    );
    expect(readTaskPackPreferences(pack, 2, local).configuration).toEqual(
      taskPackDefaults(pack),
    );
    expect(
      readTaskPackPreferences({ ...pack, version: "0.2.0" }, 1, local)
        .configuration,
    ).toEqual(taskPackDefaults(pack));
    expect([...local.values.values()]).toEqual([JSON.stringify(config)]);
  });
  it("rejects undeclared values and does not claim a failed save", () => {
    expect(() => saveTaskPackPreferences(pack, 1, {}, storage())).toThrow();
    expect(() =>
      saveTaskPackPreferences(pack, 1, taskPackDefaults(pack), null),
    ).toThrow();
    expect(() =>
      saveTaskPackPreferences(pack, 1, taskPackDefaults(pack), {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).toThrow();
  });
  it("reports unreadable or invalid storage instead of silently marking it saved", () => {
    expect(
      readTaskPackPreferences(pack, 1, {
        getItem: () => "{invalid",
        setItem: () => {},
      }),
    ).toEqual({ configuration: taskPackDefaults(pack), warning: true });
    expect(readTaskPackPreferences(pack, 1, null).warning).toBe(true);
  });
});
