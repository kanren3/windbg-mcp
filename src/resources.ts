/**
 * Resource rendering — the workflow guide and the full command page.
 *
 * The guide teaches the low-context workflow; the command page renders a
 * single catalog entry with its routing guidance and complete documentation.
 */

import {
  type Catalog,
  type CatalogEntry,
  entryRecommendedTool,
  entryToolRouting,
} from "./catalog.js";

export const GUIDE_URI = "windbg://guide/overview";

export function renderGuide(catalog: Catalog): string {
  let out = "";
  out += "WinDbg MCP overview\n\n";
  out += "This server drives cdb.exe (user mode) and kd.exe (kernel) as subprocesses.\n\n";
  out += "Workflow\n";
  out += "--------\n";
  out += "1. Open a session: `windbg_open_executable` (start a process), `windbg_open_dump` (crash dump), `windbg_attach_process` (pid/name), or `windbg_attach_kernel` (KDNET/pipe/serial).\n";
  out += "2. Check `windbg_sessions` before submitting a new command. `ready_for_commands=true` means a prompt was confirmed; `running=null` means the target's execution state is unknown.\n";
  out += "3. Use `windbg_execute_command` with `wait_for_completion=false` for commands such as `g`. A wait timeout returns `completed=false` and leaves the command pending. Omit `command` to collect its cumulative output without executing it again.\n";
  out += "4. Call `windbg_interrupt_target` to stop a running target or cancel a debugger command, including dump analysis. It waits for a confirmed command prompt.\n";
  out += "5. End a session with `windbg_close` (`q`; in user mode this closes the target application) or `windbg_detach` (`qd`; detaches and leaves the target running — live user-mode or kernel-mode targets, not dumps).\n\n";

  out += "Command reference\n";
  out += "-----------------\n";
  out += "Use `windbg_search_commands` to find a command, then read `windbg://command/{id}` for its full documentation.\n";
  out += "Documentation pages can be several KB each; when the client supports subagents, run the search + read + command synthesis in a subagent and return only the final command to the main agent.\n\n";

  out += "Key resources\n";
  out += "-------------\n";
  out += `- Guide: ${GUIDE_URI}\n`;
  out += `- Command page template: windbg://command/{id}\n\n`;
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

export function renderCommand(entry: CatalogEntry): string {
  let out = "";
  out += `Title: ${entry.title}\n`;
  out += `Catalog Id: ${entry.id}\n`;
  out += `Tokens: ${entry.tokens.join(", ")}\n`;
  out += `Summary: ${entry.summary}\n`;
  if (entry.source) out += `Source: ${entry.source}\n`;
  out += `Tool Route: ${entryToolRouting(entry)}\n`;

  const rec = entryRecommendedTool(entry);
  out += rec ? `Recommended Tool: ${rec}\n` : "Recommended Tool: documentation only\n";

  out += "\nNext Step\n---------\n";
  switch (entryToolRouting(entry)) {
    case "execute_command":
      out += "Confirm ready_for_commands before submitting a new command. Use wait_for_completion=false for execution-control commands; omit command on later calls to collect a pending result. To cancel it, use windbg_interrupt_target.\n";
      break;
    case "interrupt_target":
      out += "This topic maps to an engine-level break action. Use `windbg_interrupt_target` instead of `windbg_execute_command`.\n";
      break;
    case "documentation_only":
      out += "This topic is documentation-only in MCP because it describes a UI shortcut or non-text action.\n";
      break;
  }

  out += "\nDocumentation\n-------------\n";
  out += entry.documentation;
  return out;
}
