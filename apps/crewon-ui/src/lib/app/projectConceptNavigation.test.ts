// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  persistInstalledPluginNavigationLocator,
  readInstalledPluginNavigationLocator,
} from "./installedPluginNavigationLocator";
import { projectConversationPageStage } from "./projectConversationPageStage";
import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";

describe("project concept navigation", () => {
  afterEach(() => window.sessionStorage.clear());

  it("restores the concept page for the same account without retaining authority", () => {
    const locator = {
      pluginId: "crewon.short-drama",
      projectId: "original-project",
      stage: "concepts" as const,
    };
    persistInstalledPluginNavigationLocator("account-a", locator);
    expect(readInstalledPluginNavigationLocator("account-a")).toEqual(locator);
    expect(readInstalledPluginNavigationLocator("account-b")).toBeNull();
  });

  it("labels the page without granting a new production stage or trusting another project", () => {
    const page = {
      pluginId: "crewon.short-drama",
      context: { projectId: "original-project", stage: "concepts" },
    };
    const binding = {
      projectId: "original-project",
      source: { pluginId: page.pluginId },
    } as PublicProjectConversationBinding;
    expect(projectConversationPageStage(page, binding)).toEqual({
      kind: "discussion",
      label: "概念图",
    });
    expect(
      projectConversationPageStage(page, { ...binding, projectId: "other" }),
    ).toBeNull();
    expect(projectConversationPageStage(page, null)).toBeNull();
    expect(
      projectConversationPageStage({ ...page, pluginId: "other" }, binding),
    ).toBeNull();
  });
});
