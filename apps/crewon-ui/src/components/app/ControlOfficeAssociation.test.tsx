// @vitest-environment happy-dom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { OfficeThreadMutationResponse } from "@crewon/contracts";
import { ControlOfficeThreadChoice } from "./ControlOfficeThreadChoice";
import {
  catalogPage,
  choose,
  deferred,
  fixture,
  officeAssociation,
  officeMutation,
  record,
  send,
  thread,
} from "./ControlOfficeThread.test-support";
afterEach(() => vi.restoreAllMocks());

it("opens an associated Office directly even if every title lookup is unavailable", async () => {
  const f = fixture();
  f.client.getThreadCatalog.mockRejectedValue(new Error("catalog offline"));
  try {
    await f.render();
    await send(f.container);
    expect(f.runtime.startTurn).toHaveBeenCalledWith(
      thread.id,
      expect.any(String),
      [],
      expect.any(Object),
    );
    expect(f.client.getThreadCatalog).not.toHaveBeenCalled();
    expect(f.client.createThread).not.toHaveBeenCalled();
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["route_not_found", "authorization_denied", "thread_not_found"])(
  "does not treat %s as permission to create another conversation",
  async (code) => {
    const f = fixture();
    f.client.getOfficeThread.mockRejectedValue(new Error(code));
    try {
      await f.render();
      expect(f.container.textContent).not.toContain(
        "Create separate conversation",
      );
      await send(f.container);
      expect(f.client.getThreadCatalog).not.toHaveBeenCalled();
      expect(f.client.createOfficeThread).not.toHaveBeenCalled();
      expect(f.client.createThread).not.toHaveBeenCalled();
      expect(f.runtime.startTurn).not.toHaveBeenCalled();
      f.client.getOfficeThread.mockResolvedValue(officeAssociation());
      await choose(f.container, "Retry lookup");
      expect(f.runtime.readThread).toHaveBeenCalled();
      expect(f.runtime.startTurn).not.toHaveBeenCalled();
      expect(f.container.querySelector("textarea")!.value).toBe(
        "Continue the task",
      );
    } finally {
      await f.close();
    }
  },
);

it("requires an explicit legacy claim without loading its history or starting a model call", async () => {
  const f = fixture();
  f.client.getOfficeThread.mockResolvedValue(officeAssociation(null));
  try {
    await f.render();
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.client.getThreadGoal).not.toHaveBeenCalled();
    expect(f.container.querySelector("textarea")!.disabled).toBe(true);
    await choose(f.container, "Use existing conversation");
    expect(f.client.bindOfficeThread).toHaveBeenCalledExactlyOnceWith(
      record.definition.officeVersionId,
      { threadId: thread.id, expectedRevision: 1 },
    );
    expect(f.runtime.readThread).toHaveBeenCalled();
    expect(f.runtime.renameThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("allows an explicit new conversation after an unbound association and incomplete legacy search", async () => {
  const f = fixture();
  f.client.getOfficeThread.mockResolvedValue(officeAssociation(null));
  f.client.getThreadCatalog.mockRejectedValue(
    new Error("legacy search unavailable"),
  );
  try {
    await f.render();
    await choose(f.container, "Create separate conversation");
    expect(f.client.createOfficeThread).toHaveBeenCalledTimes(1);
    expect(f.client.createThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    await send(f.container);
    expect(f.runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(f.client.createOfficeThread).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("adopts the authoritative concurrent winner on retry without automatically sending a draft", async () => {
  const f = fixture();
  f.client.getOfficeThread.mockResolvedValue(officeAssociation(null));
  f.client.bindOfficeThread.mockRejectedValue(
    new Error("office_thread_already_bound"),
  );
  try {
    await f.render();
    await choose(f.container, "Use existing conversation");
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    f.client.getOfficeThread.mockResolvedValue(officeAssociation());
    await choose(f.container, "Retry lookup");
    expect(f.runtime.readThread).toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not read a late successful claim after its Office panel closes", async () => {
  const f = fixture(),
    pending = deferred<OfficeThreadMutationResponse>();
  f.client.getOfficeThread.mockResolvedValue(officeAssociation(null));
  f.client.bindOfficeThread.mockReturnValue(pending.promise);
  try {
    await f.render();
    await choose(f.container, "Use existing conversation");
    await f.close();
    await act(async () => pending.resolve(officeMutation("bound")));
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  } finally {
    pending.resolve(officeMutation("bound"));
    await f.close();
  }
});

it("rejects a returned Office scope mismatch before exposing or running its Thread", async () => {
  const f = fixture();
  f.client.getOfficeThread.mockResolvedValue({
    ...officeAssociation(),
    officeId: "other-office",
  });
  try {
    await f.render();
    await send(f.container);
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.client.createOfficeThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("snapshots explicit adoption and unavailable-association recovery", () => {
  const props = {
    locale: "en" as const,
    busy: false,
    onClaim: vi.fn(),
    onCreate: vi.fn(),
    onRetry: vi.fn(),
  };
  expect(
    renderToStaticMarkup(
      <ControlOfficeThreadChoice
        {...props}
        unbound
        candidate={catalogPage().data[0]!}
      />,
    ),
  ).toMatchSnapshot();
  expect(
    renderToStaticMarkup(
      <ControlOfficeThreadChoice {...props} unbound={false} candidate={null} />,
    ),
  ).toMatchSnapshot();
});
