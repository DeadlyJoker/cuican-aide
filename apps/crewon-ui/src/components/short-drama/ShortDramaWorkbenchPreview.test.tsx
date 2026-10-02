import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ShortDramaWorkbenchPreview } from "./ShortDramaWorkbenchPreview";

it("shows the initial project, concept preview and explicit demonstration boundary", () => {
  expect(
    renderToStaticMarkup(
      <ShortDramaWorkbenchPreview referenceImage="/sample.png" />,
    ),
  ).toMatchSnapshot();
});
