import type {
  CapabilitySummaryView,
  ListActiveCapabilitiesResponse,
} from "@crewon/contracts";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

const PAGE_SIZE = 100;
const MAX_PAGES = 16;
const WEB_CAPABILITY_TOKEN = /(^|[._:/-])(browser|search|web)([._:/-]|$)/u;

type BrowserSettingsClient = {
  listActiveCapabilities(query: {
    cursor?: string | null;
    limit?: number;
  }): Promise<ListActiveCapabilitiesResponse>;
};

export async function readControlBrowserSettingsPanel(
  client: BrowserSettingsClient,
  locale: Locale,
): Promise<CapabilityPanel> {
  const capabilities: CapabilitySummaryView[] = [];
  let cursor: string | null = null;
  let catalog: ListActiveCapabilitiesResponse | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.listActiveCapabilities({
      cursor,
      limit: PAGE_SIZE,
    });
    if (
      catalog !== null &&
      (response.releaseId !== catalog.releaseId ||
        response.activatedAt !== catalog.activatedAt)
    ) {
      throw new Error("capability_catalog_changed");
    }
    catalog = response;
    capabilities.push(...response.data);
    if (response.nextCursor === null) break;
    if (response.nextCursor === cursor || page === MAX_PAGES - 1) {
      throw new Error("capability_catalog_pagination_invalid");
    }
    cursor = response.nextCursor;
  }

  if (catalog === null) {
    throw new Error("capability_catalog_empty_response");
  }
  return controlBrowserSettingsPanel(catalog, capabilities, locale);
}

export function controlBrowserSettingsPanel(
  catalog: Pick<ListActiveCapabilitiesResponse, "activatedAt" | "releaseId">,
  capabilities: readonly CapabilitySummaryView[],
  locale: Locale,
): CapabilityPanel {
  const webCapabilities = capabilities.filter((capability) =>
    WEB_CAPABILITY_TOKEN.test(capability.name.toLowerCase()),
  );
  const capabilityLines = webCapabilities.map(
    (capability) =>
      `- ${capability.name} · ${capability.kind} · ${capability.agentVersionId}`,
  );
  return {
    title: locale === "zh" ? "浏览器" : "Browser",
    subtitle:
      locale === "zh"
        ? "Control 当前生效的 Web 能力"
        : "Active Web capabilities from Control",
    body: [
      locale === "zh" ? "能力目录" : "Capability catalog",
      `${locale === "zh" ? "发布" : "Release"}: ${catalog.releaseId}`,
      `${locale === "zh" ? "生效时间" : "Activated"}: ${catalog.activatedAt}`,
      "",
      locale === "zh" ? "Web / Browser 能力" : "Web / Browser capabilities",
      ...(capabilityLines.length > 0
        ? capabilityLines
        : [
            locale === "zh"
              ? "当前发布未提供 Web 或 Browser 能力。"
              : "The active release does not publish a Web or Browser capability.",
          ]),
    ].join("\n"),
    actions: [
      {
        id: "refresh-browser-capabilities",
        label: locale === "zh" ? "刷新能力" : "Refresh capabilities",
      },
    ],
  };
}
