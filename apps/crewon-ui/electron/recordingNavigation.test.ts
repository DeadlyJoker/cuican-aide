import { describe, expect, it } from "vitest";
import { recordingPage, teachingUrl } from "./recordingNavigation.ts";
describe("recording navigation projection", () => {
  it("keeps reusable routes but removes query values, fragments and credential paths", () => {
    const page = recordingPage(
      "https://example.test/orders/weekly?date=2026-09-01&token=never-export#private",
    );
    expect(page.routeTemplate).toContain("/orders/weekly?date={runtime}");
    expect(JSON.stringify(page)).not.toContain("never-export");
    expect(JSON.stringify(page)).not.toContain("private");
    const protectedPage = recordingPage(
      "https://example.test/token/abc123456789123456789123456789/orders",
    );
    expect(protectedPage.routeTemplate).toBe(
      "https://example.test/{runtime}/{runtime}/orders",
    );
  });
  it("rejects credentials and non-web schemes before opening a teaching page", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@example.test/",
    ])
      expect(() => teachingUrl(url)).toThrow("recording_url_invalid");
  });
});
