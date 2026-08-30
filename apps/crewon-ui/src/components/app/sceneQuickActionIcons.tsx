import {
  BookMarked,
  Bug,
  ClipboardList,
  Compass,
  FileText,
  FlaskConical,
  Image,
  LayoutTemplate,
  Presentation,
  ScanEye,
  SearchCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { SceneQuickActionIcon } from "../../lib/scene/sceneCatalog";

/**
 * Resolves the catalog's icon name to a component. Keeping the mapping here lets
 * the scene catalog stay a plain data module with no React dependency.
 */
const QUICK_ACTION_ICONS = {
  bookMarked: BookMarked,
  bug: Bug,
  clipboardList: ClipboardList,
  compass: Compass,
  fileText: FileText,
  flaskConical: FlaskConical,
  image: Image,
  layoutTemplate: LayoutTemplate,
  presentation: Presentation,
  scanEye: ScanEye,
  searchCheck: SearchCheck,
  sparkles: Sparkles,
} as const satisfies Record<SceneQuickActionIcon, LucideIcon>;

export function SceneQuickActionIconGlyph({
  name,
}: {
  name: SceneQuickActionIcon;
}) {
  const Glyph = QUICK_ACTION_ICONS[name];
  return <Glyph aria-hidden={true} />;
}
