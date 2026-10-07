import { expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import { findControlOfficeThread } from "./controlOfficeThreadLookup";
import {
  catalogClientFixture,
  catalogThread,
} from "../../lib/control-runtime/controlThreadCatalog.test-support";

it.each([undefined, null, "workspace-a"])(
  "retains workspace %s while finding an old Office through sparse Unicode search pages",
  async (workspaceId) => {
    const server = catalogClientFixture();
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      expect(options?.signal?.aborted).toBe(false);
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/thread-catalog");
      const query = url.searchParams;
      expect(query.get("status")).toBe("active");
      expect(query.get("excludeForks")).toBe("true");
      expect(query.get("search")).toBe("needle 缓存");
      expect(query.get("limit")).toBe("100");
      const page = await server.getThreadCatalog({
        status: "active",
        excludeForks: true,
        search: query.get("search")!,
        limit: Number(query.get("limit")),
        cursor: query.get("cursor"),
      });
      return new Response(
        JSON.stringify({
          ...page,
          data: page.data.map((thread) => ({
            ...thread,
            ...(workspaceId === undefined ? {} : { workspaceId }),
          })),
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    const client = new ControlApiClient({
      baseUrl: "http://fixture.invalid",
      accessToken: "fixture-token",
      csrfToken: "fixture-csrf",
      origin: "http://fixture.invalid",
      fetch,
    });
    const match = await findControlOfficeThread(
      client,
      {
        title: "needle 缓存",
        legacyTitle: "legacy · needle 缓存",
        searchTitle: "needle 缓存",
      },
      controller.signal,
    );
    expect(match).toEqual({
      ...catalogThread(0),
      workspaceId: workspaceId ?? null,
    });
    expect(fetch).toHaveBeenCalledTimes(14);
    expect(server.getThreadCatalog).toHaveBeenCalledTimes(14);
  },
);
