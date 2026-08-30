import { describe, expect, it } from "vitest";

import {
  appMentionAddedPanel,
  appMentionAddedPatch,
} from "./appMentionPresentation";

describe("app mention panel presentation", () => {
  it("builds app mention panel patches", () => {
    expect(
      appMentionAddedPatch(
        {
          path: "app://browser",
          token: "$browser",
        },
        "zh",
      ),
    ).toEqual({
      body: "$browser 已加入输入框。发送后会通过 turn/start 携带 app mention：app://browser",
      error: undefined,
    });
    expect(
      appMentionAddedPatch(
        {
          path: "app://browser",
          token: "$browser",
        },
        "en",
      ),
    ).toEqual({
      body: "$browser added to the composer. Sending will include the app mention through turn/start: app://browser",
      error: undefined,
    });
    expect(
      appMentionAddedPanel(
        { title: "Browser", body: "Ready", error: "old" },
        {
          path: "app://browser",
          token: "$browser",
        },
        "en",
      ),
    ).toEqual({
      title: "Browser",
      body: "$browser added to the composer. Sending will include the app mention through turn/start: app://browser",
      error: undefined,
    });
    expect(
      appMentionAddedPanel(
        null,
        {
          path: "app://browser",
          token: "$browser",
        },
        "en",
      ),
    ).toBeNull();
  });
});
