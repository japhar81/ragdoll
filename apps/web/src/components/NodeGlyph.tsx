import {
  BarChart3,
  Box,
  Brain,
  CircleCheck,
  Container,
  Database,
  Dna,
  Download,
  FileText,
  FolderOpen,
  Hammer,
  Plug,
  Puzzle,
  RefreshCw,
  Repeat,
  Save,
  Scissors,
  Search,
  Shield,
  Split,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * Maps a node's stable icon key (from lib/graph.ts THEME) to a monochrome
 * Lucide line icon — the paddock look. Isolating the React/lucide import here
 * keeps graph.ts DOM-free and unit-testable.
 */
const ICONS: Record<string, LucideIcon> = {
  download: Download,
  upload: Upload,
  plug: Plug,
  "folder-open": FolderOpen,
  wrench: Wrench,
  scissors: Scissors,
  dna: Dna,
  database: Database,
  search: Search,
  "bar-chart": BarChart3,
  brain: Brain,
  "file-text": FileText,
  hammer: Hammer,
  shield: Shield,
  "check-circle": CircleCheck,
  puzzle: Puzzle,
  repeat: Repeat,
  split: Split,
  refresh: RefreshCw,
  save: Save,
  container: Container,
  box: Box,
};

export function NodeGlyph({ name, size = 15 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? Box;
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}
