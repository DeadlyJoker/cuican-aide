import { Window as TestWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as accessibility from "dom-accessibility-api";
import { recordingElementSemantics } from "./recordingElementSemantics.ts";
import type { RecordingSourceEvent } from "../src/lib/desktop/recordingBridge.ts";
import {
  installRecordingSource,
  recordingLayoutSvg,
  safeRecordingText,
} from "./recordingSource.ts";

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  send: vi.fn(),
  exposeInMainWorld: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcRenderer: { on: electron.on, send: electron.send },
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
}));
vi.mock("dom-accessibility-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dom-accessibility-api")>();
  return {
    ...actual,
    computeAccessibleName: vi.fn(actual.computeAccessibleName),
    getRole: vi.fn(actual.getRole),
  };
});

const cleanups: Array<() => void> = [];
const screenshotStyle = {
  visibility: "visible",
  display: "block",
  opacity: "1",
  backgroundImage: "none",
  borderImageSource: "none",
  filter: "none",
  backdropFilter: "none",
  mixBlendMode: "normal",
  content: "none",
  backgroundColor: "rgb(240, 240, 240)",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  transform: "none",
  maskImage: "none",
  clipPath: "none",
  getPropertyValue(this: Record<string, unknown>, property: string): string {
    return typeof this[property] === "string" ? (this[property] as string) : "";
  },
};

