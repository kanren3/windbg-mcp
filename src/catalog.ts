/**
 * Command catalog — types, loading, search, and URI resolution.
 *
 * Mirrors the catalog design from windbg-mcp-rs: entries are extracted from the
 * debugger.chm documentation, each with an id, section, title, summary, tokens,
 * syntax blocks, and full documentation. Resources are addressed by
 * `windbg://command/{id}` (compact) and `windbg://command-full/{id}` (full).
 */

import catalogData from "./data/catalog.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogSection = "command" | "meta_command";

export type ToolRouting = "execute_command" | "interrupt_target" | "documentation_only";

export type CatalogResourceKind = "compact" | "full";

export interface CatalogEntry {
  id: string;
  section: CatalogSection;
  title: string;
  summary: string;
  tokens: string[];
  supports_text_execution: boolean;
  user_mode_syntax: string | null;
  kernel_mode_syntax: string | null;
  documentation: string;
}

// ---------------------------------------------------------------------------
// URI constants
// ---------------------------------------------------------------------------

export const RESOURCE_SCHEME = "windbg://command/";
export const FULL_RESOURCE_SCHEME = "windbg://command-full/";
export const TEMPLATE_URI = "windbg://command/{id}";
export const FULL_TEMPLATE_URI = "windbg://command-full/{id}";

// ---------------------------------------------------------------------------
// Entry helpers
// ---------------------------------------------------------------------------

export function entryFullResourceUri(entry: CatalogEntry): string {
  return `${FULL_RESOURCE_SCHEME}${entry.id}`;
}

/** Structured syntax from explicit user/kernel fields, falling back to inference. */
export function entrySyntaxBlock(entry: CatalogEntry): string | null {
  return formatStructuredSyntax(entry.user_mode_syntax, entry.kernel_mode_syntax)
    ?? inferSyntaxBlock(entry.documentation);
}

function formatStructuredSyntax(userMode: string | null, kernelMode: string | null): string | null {
  const um = cleanedBlock(userMode);
  const km = cleanedBlock(kernelMode);
  if (!um && !km) return null;

  let out = "";
  if (um) { out += "User-Mode Syntax\n"; out += um; }
  if (km) {
    if (out) out += "\n\n";
    out += "Kernel-Mode Syntax\n";
    out += km;
  }
  return out;
}

function cleanedBlock(block: string | null): string | null {
  if (!block) return null;
  const trimmed = block.trim();
  return trimmed || null;
}

function inferSyntaxBlock(documentation: string): string | null {
  const lines = documentation.split("\n");
  if (lines.length === 0) return null;

  let i = 0;
  // Skip leading blank lines
  while (i < lines.length && lines[i].trim() === "") i++;
  // Skip title (first non-blank block)
  while (i < lines.length && lines[i].trim() !== "") i++;
  // Skip blank separator
  while (i < lines.length && lines[i].trim() === "") i++;
  // Skip summary (second non-blank block)
  while (i < lines.length && lines[i].trim() !== "") i++;
  // Skip blank separator
  while (i < lines.length && lines[i].trim() === "") i++;
  // The third non-blank block is the syntax
  const start = i;
  while (i < lines.length && lines[i].trim() !== "") i++;
  if (start >= i) return null;
  return lines.slice(start, i).join("\n").trim() || null;
}

export function entryToolRouting(entry: CatalogEntry): ToolRouting {
  if (entry.supports_text_execution) return "execute_command";
  if (entry.tokens.some((t) => t.toUpperCase() === "CTRL+C")) return "interrupt_target";
  return "documentation_only";
}

