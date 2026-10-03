import "react";

// lucide-react 0.468 uses only `keyof ReactSVG` for its public IconNode tag names.
// React 19 types removed this legacy map. Restore SVG tag names for type checking
// this existing icon version; this declaration emits no runtime or host changes.
declare module "react" {
  interface ReactSVG extends SVGElementTagNameMap {}
}