function setup(markup: string) {
  const testWindow = new TestWindow({ url: "https://fixture.test/" });
  const document = testWindow.document;
  document.body.innerHTML = markup;
  const events: RecordingSourceEvent[] = [];
  const source = installRecordingSource({
    document: document as unknown as Document,
    window: testWindow as unknown as Window,
    emit: (event) => events.push(event),
  });
  cleanups.push(() => {
    source.dispose();
    void testWindow.happyDOM.abort();
  });
  return {
    document,
    events,
    source,
    testWindow,
    interact(
      selector: string,
      type: "click" | "change" = "change",
      trusted = true,
    ) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing-fixture-element: ${selector}`);
      const event = new testWindow.Event(type, {
        bubbles: true,
        composed: true,
      });
      // Happy DOM does not produce native interactions. Only this synthetic test
      // fixture changes trust; production uses the browser's readonly isTrusted.
      Object.defineProperty(event, "isTrusted", { value: trusted });
      element.dispatchEvent(event);
    },
  };
}

function screenshotFixture() {
  const fixture = setup("<button>Export</button>");
  const button = fixture.document.querySelector("button")!;
  let x = 10;
  Object.defineProperty(button, "getBoundingClientRect", {
    value: () => ({
      x,
      y: 10,
      width: 120,
      height: 32,
      right: x + 120,
      bottom: 42,
    }),
  });
  vi.spyOn(fixture.testWindow, "getComputedStyle").mockReturnValue(
    screenshotStyle as never,
  );
  Object.defineProperty(fixture.document, "elementFromPoint", {
    value: () => button,
  });
  fixture.source.setEnabled(true);
  return {
    ...fixture,
    button,
    move: () => {
      x = 20;
    },
  };
}

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F02 shared mature element semantics", () => {
  it("keeps a native filter name distinct from its selected business value", () => {
    const fixture = setup(
      '<label for="channel">渠道</label><select id="channel"><option value="retail" selected>零售</option></select>',
    );
    fixture.source.setEnabled(true);
    fixture.interact("select");
    expect(fixture.events[0]).toMatchObject({
      kind: "select",
      target: { accessibleName: "渠道", role: "combobox" },
      input: { classification: "parameter-candidate", value: "retail" },
    });
  });

  it("uses native multiple labels and aria-labelledby precedence", () => {
    const fixture = setup(
      '<label for="date">开始</label><label for="date">日期</label><input id="date"><span id="prefix">销售</span><span id="channel" hidden>渠道</span><select aria-labelledby="prefix channel" aria-label="Fallback"><option>全部</option></select>',
    );
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("input")! as unknown as Element,
      ),
    ).toEqual({ accessibleName: "开始 日期", role: "textbox", unsafe: false });
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("select")! as unknown as Element,
      ),
    ).toEqual({ accessibleName: "销售 渠道", role: "combobox", unsafe: false });
  });

  it("uses library role resolution for native lists and presentational conflicts", () => {
    const fixture = setup(
      '<input list="choices" aria-label="商品"><button role="presentation" aria-label="导出">图标</button>',
    );
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("input")! as unknown as Element,
      ),
    ).toEqual({ accessibleName: "商品", role: "combobox", unsafe: false });
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("button")! as unknown as Element,
      ),
    ).toEqual({ accessibleName: "导出", role: "button", unsafe: false });
  });

  it("blocks a sensitive control before invoking library naming or its value getter", () => {
    const fixture = setup('<input type="password" aria-label="Access">');
    const control = fixture.document.querySelector("input")!;
    const readValue = vi.fn(() => {
      throw new Error("private value read");
    });
    Object.defineProperty(control, "value", { get: readValue });
    const compute = vi.mocked(accessibility.computeAccessibleName).mockClear();
    expect(recordingElementSemantics(control as unknown as Element)).toEqual({
      accessibleName: null,
      role: null,
      unsafe: true,
    });
    expect(compute).not.toHaveBeenCalled();
    expect(readValue).not.toHaveBeenCalled();
  });

  it("rejects referenced embedded inputs before the library can use a credential value as a name", () => {
    const fixture = setup(
      '<input id="account" type="password"><button aria-labelledby="account">Export</button>',
    );
    const readValue = vi.fn(() => {
      throw new Error("private reference read");
    });
    Object.defineProperty(fixture.document.querySelector("input")!, "value", {
      get: readValue,
    });
    const compute = vi.mocked(accessibility.computeAccessibleName).mockClear();
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("button")! as unknown as Element,
      ).unsafe,
    ).toBe(true);
    expect(compute).not.toHaveBeenCalled();
    expect(readValue).not.toHaveBeenCalled();
  });

  it("bounds accessible names by UTF-8 bytes without emitting a truncated name", () => {
    const fixture = setup(
      `<button>${"渠".repeat(53)}</button><button>${"渠".repeat(54)}</button>`,
    );
    const controls = fixture.document.querySelectorAll("button");
    expect(
      recordingElementSemantics(controls[0]! as unknown as Element),
    ).toEqual({
      accessibleName: "渠".repeat(53),
      role: "button",
      unsafe: false,
    });
    expect(
      recordingElementSemantics(controls[1]! as unknown as Element),
    ).toEqual({ accessibleName: null, role: null, unsafe: true });
  });

  it("bounds referenced DOM traversal before invoking the library", () => {
    const fixture = setup(
      `<section id="large">${"<span>Sales</span>".repeat(65)}</section><button aria-labelledby="large">Export</button>`,
    );
    const compute = vi.mocked(accessibility.computeAccessibleName).mockClear();
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("button")! as unknown as Element,
      ).unsafe,
    ).toBe(true);
    expect(compute).not.toHaveBeenCalled();
  });

  it("returns unavailable semantics on a library failure with no handwritten fallback", () => {
    const fixture = setup("<button>Export</button>");
    vi.mocked(accessibility.computeAccessibleName).mockImplementationOnce(
      () => {
        throw new Error("library unavailable");
      },
    );
    expect(
      recordingElementSemantics(
        fixture.document.querySelector("button")! as unknown as Element,
      ),
    ).toEqual({ accessibleName: null, role: null, unsafe: true });
  });
});

describe("F02 R03 recording source", () => {
  it("starts disabled, rejects untrusted events, and stops immediately on pause/dispose", () => {
    const fixture = setup("<button>Navigate</button>");
    fixture.interact("button", "click");
    expect(fixture.events).toEqual([]);
    fixture.source.setEnabled(true);
    fixture.interact("button", "click", false);
    expect(fixture.events).toEqual([]);
    fixture.interact("button", "click");
    expect(fixture.events).toHaveLength(1);
    fixture.source.setEnabled(false);
    fixture.interact("button", "click");
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    expect(fixture.events).toHaveLength(2);
    fixture.source.dispose();
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    expect(fixture.events).toHaveLength(2);
  });

  it("captures clicks, ordinary inputs, date variables and filter selections with structural targets", () => {
    const fixture = setup(
      '<section><button id="private-title">Export sales</button><input value="weekly sales"><input type="date" value="2026-09-14"><select><option value="all">All accounts</option><option value="paid" selected>Paid</option></select></section>',
    );
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    fixture.interact("input");
    fixture.interact('input[type="date"]');
    fixture.interact("select");
    expect(fixture.events.map((event) => event.kind)).toEqual([
      "click",
      "input",
      "input",
      "select",
    ]);
    expect(fixture.events.map((event) => event.input)).toEqual([
      null,
      { classification: "ordinary", value: "weekly sales" },
      { classification: "parameter-candidate", value: "2026-09-14" },
      { classification: "parameter-candidate", value: "paid" },
    ]);
    expect(fixture.events[0]?.target).toEqual({
      tag: "button",
      description: "button",
      role: "button",
      accessibleName: "Export sales",
      selector:
        "html:nth-of-type(1) > body:nth-of-type(1) > section:nth-of-type(1) > button:nth-of-type(1)",
    });
    expect(JSON.stringify(fixture.events)).not.toMatch(
      /private-title|All accounts/,
    );
  });

  it.each([
    '<input type="password">',
    '<input name="access_token">',
    '<input id="api-key">',
    '<input autocomplete="section-auth current-password">',
    '<input autocomplete="one-time-code">',
    '<textarea aria-label="Cookie header"></textarea>',
    '<select name="credential"><option value="secret">Choice</option></select>',
    '<input type="email">',
    '<input placeholder="验证码">',
    '<input name="auth">',
    '<input name="accessKey">',
    '<input name="session">',
    '<input name="key">',
    "<label>Password<input></label>",
  ])(
    "omits sensitive fields without invoking their value getter: %s",
    (markup) => {
      const fixture = setup(markup);
      const control = fixture.document.querySelector("input,textarea,select")!;
      const valueGetter = vi.fn(() => {
        throw new Error("sensitive value read");
      });
      Object.defineProperty(control, "value", { get: valueGetter });
      fixture.source.setEnabled(true);
      fixture.interact("input,textarea,select");
      expect(valueGetter).not.toHaveBeenCalled();
      expect(fixture.events[0]?.input).toEqual({
        classification: "runtime-required",
      });
      expect(fixture.events[0]?.reason).toBe(
        "sensitive-or-unbounded-input-omitted",
      );
    },
  );

  it.each([
    "Bearer abcd",
    "sk-proj-1234567890abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig",
    "Cookie: sid=x",
    "password=hunter2",
    "-----BEGIN PRIVATE KEY-----",
    "x".repeat(513),
    "https://example.test/path?token=abc",
    "https://user:pass@example.test",
    "abc\u0000def",
  ])(
    "never emits suspected credential or oversized ordinary text: %s",
    (value) => {
      const fixture = setup("<input>");
      fixture.document.querySelector("input")!.value = value;
      fixture.source.setEnabled(true);
      fixture.interact("input");
      expect(fixture.events[0]?.input).toEqual({
        classification: "runtime-required",
      });
      expect(JSON.stringify(fixture.events)).not.toContain(value);
      expect(safeRecordingText(value)).toBeNull();
    },
  );

  it("records boolean controls without accessing their hidden submission value", () => {
    const fixture = setup('<input type="checkbox" checked value="secret-key">');
    const control = fixture.document.querySelector("input")!;
    const valueGetter = vi.fn(() => "secret-key");
    Object.defineProperty(control, "value", { get: valueGetter });
    fixture.source.setEnabled(true);
    fixture.interact("input");
    expect(valueGetter).not.toHaveBeenCalled();
    expect(fixture.events[0]?.input).toEqual({
      classification: "ordinary",
      value: "true",
    });
  });

  it("keeps sensitive clicks compatible with C01 without recording an input value", () => {
    const fixture = setup('<input type="password">');
    const control = fixture.document.querySelector("input")!;
    const valueGetter = vi.fn(() => {
      throw new Error("private read");
    });
    Object.defineProperty(control, "value", { get: valueGetter });
    fixture.source.setEnabled(true);
    fixture.interact("input", "click");
    expect(valueGetter).not.toHaveBeenCalled();
    expect(fixture.events[0]).toMatchObject({
      kind: "click",
      input: null,
      screenshotSafe: false,
      reason: "sensitive-or-unbounded-input-omitted",
      target: { accessibleName: null },
    });
  });

  it.each([
    ["<canvas></canvas>", "canvas", "click", "embedded-content-not-supported"],
    [
      "<div contenteditable><span>Private text</span></div>",
      "span",
      "click",
      "contenteditable-not-supported",
    ],
    ['<input type="file">', "input", "change", "file-input-not-supported"],
    ["<div>Private text</div>", "div", "click", "control-not-supported"],
    [
      "<private-component><button>Private text</button></private-component>",
      "button",
      "click",
      "target-unlocatable",
    ],
  ] as const)(
    "shows unsupported controls without collecting content: %s",
    (markup, selector, type, reason) => {
      const fixture = setup(markup);
      fixture.source.setEnabled(true);
      fixture.interact(selector, type);
      expect(fixture.events).toEqual([
        {
          kind: "unsupported",
          target: null,
          input: null,
          reason,
          screenshotSafe: false,
          layout: null,
        },
      ]);
    },
  );

  it("reports iframe presence once per enable and never reads its document or URL", async () => {
    const fixture = setup("<main></main>");
    fixture.source.setEnabled(true);
    const iframe = fixture.document.createElement("iframe");
    Object.defineProperty(iframe, "contentDocument", {
      get: () => {
        throw new Error("frame accessed");
      },
    });
    fixture.document.body.append(iframe);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.events.map((event) => event.reason)).toEqual([
      "iframe-not-supported",
    ]);
    fixture.source.setEnabled(false);
    fixture.source.setEnabled(true);
    expect(fixture.events).toHaveLength(2);
  });

  it("bounds capture to ten events per second and reports loss", () => {
    const fixture = setup("<button>Repeated</button>");
    let now = 0;
    vi.spyOn(fixture.testWindow.performance, "now").mockImplementation(
      () => now,
    );
    fixture.source.setEnabled(true);
    for (let index = 0; index < 100; index++)
      fixture.interact("button", "click");
    expect(fixture.events).toHaveLength(10);
    expect(fixture.events[9]?.reason).toBe("source-rate-limit");
    fixture.source.setEnabled(false);
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    expect(fixture.events).toHaveLength(10);
    now = 1_000;
    fixture.interact("button", "click");
    expect(fixture.events).toHaveLength(11);
    expect(
      fixture.events.every(
        (event) =>
          new TextEncoder().encode(JSON.stringify(event)).length <= 8_192,
      ),
    ).toBe(true);
  });

  it("never reads page text, storage, cookies or input values on click", () => {
    const fixture = setup("<input value='ordinary'>");
    for (const name of ["cookie", "textContent", "innerText"]) {
      Object.defineProperty(fixture.document, name, {
        get: () => {
          throw new Error(`read ${name}`);
        },
      });
    }
    const control = fixture.document.querySelector("input")!;
    Object.defineProperty(control, "value", {
      get: () => {
        throw new Error("read value");
      },
    });
    fixture.source.setEnabled(true);
    fixture.interact("input", "click");
    expect(fixture.events[0]?.kind).toBe("click");
    expect(fixture.events[0]?.input).toBeNull();
  });

  it("allows screenshots only for visible small ordinary controls with no composited content", () => {
    const fixture = setup(
      '<button>Export sales</button><input value="private"><button id="image"><img></button>',
    );
    const button = fixture.document.querySelector("button")!;
    Object.defineProperty(button, "getBoundingClientRect", {
      value: () => ({
        x: 10,
        y: 10,
        width: 120,
        height: 32,
        right: 130,
        bottom: 42,
      }),
    });
    vi.spyOn(fixture.testWindow, "getComputedStyle").mockReturnValue(
      screenshotStyle as never,
    );
    Object.defineProperty(fixture.document, "elementFromPoint", {
      value: () => button,
      configurable: true,
    });
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    fixture.interact("input");
    fixture.interact("#image", "click");
    expect(fixture.events.map((event) => event.screenshotSafe)).toEqual([
      true,
      false,
      false,
    ]);
    Object.defineProperty(fixture.document, "elementFromPoint", {
      value: () => fixture.document.body,
    });
    fixture.interact("button", "click");
    expect(fixture.events[3]?.screenshotSafe).toBe(false);
  });

  it.each([
    ["transparent", { backgroundColor: "rgba(0, 0, 0, 0)" }],
    ["rounded corners", { borderTopLeftRadius: "4px" }],
    ["transformed ancestor", { transform: "matrix(1, 0, 0, 1, 0, 0)" }],
  ])("rejects screenshot pixels with %s", (_label, unsafeStyle) => {
    const fixture = setup("<button>Export</button>");
    const button = fixture.document.querySelector("button")!;
    Object.defineProperty(button, "getBoundingClientRect", {
      value: () => ({
        x: 10,
        y: 10,
        width: 120,
        height: 32,
        right: 130,
        bottom: 42,
      }),
    });
    vi.spyOn(fixture.testWindow, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          ...screenshotStyle,
          ...(element === fixture.document.body ||
          _label !== "transformed ancestor"
            ? unsafeStyle
            : {}),
        }) as never,
    );
    Object.defineProperty(fixture.document, "elementFromPoint", {
      value: () => button,
    });
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    expect(fixture.events[0]?.screenshotSafe).toBe(false);
  });

  it("disables screenshots around a visible sensitive input without reading its value", () => {
    const fixture = setup('<button>Export</button><input type="password">');
    const button = fixture.document.querySelector("button")!;
    const password = fixture.document.querySelector("input")!;
    const valueGetter = vi.fn(() => {
      throw new Error("sensitive read");
    });
    Object.defineProperty(password, "value", { get: valueGetter });
    for (const control of [button, password]) {
      Object.defineProperty(control, "getBoundingClientRect", {
        value: () => ({
          x: 10,
          y: 10,
          width: 120,
          height: 32,
          right: 130,
          bottom: 42,
        }),
      });
    }
    vi.spyOn(fixture.testWindow, "getComputedStyle").mockReturnValue(
      screenshotStyle as never,
    );
    Object.defineProperty(fixture.document, "elementFromPoint", {
      value: () => button,
    });
    fixture.source.setEnabled(true);
    fixture.interact("button", "click");
    expect(fixture.events[0]?.screenshotSafe).toBe(false);
    expect(valueGetter).not.toHaveBeenCalled();
  });
});

describe("F02 R02 isolated page preload", () => {
  it("requires an explicit bounded host generation and never exposes a page API", async () => {
    const fixture = setup("<button>Export</button>");
    electron.on.mockReset();
    electron.send.mockReset();
    electron.exposeInMainWorld.mockReset();
    vi.stubGlobal("window", fixture.testWindow);
    vi.stubGlobal("document", fixture.document);
    await import("./recordingPagePreload.ts");
    expect(electron.on).toHaveBeenCalledWith(
      "crewon:recording:arm",
      expect.any(Function),
    );
    const arm = electron.on.mock.calls[0]?.[1] as (
      _event: unknown,
      payload: unknown,
    ) => void;
    const sourceSends = () =>
      electron.send.mock.calls.filter(
        ([channel]) => channel === "crewon:recording:event",
      );
    const verify = electron.on.mock.calls.find(
      ([channel]) => channel === "crewon:recording:verify-screenshot",
    )?.[1] as (_event: unknown, payload: unknown) => void;
    const verifiedSends = () =>
      electron.send.mock.calls.filter(
        ([channel]) => channel === "crewon:recording:screenshot-verified",
      );
    fixture.interact("button", "click");
    expect(electron.send).not.toHaveBeenCalled();
    arm({}, { generation: "approved-1" });
    fixture.interact("button", "click", false);
    expect(sourceSends()).toHaveLength(0);
    expect(electron.send).toHaveBeenCalledWith(
      "crewon:recording:armed",
      "approved-1",
    );
    fixture.interact("button", "click");
    expect(electron.send).toHaveBeenCalledWith("crewon:recording:event", {
      generation: "approved-1",
      event: expect.objectContaining({ kind: "click" }),
    });
    verify(
      {},
      {
        requestId: "check-1",
        generation: "wrong-generation",
        selector: "button",
      },
    );
    verify(
      {},
      {
        requestId: "../malformed",
        generation: "approved-1",
        selector: "button",
      },
    );
    expect(verifiedSends()).toHaveLength(0);
    verify(
      {},
      { requestId: "check-2", generation: "approved-1", selector: "button" },
    );
    expect(electron.send).toHaveBeenCalledWith(
      "crewon:recording:screenshot-verified",
      { requestId: "check-2", generation: "approved-1", safe: false },
    );
    for (const generation of [null, "", "x".repeat(129), {}, "../../forged"]) {
      arm({}, { generation });
      fixture.interact("button", "click");
    }
    expect(sourceSends()).toHaveLength(1);
    arm({}, { generation: "approved-2" });
    fixture.testWindow.dispatchEvent(new fixture.testWindow.Event("pagehide"));
    fixture.interact("button", "click");
    expect(sourceSends()).toHaveLength(1);
    verify(
      {},
      { requestId: "check-3", generation: "approved-2", selector: "button" },
    );
    expect(verifiedSends()).toHaveLength(1);
    expect(electron.exposeInMainWorld).not.toHaveBeenCalled();
  });
});

describe("F02 screenshot candidate revalidation", () => {
  it("verifies the stable candidate before and after capture and clears it on re-arm", () => {
    const fixture = screenshotFixture();
    fixture.interact("button", "click");
    const event = fixture.events[0]!;
    expect(event.screenshotSafe).toBe(true);
    const selector = event.target!.selector;
    expect(fixture.source.verifyScreenshot(selector)).toBe(true);
    expect(fixture.source.verifyScreenshot(selector)).toBe(true);
    expect(fixture.source.verifyScreenshot("button")).toBe(false);
    fixture.source.setEnabled(false);
    expect(fixture.source.verifyScreenshot(selector)).toBe(false);
    fixture.source.setEnabled(true);
    expect(fixture.source.verifyScreenshot(selector)).toBe(false);
    fixture.interact("button", "click");
    expect(fixture.source.verifyScreenshot(selector)).toBe(true);
  });

  it.each(["credential-modal", "text", "attribute", "geometry"])(
    "invalidates a candidate changed by the page click handler: %s",
    (change) => {
      const fixture = screenshotFixture();
      fixture.button.addEventListener("click", () => {
        if (change === "credential-modal") {
          const password = fixture.document.createElement("input");
          password.type = "password";
          fixture.document.body.append(password);
        } else if (change === "text") {
          fixture.button.firstChild!.nodeValue = "New content";
        } else if (change === "attribute") {
          fixture.button.setAttribute("aria-label", "New label");
        } else fixture.move();
      });
      fixture.interact("button", "click");
      const event = fixture.events[0]!;
      expect(event.screenshotSafe).toBe(true);
      // No asynchronous wait: queued MutationObserver records must also deny it.
      expect(fixture.source.verifyScreenshot(event.target!.selector)).toBe(
        false,
      );
    },
  );

  it("does not let an older event borrow a fresh candidate after a later click", () => {
    const fixture = screenshotFixture();
    fixture.interact("button", "click");
    const selector = fixture.events[0]!.target!.selector;
    expect(fixture.source.verifyScreenshot(selector)).toBe(true);
    fixture.button.textContent = "Export again";
    fixture.interact("button", "click");
    expect(fixture.events[1]?.screenshotSafe).toBe(true);
    expect(fixture.source.verifyScreenshot(selector)).toBe(false);
  });
});

describe("F02 R03 geometric evidence", () => {
  it("renders only bounded numeric geometry and fixed SVG elements", () => {
    const svg = recordingLayoutSvg({
      width: 800,
      height: 600,
      x: 10.2,
      y: 20.7,
      targetWidth: 40.5,
      targetHeight: 30,
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#f5f5f4"/><rect x="10" y="21" width="41" height="30" fill="#d6d3d1" stroke="#57534e"/></svg>',
    );
    expect(svg).not.toMatch(/<text|<image|<foreignObject|<script|href=/);
  });

  it.each([
    null,
    {},
    { width: Infinity },
    { width: "<script>" },
    { width: 17_000 },
  ])("rejects invalid geometry instead of interpolating it: %j", (value) => {
    expect(() => recordingLayoutSvg(value as never)).toThrow(
      "invalid-recording-layout",
    );
  });
});
