import type {
  ActiveAgentVersionCatalogResponse,
  AgentVersionView,
} from "@crewon/contracts";

import type { AgentConfig } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { isControlModelVariant } from "../control-runtime/controlModelCatalog";

export type ControlAgentCatalogAdapter = Readonly<{
  id: string;
  matches(version: AgentVersionView): boolean;
  presentation(
    version: AgentVersionView,
    locale: Locale,
  ): Readonly<Pick<AgentConfig, "accent" | "glyph" | "name" | "role">>;
}>;

export type ControlAgentCatalogRecord = Readonly<{
  config: AgentConfig;
  filePath: string;
}>;

const localTypeScriptRuntimeAdapter: ControlAgentCatalogAdapter = {
  id: "local-typescript-runtime",
  matches: (version) =>
    version.agentVersionId.startsWith("local-web-") ||
    version.agentVersionId.startsWith("local-desktop-") ||
    version.runtimeGeneration.startsWith("web-runtime-") ||
    version.runtimeGeneration.startsWith("desktop-"),
  presentation: (version, locale) => {
    const profile = version.agentVersionId.endsWith("-planner")
      ? locale === "zh"
        ? "本地规划智能体"
        : "Local planner"
      : version.agentVersionId.endsWith("-verifier")
        ? locale === "zh"
          ? "本地验证智能体"
          : "Local verifier"
        : locale === "zh"
          ? "本地执行智能体"
          : "Local agent";
    return {
      accent: "cyan",
      glyph: "L",
      name: profile,
      role:
        locale === "zh"
          ? `本地可用 · ${version.model.modelId}`
          : `Ready locally · ${version.model.modelId}`,
    };
  },
};

const publishedAgentVersionAdapter: ControlAgentCatalogAdapter = {
  id: "published-agent-version",
  matches: () => true,
  presentation: (version, locale) => ({
    accent: "cyan",
    glyph: "A",
    name: locale === "zh" ? "已接入智能体" : "Connected agent",
    role:
      locale === "zh"
        ? `可用 · ${version.model.modelId}`
        : `Available · ${version.model.modelId}`,
  }),
};

/**
 * Projects active Control versions into selector records.
 *
 * Adapters may customize presentation only. Runtime identity, model and policy
 * stay pinned to the active Control catalog so a connector cannot make an
 * unavailable Agent appear runnable.
 */
export function controlAgentCatalogRecords(
  catalog: ActiveAgentVersionCatalogResponse,
  locale: Locale,
  adapters: readonly ControlAgentCatalogAdapter[] = [],
): ControlAgentCatalogRecord[] {
  const sources = [
    ...validateAdapters(adapters),
    localTypeScriptRuntimeAdapter,
    publishedAgentVersionAdapter,
  ];
  return catalog.data
    .filter((version) => !isControlModelVariant(catalog, version))
    .map((version) => {
      const adapter = sources.find((candidate) => candidate.matches(version));
      if (adapter === undefined) {
        throw new Error("control_agent_catalog_adapter_missing");
      }
      const presentation = adapter.presentation(version, locale);
      return {
        filePath: `control:agent-version:${version.agentVersionId}`,
        config: {
          agentId: version.agentVersionId,
          name: presentation.name,
          role: presentation.role,
          glyph: presentation.glyph,
          accent: presentation.accent,
          model: version.model.modelId,
          models: [version.model.modelId],
          permission: locale === "zh" ? "按需确认" : "Ask when needed",
          permissions: [locale === "zh" ? "按需确认" : "Ask when needed"],
          systemPrompt: "",
          mcp: [],
          skills: [],
        },
      };
    });
}

function validateAdapters(
  adapters: readonly ControlAgentCatalogAdapter[],
): readonly ControlAgentCatalogAdapter[] {
  const ids = new Set<string>();
  for (const adapter of adapters) {
    const id = adapter.id.trim();
    if (!id || ids.has(id)) {
      throw new Error("control_agent_catalog_adapter_invalid");
    }
    ids.add(id);
  }
  return adapters;
}
