import { Minus, Square, X } from "lucide-react";

import type { PlatformKind } from "../lib/platform";

export function TitleBarWindowControls({
  platform,
}: {
  platform: PlatformKind;
}) {
  return (
    <div className="window-controls" aria-hidden="true">
      {platform === "mac" ? (
        <>
          <span className="traffic-light close" />
          <span className="traffic-light minimize" />
          <span className="traffic-light zoom" />
        </>
      ) : platform === "windows" ? (
        <>
          <button className="window-button" type="button" tabIndex={-1}>
            <Minus size={14} />
          </button>
          <button className="window-button" type="button" tabIndex={-1}>
            <Square size={12} />
          </button>
          <button
            className="window-button close-button"
            type="button"
            tabIndex={-1}
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <span className="web-window-spacer" />
      )}
    </div>
  );
}
