import React from "react";
import { createRoot } from "react-dom/client";
import { ShortDramaWorkbenchPreview } from "../../apps/crewon-ui/src/components/short-drama/ShortDramaWorkbenchPreview";
import "../../apps/crewon-ui/src/styles/app.css";
import "../../apps/crewon-ui/src/styles/appearance.css";
import referenceImage from "./assets/crewon-krea2-reference.png";

document.documentElement.dataset.surface = "web";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ShortDramaWorkbenchPreview referenceImage={referenceImage} />
  </React.StrictMode>,
);