export function entryRecommendedTool(entry: CatalogEntry): string | null {
  switch (entryToolRouting(entry)) {
    case "execute_command": return "windbg_execute_command";
    case "interrupt_target": return "windbg_interrupt_target";
    case "documentation_only": return null;
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export class Catalog {
  private entries: CatalogEntry[];
  private byId: Map<string, number>;

  private constructor(entries: CatalogEntry[]) {
    this.entries = entries;
    this.byId = new Map();
    for (let i = 0; i < entries.length; i++) {
      this.byId.set(entries[i].id, i);
    }
  }

  private static instance: Catalog | null = null;

  static load(): Catalog {
    if (Catalog.instance) return Catalog.instance;
    const raw = catalogData as CatalogEntry[];
    // Validate section values
    const entries = raw.map((e) => ({
      ...e,
      section: e.section === "meta_command" ? "meta_command" : "command",
    }));
    Catalog.instance = new Catalog(entries);
    return Catalog.instance;
  }

  len(): number { return this.entries.length; }

  getById(id: string): CatalogEntry | null {
    const idx = this.byId.get(id);
    return idx !== undefined ? this.entries[idx] : null;
  }

  resolveResourceUri(uri: string): { kind: CatalogResourceKind; entry: CatalogEntry } | null {
    if (uri.startsWith(RESOURCE_SCHEME)) {
      const entry = this.getById(uri.slice(RESOURCE_SCHEME.length));
      return entry ? { kind: "compact", entry } : null;
    }
    if (uri.startsWith(FULL_RESOURCE_SCHEME)) {
      const entry = this.getById(uri.slice(FULL_RESOURCE_SCHEME.length));
      return entry ? { kind: "full", entry } : null;
    }
    return null;
  }

  search(query: string, limit: number): CatalogEntry[] {
    limit = Math.max(0, Math.trunc(limit));
    const needle = query.trim().toLowerCase();
    if (!needle) return this.entries.slice(0, limit);

    const terms = needle.split(/\s+/).filter(Boolean);
    const scored: { score: number; matched: number; entry: CatalogEntry }[] = [];

    for (const entry of this.entries) {
      let score = 0;
      let matched = 0;

      // Exact id match
      if (entry.id === needle) score += 1000;

      // Token matches
      for (const token of entry.tokens) {
        const tl = token.toLowerCase();
        if (tl === needle) score += 500;
        else if (tl.startsWith(needle)) score += 200;
        else if (tl.includes(needle)) score += 100;
      }

      // Per-term matches
      for (const term of terms) {
        let hit = false;
        for (const token of entry.tokens) {
          const tl = token.toLowerCase();
          if (tl === term) { score += 50; hit = true; }
          else if (tl.startsWith(term)) { score += 20; hit = true; }
          else if (tl.includes(term)) { score += 10; hit = true; }
        }
        if (entry.title.toLowerCase().includes(term)) { score += 15; hit = true; }
        if (entry.summary.toLowerCase().includes(term)) { score += 5; hit = true; }
        if (hit) matched++;
      }

      if (score > 0) scored.push({ score, matched, entry });
    }

    scored.sort((a, b) =>
      b.score - a.score || b.matched - a.matched || a.entry.id.localeCompare(b.entry.id),
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }

  renderIndex(): string {
    const commandCount = this.entries.filter((e) => e.section === "command").length;
    const metaCount = this.len() - commandCount;

    let out = "";
    out += "WinDbg MCP guide\n\n";
    out += "Recommended flow:\n";
    out += "1. Read `windbg://command/{id}` for the best match; it is optimized for low context.\n";
    out += "2. Read `windbg://command-full/{id}` only when the compact card is insufficient.\n";
    out += "3. Call `windbg_sessions` to check the debugger state before execution.\n";
    out += "4. If the debugger is running or busy, call `windbg_interrupt_target` and then verify state again.\n";
    out += "5. Call `windbg_execute_command` only when the debugger is ready for commands.\n\n";
    out += `Total entries: ${this.len()}\n`;
    out += `Commands: ${commandCount}\n`;
    out += `Meta-commands: ${metaCount}\n`;
    out += "Session state tool: windbg_sessions\n";
    out += `Compact template: ${TEMPLATE_URI}\n`;
    out += `Full template: ${FULL_TEMPLATE_URI}\n\n`;
    return out;
  }
}
