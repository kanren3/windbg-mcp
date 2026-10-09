# windbg-mcp

MCP server that lets LLM agents use **cdb.exe** and **kd.exe** for crash dump analysis, live process debugging, and kernel debugging.

> Windows x64 or ARM64. Requires [Node.js](https://nodejs.org) ≥ 22 or [Bun](https://bun.sh), plus the [Windows Debugging Tools](https://learn.microsoft.com/windows-hardware/drivers/debugger/) (`cdb.exe` / `kd.exe`).

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
      "args": ["x", "--bun", "windbg-mcp@latest"]
    }
  }
}
```

Debugging Tools are auto-detected from Windows Kits or the Store-installed WinDbg. For a custom installation, pass `cdb_path` or `kd_path` to the relevant open/attach tool.

## Tools

| Tool | Purpose |
| --- | --- |
| `windbg_open_dump` | Open a crash dump (.dmp/.mdmp/.hdmp) for analysis |
| `windbg_open_executable` | Launch a process under cdb |
| `windbg_attach_process` | Attach to a running process by pid or name |
| `windbg_attach_kernel` | Connect kd to a kernel target (KDNET / pipe / serial) |
| `windbg_execute_command` | Run a debugger command or collect its output |
| `windbg_sessions` | List active sessions and their state |
| `windbg_interrupt_target` | Interrupt a live target or a long-running debugger command |
| `windbg_search_commands` | Search the WinDbg command reference |
| `windbg_close` | Close the debugger; may terminate user-mode targets |
| `windbg_detach` | Detach and leave a live user-mode or kernel target running |

The agent can use `windbg_search_commands` and read the returned command resource for full documentation. The `windbg://guide/overview` resource explains the debugging workflow and tool usage.

## Usage notes

- Pass the `session_id` returned by an open/attach tool to subsequent session operations.
- For long-running commands such as `g`, use `wait_for_completion: false`. A timeout does not stop the command; use `windbg_interrupt_target` when it needs to stop.
- Output is paginated. Omit `command` to collect output, and read all needed pages before starting another command or ending the session. Exited sessions are removed and their output is no longer available for collection.
- If a live target must keep running, use `windbg_detach` before disconnecting the MCP client. Disconnecting cleans up debugger sessions and may terminate their targets.
- Debugger command text is ASCII-only. Pass Unicode executable, dump and symbol paths through the dedicated tool parameters instead.

**Security:** Use only trusted clients and inputs. Debugger commands and extensions can execute native code; this server is not a sandbox.
