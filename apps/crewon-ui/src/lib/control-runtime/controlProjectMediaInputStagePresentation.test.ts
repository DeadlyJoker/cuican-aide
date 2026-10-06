import { expect, it, vi } from "vitest";
import { ControlProjectMediaInputStageTurn } from "./controlProjectMediaInputStageTurn";
import { startPresentedProjectMediaInputStageTurn as start } from "./controlProjectMediaInputStagePresentation";
import {
  api,
  input,
  acknowledgement,
  snapshot,
  presentedThread,
  deferred,
} from "./controlProjectMediaInputStage.test-support";
function fixture() {
  const fetch = vi.fn(async () => Response.json(acknowledgement)),
    turns = new ControlProjectMediaInputStageTurn(api(fetch), () => "key");
  let closed = false;
  const options = {
    threadId: "thread",
    text: input.content,
    settings: { projectMediaInputStage: input.selection },
    hasAttachments: false,
    closed: () => closed,
    turns,
    getSnapshot: vi.fn(async () => snapshot()),
    adopt: vi.fn(async () => {}),
    readThread: vi.fn(async () => presentedThread()),
    changed: vi.fn(),
  };
  return {
    options,
    fetch,
    turns,
    withdraw: () => {
      closed = true;
    },
  };
}
it("accepted Run adoption failure recovers with reads and original receipt, not another POST", async () => {
  const f = fixture();
  f.options.adopt.mockRejectedValueOnce(new Error("read unavailable"));
  await expect(start(f.options)).rejects.toThrow("read unavailable");
  expect(f.turns.retainedSelection("thread")).toEqual(input.selection);
  f.options.getSnapshot.mockResolvedValue(snapshot(4));
  const result = await start(f.options);
  expect(result.turn.id).toBe("actual-run");
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.options.adopt).toHaveBeenCalledTimes(2);
  expect(f.options.readThread).toHaveBeenCalledTimes(1);
  expect(f.turns.retainedSelection("thread")).toBeNull();
  await f.turns.close();
});
it("withdraw during snapshot cannot submit a Turn, and withdraw after acceptance cannot adopt late", async () => {
  const f = fixture(),
    gate = deferred<ReturnType<typeof snapshot>>();
  f.options.getSnapshot.mockImplementationOnce(() => gate.promise);
  const operation = start(f.options);
  f.withdraw();
  gate.resolve(snapshot());
  await expect(operation).rejects.toThrow("closed");
  expect(f.fetch).not.toHaveBeenCalled();
  await f.turns.close();
  const late = fixture(),
    ack = deferred<Response>();
  late.fetch.mockImplementationOnce(() => ack.promise);
  const pending = start(late.options);
  await vi.waitFor(() => expect(late.fetch).toHaveBeenCalledTimes(1));
  late.withdraw();
  ack.resolve(Response.json(acknowledgement));
  await expect(pending).rejects.toThrow("closed");
  expect(late.options.adopt).not.toHaveBeenCalled();
  expect(late.turns.retainedSelection("thread")).toEqual(input.selection);
  await late.turns.close();
});
it("unsupported mixed execution and attachments reject before transport without ordinary chat fallback", async () => {
  const f = fixture();
  for (const options of [
    { ...f.options, hasAttachments: true },
    {
      ...f.options,
      settings: { ...f.options.settings, executionIntent: "plan" as const },
    },
    { ...f.options, settings: {} },
    { ...f.options, threadId: "foreign" },
  ])
    await expect(start(options)).rejects.toBeDefined();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.options.getSnapshot).not.toHaveBeenCalled();
  await f.turns.close();
});
it("a confirmed receipt whose original Run is absent remains retained for readonly hydration", async () => {
  const f = fixture();
  f.options.readThread.mockResolvedValueOnce({
    ...presentedThread(),
    turns: [],
  });
  await expect(start(f.options)).rejects.toThrow("adoption_invalid");
  await start(f.options);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  await f.turns.close();
});
