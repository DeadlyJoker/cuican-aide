// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import {
  XLSX_MEDIA_TYPE,
  type DeliveryCatalog,
  type DeliveryInputRecord,
  type DeliveryVersionRecord,
} from "@crewon/domain/delivery";
import { DeliveryPanel } from "./DeliveryPanel";
import { DeliveryPreview } from "./DeliveryPreview";
import { DeliveryAssembleForm } from "./DeliveryAssembleForm";
import { deliveryEditValue, deliveryUploadBytes } from "./deliveryUi";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const target = {
  schemaVersion: "crewon.delivery-target.v1" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  threadId: "thread-1",
  targetId: "thread-deliveries" as const,
};
const inspection = {
  sheets: [
    { name: "Sheet1", rows: 80, columns: 2 },
    { name: "Sheet2", rows: 1, columns: 2 },
    { name: "Sheet3", rows: 1, columns: 2 },
    { name: "Sheet4", rows: 1, columns: 2 },
  ],
  formulaCount: 0,
};
const input: DeliveryInputRecord = {
  inputId: "input-1",
  target,
  ownerActorId: "actor-1",
  name: "orders.xlsx",
  role: "data",
  mediaType: XLSX_MEDIA_TYPE,
  byteLength: 100,
  contentDigest: `sha256:${"a".repeat(64)}`,
  inspection,
  createdAt: "2026-09-14T00:00:00.000Z",
  sourceRunId: null,
};
const template: DeliveryInputRecord = {
  ...input,
  inputId: "template-1",
  name: "template.xlsx",
  role: "template",
};
const version: DeliveryVersionRecord = {
  schemaVersion: "crewon.delivery-result.v1",
  target,
  deliveryId: "delivery-1",
  versionId: "version-1",
  contentDigest: `sha256:${"b".repeat(64)}`,
  mediaType: XLSX_MEDIA_TYPE,
  sourceRunId: null,
  availability: "ready",
  ownerActorId: "actor-1",
  name: "result.xlsx",
  byteLength: 100,
  createdAt: "2026-09-14T00:00:00.000Z",
  parentVersionId: null,
  inputIds: [input.inputId, template.inputId],
  inspection,
  validation: {
    status: "verified",
    sources: [
      {
        inputId: input.inputId,
        sheet: "Sheet1",
        readRows: 7,
        writtenRows: 5,
        excludedBlankRows: 0,
        excludedRuleRows: 1,
        exceptionRows: 1,
      },
    ],
    writtenRows: 5,
    numericTotals: { B: 370 },
    formulaCount: 0,
    warnings: [],
  },
  retention: "saved",
};
let catalog: DeliveryCatalog;
let element: HTMLDivElement;
let root: Root;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function click(text: string) {
  const button = [...element.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  expect(button, text).toBeDefined();
  await act(async () => {
    button!.click();
    await tick();
  });
}
async function change(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
  });
}
function transport(
  handler?: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  return new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf",
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (handler) return handler(parsed, init);
      if (parsed.pathname.endsWith("/page"))
        return Response.json({
          sheet: parsed.searchParams.get("sheet"),
          startRow: Number(parsed.searchParams.get("startRow")),
          rows: [["hello", 3]],
          nextRow: null,
          totalRows: 80,
          totalColumns: 2,
        });
      return Response.json(catalog);
    },
  }).delivery;
}
beforeEach(() => {
  catalog = { target, inputs: [input, template], deliveries: [version] };
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  element.remove();
});

