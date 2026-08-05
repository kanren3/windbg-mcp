/**
 * Resource rendering — guide, compact command cards, full command pages.
 *
 * Mirrors windbg-mcp-rs/src/resources.rs: the guide teaches the low-context
 * workflow, compact cards give syntax-first metadata, and full pages append
 * the complete documentation.
 */

import {
  type Catalog,
  type CatalogEntry,
  entryFullResourceUri,
  entryRecommendedTool,
  entrySyntaxBlock,
  entryToolRouting,
} from "./catalog.ts";

export const GUIDE_URI = "windbg://guide/overview";

export function renderGuide(catalog: Catalog): string {
  let out = "";
  out += "WinDbg MCP overview\n\n";
  out += "This server drives cdb.exe (user mode) and kd.exe (kernel) as subprocesses.\n\n";
  out += "Workflow\n";
  out += "--------\n";
  out += "1. Open a session: `windbg_open_executable` (start a process), `windbg_open_dump` (crash dump), `windbg_attach_process` (pid/name), or `windbg_attach_kernel` (KDNET/pipe/serial).\n";
  out += "2. List sessions and their states with `windbg_sessions`. Only call `windbg_execute_command` when the session state is `break` (ready_for_commands=true).\n";
  out += "3. If the target is `running` or `busy`, call `windbg_interrupt_target` to break in, then re-check `windbg_sessions`.\n";
  out += "4. Run commands with `windbg_execute_command`. Read `windbg://command/{id}` for command syntax, `windbg://command-full/{id}` for the full topic.\n";
  out += "5. End a session with `windbg_close` (`q`; a process started by windbg_open_executable is terminated) or `windbg_detach` (`qd`; the debuggee keeps running).\n\n";

  out += "Command reference\n";
  out += "-----------------\n";
  out += "Use windbg_search_commands to find exact syntax for any WinDbg/KD command.\n";
  out += "Read windbg://command/{id} for a compact card or windbg://command-full/{id} for full docs.\n\n";

  out += "Key resources\n";
  out += "-------------\n";
  out += `- Guide: ${GUIDE_URI}\n`;
  out += `- Compact command card template: windbg://command/{id}\n`;
  out += `- Full command page template: windbg://command-full/{id}\n\n`;
  out += "Key tools\n";
  out += "---------\n";
  out += "- windbg_open_executable\n";
  out += "- windbg_open_dump\n";
  out += "- windbg_attach_process\n";
  out += "- windbg_attach_kernel\n";
  out += "- windbg_sessions\n";
  out += "- windbg_interrupt_target\n";
  out += "- windbg_execute_command\n";
  out += "- windbg_search_commands\n";
  out += "- windbg_close\n";
  out += "- windbg_detach\n\n";
  out += catalog.renderIndex();
  return out;
}

export function renderCompactCommand(entry: CatalogEntry): string {
  let out = "";
  out += `Title: ${entry.title}\n`;
  out += `Catalog Id: ${entry.id}\n`;
  out += `Tokens: ${entry.tokens.join(", ")}\n`;
  out += `Summary: ${entry.summary}\n`;
  out += `Tool Route: ${entryToolRouting(entry)}\n`;

  const rec = entryRecommendedTool(entry);
  out += rec ? `Recommended Tool: ${rec}\n` : "Recommended Tool: documentation only\n";

  out += `Full Resource: ${entryFullResourceUri(entry)}\n`;

  const syntax = entrySyntaxBlock(entry);
  if (syntax) {
    out += "\nSyntax\n------\n";
    out += syntax;
    out += "\n";
  }

  out += "\nNext Step\n---------\n";
  switch (entryToolRouting(entry)) {
    case "execute_command":
      out += "Build the final WinDbg command string from the syntax above, call `windbg_sessions` to check state, interrupt if needed, and then call `windbg_execute_command`.\n";
      break;
    case "interrupt_target":
      out += "This topic maps to an engine-level break action. Use `windbg_interrupt_target` instead of `windbg_execute_command`.\n";
      break;
    case "documentation_only":
      out += "This topic is documentation-only in MCP because it describes a UI shortcut or non-text action.\n";
      break;
  }

  return out;
}

export function renderFullCommand(entry: CatalogEntry): string {
  let out = renderCompactCommand(entry);
  out += "\nDocumentation\n-------------\n";
  out += entry.documentation;
  return out;
}
