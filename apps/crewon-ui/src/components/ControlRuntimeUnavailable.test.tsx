import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlRuntimeUnavailable } from "./ControlRuntimeUnavailable";

describe("ControlRuntimeUnavailable", () => {
  it("blocks startup without offering a legacy runtime fallback", () => {
    const markup = renderToStaticMarkup(<ControlRuntimeUnavailable />);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Control 运行时不可用");
    expect(markup).toContain("不会连接旧 App Server");
    expect(markup).toContain("重新加载");
  });
});
