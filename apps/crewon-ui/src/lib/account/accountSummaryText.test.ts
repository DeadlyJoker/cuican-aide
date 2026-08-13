import { describe, expect, it } from "vitest";

import type { AccountStatus } from "../shared/statusTypes";
import {
  accountReadErrorPanel,
  accountStatusText,
  rateLimitText,
} from "./accountSummaryText";

describe("account summary text", () => {
  it("formats only the remaining account status projection", () => {
    const chatGpt: AccountStatus = {
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: false,
    };
    expect(accountStatusText(chatGpt, "en")).toBe("user@example.com\nplus");
    expect(
      accountStatusText(
        { account: null, requiresOpenaiAuth: true },
        "en",
      ),
    ).toBe("Model account auth required");
  });

  it("formats the bounded rate-limit notification summary", () => {
    expect(
      rateLimitText(
        {
          limitId: "requests",
          limitName: null,
          primary: {
            usedPercent: 42.4,
            windowDurationMins: 60,
            resetsAt: null,
          },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: "12" },
          planType: null,
          rateLimitReachedType: null,
          individualLimit: null,
        },
        "en",
      ),
    ).toEqual([
      "Rate limit: requests",
      "Primary: 42%",
      "Credits: 12",
    ]);
  });

  it("projects safe account read failures", () => {
    expect(accountReadErrorPanel(new Error("unavailable"), "en")).toEqual({
      title: "Account",
      subtitle: "Auth status",
      error: "unavailable",
    });
  });
});
