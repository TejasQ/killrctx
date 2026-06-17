// ============================================================================
// FilterBadge.tsx — a read-only chip that displays the notebook's filter name
// ============================================================================
//
// _Basically_, every notebook has a dedicated OpenRAG knowledge filter that
// scopes retrieval to only that notebook's documents. This chip shows which
// filter is active so the user knows their chat and Studio are isolated.
//
// Styling and icon/color maps are copied from the reference repo:
//   SonicDMG/rag-to-model-compare  FilterSelector.tsx
// They match OpenRAG's own filter picker UI exactly. Icon names and color
// names are the string values OpenRAG stores on the filter object.
//
// `icon` and `color` come from the OpenRAG filter and are cached in SQLite,
// refreshed lazily on each GET /api/notebooks/[id]. They start null for new
// notebooks and are filled in after the user sets them in OpenRAG's UI.
// We fall back to teal + funnel when they are null.
// ============================================================================

import {
  Filter,
  Book,
  ScrollText,
  Library,
  Map,
  FileImage,
  Layers3,
  Database,
  Folder,
  Archive,
  MessagesSquare,
  SquareStack,
  Ghost,
  Gem,
  Swords,
  Zap,
  Shield,
  Hammer,
  Globe,
  HardDrive,
  Upload,
  Cable,
  ShoppingCart,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";

// Matches the ICON_MAP in rag-to-model-compare/FilterSelector.tsx.
// Key = the string OpenRAG stores on the filter; value = Lucide component.
const ICON_MAP: Record<string, LucideIcon> = {
  filter: Filter,
  book: Book,
  scroll: ScrollText,
  library: Library,
  map: Map,
  image: FileImage,
  layers3: Layers3,
  database: Database,
  folder: Folder,
  archive: Archive,
  messagesSquare: MessagesSquare,
  squareStack: SquareStack,
  ghost: Ghost,
  gem: Gem,
  swords: Swords,
  bolt: Zap,          // OpenRAG uses "bolt"; Lucide renamed it to Zap
  shield: Shield,
  hammer: Hammer,
  globe: Globe,
  hardDrive: HardDrive,
  upload: Upload,
  cable: Cable,
  shoppingCart: ShoppingCart,
  shoppingBag: ShoppingBag,
};

// Matches OpenRAG's color scheme — bg-{color}/10 text-{color} border-{color}/20
// for the unselected / display state used by the badge.
const COLOR_MAP: Record<string, string> = {
  red: "border-red-500/20 bg-red-500/10 text-red-400",
  emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  blue: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  purple: "border-purple-500/20 bg-purple-500/10 text-purple-400",
  amber: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  green: "border-green-500/20 bg-green-500/10 text-green-400",
  indigo: "border-indigo-500/20 bg-indigo-500/10 text-indigo-400",
  pink: "border-pink-500/20 bg-pink-500/10 text-pink-400",
  orange: "border-orange-500/20 bg-orange-500/10 text-orange-400",
  teal: "border-teal-500/20 bg-teal-500/10 text-teal-400",
};

const FALLBACK_CLASSES = COLOR_MAP.teal;

export default function FilterBadge({
  name,
  icon,
  color,
}: {
  name: string;
  icon?: string | null;
  color?: string | null;
}) {
  const IconComponent: LucideIcon = (icon && ICON_MAP[icon]) ? ICON_MAP[icon] : Filter;
  const colorClasses = (color && COLOR_MAP[color]) ? COLOR_MAP[color] : FALLBACK_CLASSES;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${colorClasses}`}
    >
      <IconComponent className="h-3 w-3 opacity-70" aria-hidden="true" />
      <span className="opacity-60">filter:</span> {name}
    </span>
  );
}