describe("F01 file delivery workbench", () => {
  it("F01-R01 preserves all uploaded bytes beyond a text-preview budget", async () => {
    const content = `name,amount\n${"订单,42\n".repeat(10000)}`;
    const body = await deliveryUploadBytes(
      new File([content], "orders.csv"),
      "data",
    );
    const actual = Uint8Array.from(atob(body.contentBase64), (character) =>
      character.charCodeAt(0),
    );
    expect(new TextDecoder().decode(actual)).toBe(content);
    expect(actual.length).toBeGreaterThan(16 * 1024);
    expect(() => deliveryEditValue("text", "=SUM(A1:A3)")).not.toThrow();
    expect(deliveryEditValue("text", "=SUM(A1:A3)")).toBe("=SUM(A1:A3)");
  });
  it("F01-R04 snapshots true file metadata and explicit assembly selection", () => {
    const client = transport();
    expect(
      renderToStaticMarkup(
        <>
          <DeliveryPanel client={null} threadId="thread-1" locale="zh" />
          <DeliveryAssembleForm
            client={client}
            threadId="thread-1"
            inputs={catalog.inputs}
            busy={false}
            zh
            onAssemble={() => undefined}
          />
          <DeliveryPreview
            client={client}
            threadId="thread-1"
            selection={{
              ref: { kind: "version", id: version.versionId },
              record: version,
            }}
            busy={false}
            zh
            signal={new AbortController().signal}
            onPatch={async () => true}
            onReload={async () => version}
            onSelect={() => undefined}
          />
        </>,
      ),
    ).toMatchSnapshot();
  });
  it("F01-R01 shows every sheet and requests the next page instead of truncating input", async () => {
    const queries: string[] = [];
    const client = transport((url) => {
      if (!url.pathname.endsWith("/page")) return Response.json(catalog);
      queries.push(url.search);
      const startRow = Number(url.searchParams.get("startRow"));
      return Response.json({
        sheet: url.searchParams.get("sheet"),
        startRow,
        rows: [[`row-${startRow}`, 3]],
        nextRow: startRow === 1 ? 2 : null,
        totalRows: 80,
        totalColumns: 2,
      });
    });
    await act(async () => {
      root.render(
        <DeliveryPanel client={client} threadId="thread-1" locale="zh" />,
      );
      await tick();
    });
    await click("orders.xlsx");
    expect(element.textContent).toContain("Sheet4");
    await click("下一页");
    expect(queries.some((query) => query.includes("startRow=2"))).toBe(true);
    expect(element.textContent).toContain("row-2");
    const sheetSelect = element.querySelector(
      ".delivery-preview select",
    ) as HTMLSelectElement;
    await change(sheetSelect, "Sheet4");
    expect(queries.at(-1)).toContain("sheet=Sheet4");
  });
  it("F01-R05 preserves the cell draft through a conflict and rebases only on explicit reload", async () => {
    const patches: Record<string, unknown>[] = [];
    const latest = {
      ...version,
      versionId: "version-2",
      contentDigest: `sha256:${"c".repeat(64)}`,
      parentVersionId: version.versionId,
    };
    const client = transport((url, init) => {
      if (url.pathname.endsWith("/patch")) {
        patches.push(JSON.parse(String(init.body)));
        if (patches.length === 1) {
          catalog = { ...catalog, deliveries: [latest] };
          return Response.json(
            {
              error: {
                category: "conflict",
                code: "delivery_version_conflict",
                requestId: "request-1",
              },
            },
            { status: 409 },
          );
        }
        return Response.json({
          ...latest,
          versionId: "version-3",
          parentVersionId: latest.versionId,
        });
      }
      if (url.pathname.endsWith("/page"))
        return Response.json({
          sheet: "Sheet1",
          startRow: 1,
          rows: [["before", 3]],
          nextRow: null,
          totalRows: 80,
          totalColumns: 2,
        });
      return Response.json(catalog);
    });
    await act(async () => {
      root.render(
        <DeliveryPanel client={client} threadId="thread-1" locale="zh" />,
      );
      await tick();
    });
    await click("result.xlsx");
    await act(async () => {
      (
        element.querySelector(
          '[aria-label="Sheet1!A1: before"]',
        ) as HTMLButtonElement
      ).click();
      await tick();
    });
    await change(
      element.querySelector(".delivery-cell-edit input")!,
      "手工修改保留",
    );
    await click("保存新版本");
    expect(element.textContent).toContain("你的编辑已保留");
    expect(
      (element.querySelector(".delivery-cell-edit input") as HTMLInputElement)
        .value,
    ).toBe("手工修改保留");
    expect(patches[0]?.expectedVersionId).toBe("version-1");
    await click("载入最新版本并保留编辑");
    expect(
      (element.querySelector(".delivery-cell-edit input") as HTMLInputElement)
        .value,
    ).toBe("手工修改保留");
    await click("保存新版本");
    expect(patches[1]?.expectedVersionId).toBe("version-2");
    expect(patches[1]?.expectedContentDigest).toBe(latest.contentDigest);
    expect(patches[1]?.patches).toEqual([
      { sheet: "Sheet1", cell: "A1", value: "手工修改保留" },
    ]);
    expect(element.querySelector(".delivery-cell-edit")).toBeNull();
  });
  it("F01-R06/R07 aborts old task requests and excludes late old-task results", async () => {
    let release!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const client = transport((url, init) => {
      if (url.pathname.includes("thread-1")) {
        oldSignal = init.signal as AbortSignal;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Response.json({
        target: { ...target, threadId: "thread-2" },
        inputs: [],
        deliveries: [],
      });
    });
    await act(async () => {
      root.render(
        <DeliveryPanel client={client} threadId="thread-1" locale="zh" />,
      );
      await tick();
    });
    await act(async () => {
      root.render(
        <DeliveryPanel client={client} threadId="thread-2" locale="zh" />,
      );
      await tick();
    });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      release(Response.json(catalog));
      await tick();
    });
    expect(element.textContent).not.toContain("orders.xlsx");
    expect(element.textContent).not.toContain("result.xlsx");
  });
  it("F01-R03 exposes rule-based filtering, exception and grouped summaries", async () => {
    let assembled: unknown;
    await act(async () => {
      root.render(
        <DeliveryAssembleForm
          client={transport()}
          threadId="thread-1"
          inputs={catalog.inputs}
          busy={false}
          zh
          onAssemble={(body) => {
            assembled = body;
          }}
        />,
      );
      await tick();
    });
    await act(async () => {
      (
        element.querySelector('input[type="checkbox"]') as HTMLInputElement
      ).click();
      await tick();
    });
    await click("添加列映射");
    await change(
      element.querySelector(".delivery-column-row input")!,
      "amount",
    );
    await act(async () => {
      (
        [...element.querySelectorAll('input[type="checkbox"]')].at(
          -1,
        ) as HTMLInputElement
      ).click();
      await tick();
    });
    await act(async () => {
      element
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await tick();
    });
    expect(assembled).toMatchObject({
      sources: [{ inputId: "input-1", sheet: "Sheet1", headerRow: 1 }],
      rules: {
        exclude: [{ header: "status", equals: "canceled" }],
        requiredHeaders: ["amount"],
        exceptionSheet: "异常",
        lineageSheet: "来源",
        summary: {
          sheet: "汇总",
          startRow: 2,
          groupBy: ["channel", "currency"],
          valueHeader: "amount",
        },
      },
    });
  });
});
