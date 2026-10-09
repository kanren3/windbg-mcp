/**
 * Resource rendering — the workflow guide and the full command page.
 *
 * The guide teaches the low-context workflow; the command page renders a
 * single catalog entry with its complete documentation.
 */

import type { Catalog, CatalogEntry } from "./catalog.js";

export const GUIDE_URI = "windbg://guide/overview";

export function renderGuide(catalog: Catalog): string {
  let out = "";
  out += "WinDbg MCP overview\n\n";
  out += "This server drives cdb.exe (user mode) and kd.exe (kernel) as subprocesses.\n\n";
  out += "Workflow\n";
  out += "--------\n";
  out += "1. Open a session: `windbg_open_executable` (start a process), `windbg_open_dump` (crash dump), `windbg_attach_process` (pid/name), or `windbg_attach_kernel` (KDNET/pipe/serial).\n";
  out += "2. Pass the returned session_id to every session operation. Check windbg_sessions before a new command: state=ready confirms the command channel is ready; busy means a command is pending; unavailable means readiness is unconfirmed or I/O failed, with details in error. Closing and exited describe the debugger process lifecycle. These states do not identify target execution state. Session type and target describe how the session was opened, not subsequent debugger target changes. At most eight sessions may be open or opening.\n";
  out += "3. Use `windbg_execute_command` with `wait_for_completion=false` for commands such as `g`. A wait timeout returns `completed=false` and leaves the command pending. Omit `command` to collect its paginated output; use the returned command_id and next_output_offset to read further pages. Output is backed by a temporary file with an explicit disk quota, not silently truncated.\n";
  out += "4. Call `windbg_interrupt_target` to stop a running target or cancel a debugger command, including dump analysis. It waits for a confirmed command prompt.\n";
  out += "5. End a session with `windbg_close` (requests q, then forces debugger termination if needed) or `windbg_detach` (sends qd and waits for exit without force-killing on failure). Detach is intended to leave live targets running; CDB/KD decides whether it applies to the current context.\n\n";
  out += "Commands are passed to CDB/KD without semantic filtering. The debugger determines their applicability in the current context, including target changes, scripts and aliases. The lifecycle tools are convenient session operations, not mandatory command routes.\n";
  out += "Completion is confirmed by a private .printf marker. Commands, scripts and extensions must leave debugger input available and preserve marker output. Taking over input or changing output settings can prevent completion confirmation; a timeout does not prove failure or cancel execution. Results report the current state, not execution-state snapshots. An observed debugger exit returns state=exited with captured output; completed remains false if the marker was not observed. Exit does not imply command success. The exited session and its output are removed, so this final response is the last available page. I/O and output storage failures remain tool errors.\n\n";
  out += "Redirected debugger command text is ASCII-only because affected CDB readers can misinterpret multibyte input as console controls. Use tool parameters for Unicode paths. Requests allow 65536 characters total and 4094 per line; blank lines do not repeat commands.\n\n";

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
  if (entry.compatibility_note) {
    out += "\nRuntime Compatibility (MCP)\n---------------------------\n";
    out += entry.compatibility_note + "\n";
  }

  out += "\nDocumentation\n-------------\n";
  out += entry.documentation;
  return out;
}
