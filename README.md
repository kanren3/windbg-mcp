# windbg-mcp

MCP server that drives **cdb.exe** (user mode) and **kd.exe** (kernel mode) as subprocesses, exposing WinDbg debugging to LLM agents over the Model Context Protocol: crash dump analysis, live process debugging, and kernel debugging.

> Windows x64 or ARM64. Requires [Node.js](https://nodejs.org) ≥ 22 (uses `koffi`) or [Bun](https://bun.sh) (uses `bun:ffi`), plus the [Windows Debugging Tools](https://learn.microsoft.com/windows-hardware/drivers/debugger/) (`cdb.exe` / `kd.exe`, auto-detected from the standard Windows Kits paths or the Store-installed WinDbg for Windows).

## Usage

Add to your MCP client configuration (Node):

```json
{
  "mcpServers": {
    "windbg-mcp": {
      "command": "npx",
      "args": ["-y", "windbg-mcp@latest"]
    }
  }
}
```

Or with Bun:

```json
{
  "mcpServers": {
    "windbg-mcp": {
      "command": "bun",
      "args": ["x", "windbg-mcp@latest"]
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `windbg_open_dump` | Open a crash dump (.dmp/.mdmp/.hdmp) for analysis |
| `windbg_open_executable` | Launch a process under cdb |
| `windbg_attach_process` | Attach to a running process by pid or name |
| `windbg_attach_kernel` | Connect kd to a kernel target (KDNET / pipe / serial) |
| `windbg_execute_command` | Execute a command or collect the most recent command's cumulative output |
| `windbg_sessions` | List active sessions with their state |
| `windbg_interrupt_target` | Interrupt a live target or cancel a debugger command, including dump commands |
| `windbg_search_commands` | Search the WinDbg command catalog by keyword |
| `windbg_close` | End session with `q` — closes the user-mode target (a kernel target stays locked) |
| `windbg_detach` | End session with `qd` — detaches and leaves a live user-mode or kernel target running |

## Execution and session safety

New commands are serialized within each session. Other sessions, state queries, result collection and interrupts remain responsive while a command is pending.

`windbg_execute_command` normally waits for completion. Its positive `timeout` is a waiting budget in seconds: expiry returns `completed: false` without interrupting the command. For a command such as `g`, return immediately with:

```json
{"session_id":"00000001","command":"g","wait_for_completion":false}
```

Collect the same command's cumulative output by omitting `command`:

```json
{"session_id":"00000001","timeout":5}
```

Sessions start with debugger prompt output disabled (`.outmask- /l 0x10`); prompt-shaped text emitted by commands is preserved.

Snapshots include received output even before a newline. Each collection call stays bound to the most recently started command, even if another command starts before the collection finishes. To regain a prompt, call `windbg_interrupt_target`. `ready_for_commands` requires a confirmed prompt; `running: null` and `raw_status: null` indicate that the text channel cannot determine the target's execution state. A dump can have a busy debugger without being a running target.

`windbg_detach` uses `qd` for live user-mode and kernel-mode targets and waits for the debugger to exit. Failed interruption or detachment returns an error and leaves the debugger available for recovery. `windbg_close` uses `q`; server shutdown closes remaining sessions, with forced debugger termination as an exit fallback. Explicitly detach before disconnecting if a live user-mode target must remain running.

Hosts without a console remain console-free. Their debugger runs in a hidden console, and a short-lived Node/Bun helper attaches to that console to send CTRL+BREAK to the debugger's process group. The host's native signal handlers and MCP standard handles are left unchanged.

Launched console targets use CDB's `-2` option and have a separate console window, so debugger CTRL+BREAK events do not terminate the target. Attaching to an existing process leaves its console unchanged.

## Command reference

The catalog includes standard commands, meta-commands and extension commands such as `!analyze`, `!process`, `!irp` and `!wdfkd.wdfdevice`. Extension resources include their Microsoft Learn source URL. Refresh extension pages from a local Windows Driver documentation checkout with:

```sh
node scripts/import-extensions.mjs <windows-driver-docs-pr>/debuggercmds
```

## Development checks

```powershell
npm ci
npm run build
$env:WINDBG_MCP_TEST_CDB_PATH = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
npm test
```

Tests exercise actual child processes and debugger sessions. Protocol-only tests need Windows; session tests detect installed Debugging Tools. The explicit CDB path enables the stdio debugging scenarios. Set `WINDBG_MCP_TEST_RUNTIME` to a Bun executable to exercise those stdio scenarios through Bun.

## References

- [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — agent design patterns that motivate the tool/agent boundaries here
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol this server implements
