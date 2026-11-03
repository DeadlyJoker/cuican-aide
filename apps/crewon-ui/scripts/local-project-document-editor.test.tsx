// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalProjectDocumentOwner } from "../../control-api/src/local-project-document-owner";
import { LocalProjectDocumentEditor } from "../src/components/plugins/LocalProjectDocumentEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("page and Agent share real files; notifications update clean views and preserve dirty drafts", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "document-ui-")));
  const actor = { tenantId: "t", spaceId: "s", actorId: "a", principalId: "p" };
  const owner = new LocalProjectDocumentOwner(async ({ actor: who }) => {
    if (who.tenantId !== "t") throw new Error("denied");
    return { root: folder, assertCurrent() {} };
  });
  const query = { projectId: "project", documentId: "script" };
  const client = {
    read: () => owner.read(actor, query),
    save: (input: { content: string; expectedRevision: number }) =>
      owner.save(actor, { ...query, ...input }),
    subscribe: (changed: () => void) =>
      owner.subscribe(actor, query.projectId, changed),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<LocalProjectDocumentEditor client={client} title="剧本" />);
    });
    await act(async () => {
      await owner.save(actor, {
        ...query,
        expectedRevision: 0,
        content: "Agent 第一稿",
      });
    });
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("Agent 第一稿");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, "页面草稿");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await owner.save(actor, {
        ...query,
        expectedRevision: 1,
        content: "Agent 第二稿",
      });
    });
    expect(textarea.value).toBe("页面草稿");
    expect(container.textContent).toContain("你的草稿已保留");
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect((await owner.read(actor, query))?.content).toBe("Agent 第二稿");
    expect(textarea.value).toBe("页面草稿");
    expect(container.textContent).toContain("保存未完成或版本已变化");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rmSync(folder, { recursive: true, force: true });
  }
});
