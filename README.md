# windbg-mcp

MCP server that drives **cdb.exe** (user mode) and **kd.exe** (kernel mode) as subprocesses, exposing WinDbg debugging to LLM agents over the Model Context Protocol: crash dump analysis, live process debugging, and kernel debugging — plus a searchable 288-entry WinDbg command reference.

> Windows only. Requires [Bun](https://bun.sh) ≥ 1.1 (uses `bun:ffi`) and the [Windows Debugging Tools](https://learn.microsoft.com/windows-hardware/drivers/debugger/) (`cdb.exe` / `kd.exe`, auto-detected from the standard Windows Kits paths).

## Usage

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "windbg-mcp": {
      "command": "bunx",
      "args": ["windbg-mcp"]
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
| `windbg_execute_command` | Run any debugger command (`kb`, `lm`, `!analyze -v`, …) |
| `windbg_sessions` | List sessions with state (`ready_for_commands`) |
| `windbg_interrupt_target` | Break into a running target (CTRL+BREAK) |
| `windbg_search_commands` | Search the WinDbg command catalog by keyword |
| `windbg_close` | End session, terminating the debuggee |
| `windbg_detach` | End session, leaving the debuggee running |

## Development

```sh
git clone https://github.com/kanren3/windbg-mcp.git
cd windbg-mcp
bun run src/index.ts
```
