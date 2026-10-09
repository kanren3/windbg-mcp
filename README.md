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
      "args": ["x", "--bun", "windbg-mcp@latest"]
    }
  }
}
```

## MCP protocol

The server uses the official [`@modelcontextprotocol/server` v2 SDK](https://github.com/modelcontextprotocol/typescript-sdk). Its `serveStdio` entry supports modern MCP `2026-07-28` requests and legacy `initialize` clients on both Node and Bun. The SDK owns JSON-RPC framing, version negotiation, request metadata, result encoding and protocol errors; tool schemas use Zod for advertised schemas and input/output validation.

Keep stdin open until the responses you need have arrived. EOF means the client has disconnected: the SDK cancels in-flight protocol requests without answering them, and the server closes open debugger sessions and terminates sessions still opening. Shutdown allows 1.5 seconds for graceful cleanup before forcing debugger termination. Explicitly detach before disconnecting if a live target must remain running.

Cancelling an individual MCP request does not send CTRL+BREAK to the debugger. Use `windbg_interrupt_target` to cancel a debugger command; a command's output remains collectable through `windbg_execute_command`.

## Tools

| Tool | Purpose |
| --- | --- |
| `windbg_open_dump` | Open a crash dump (.dmp/.mdmp/.hdmp) for analysis |
| `windbg_open_executable` | Launch a process under cdb |
| `windbg_attach_process` | Attach to a running process by pid or name |
| `windbg_attach_kernel` | Connect kd to a kernel target (KDNET / pipe / serial) |
| `windbg_execute_command` | Send a debugger command or read a page of its captured output |
| `windbg_sessions` | List active sessions with their state |
| `windbg_interrupt_target` | Interrupt a live target or cancel a debugger command, including dump commands |
| `windbg_search_commands` | Search the WinDbg command catalog by keyword |
| `windbg_close` | Request `q`, then force debugger termination if cooperative closing fails |
| `windbg_detach` | End session with `qd` — detaches and leaves a live user-mode or kernel target running |

## Execution and session lifecycle

Every session operation requires an explicit `session_id`; no operation silently selects the latest session. At most eight sessions may be open or opening in one server process. Failed openings and exited debuggers release their slots. New commands are serialized within each session, while overlapped stdin writes allow stdout draining, result collection and interrupts to proceed independently.

`windbg_execute_command` normally waits for completion. Its positive `timeout` is a waiting budget in seconds: expiry returns `completed: false` without interrupting the command. For a command such as `g`, return immediately with:

```json
{"session_id":"00000001","command":"g","wait_for_completion":false}
```

Collect the latest command's first output page by omitting `command`:

```json
{"session_id":"00000001","timeout":5}
```

Output is captured as UTF-8 text in command-owned temporary files, not accumulated in memory. A response contains at most 64 KiB of output by default; `max_output_bytes` accepts 4–262144 bytes. Continue with the returned `command_id` and `next_output_offset` as `output_offset`. Offsets count captured UTF-8 bytes and never split a character. `has_more_output` means another captured page is available; `completed=false` means additional output may still arrive.

Drain all pages before starting a new command: previous command IDs expire when a successor starts, while a collection already in progress remains bound to its captured command. Each command has a 256 MiB storage quota. Quota and storage failures are explicit tool errors (`output_error` accompanies readable partial results); they do not silently truncate a successful result or automatically interrupt the debugger. Use `windbg_interrupt_target` when a pending command must stop after a capture failure.

Output files normally disappear when replaced or when their session closes. Forced process exit during outstanding filesystem callbacks can leave `windbg-mcp-output-*` directories in the OS temporary directory.
Successful close/detach responses may include `output_cleanup_error` when temporary-file removal fails; that warning does not reverse the confirmed target lifecycle operation.

Sessions start with aliases cleared and prompt output disabled. Prompt-shaped command data and unterminated output remain intact. `ready_for_commands` requires confirmed readiness; `running: null` and `raw_status: null` mean the text channel cannot determine target execution state. Session `type` and `target` describe how it was initially opened, not a live target inventory: native commands can change the targets, so even sessions opened from dumps report unknown execution state while busy.

### Command transport

Redirected CDB/KD command text is ASCII-only: affected debugger builds can misinterpret multibyte input as console controls. This is an I/O compatibility limit, not a judgment about the requested debugging operation. Unicode executable, dump and symbol paths can be passed through the dedicated tool parameters, which use Windows wide-character process arguments. A request accepts up to 65536 characters, with at most 4094 per physical line to leave room for terminators in the debugger's input buffer. Input control bytes are rejected, line endings are normalized, and blank lines are ignored instead of invoking CDB's implicit repeat-last-command behavior.

Command semantics belong to CDB/KD. MCP does not filter commands by purpose or inspect scripts, aliases, breakpoint callbacks or shell arguments. Commands such as `.kill`, `.restart`, `.create` and `q` are passed to the debugger, which decides applicability in its current context. The lifecycle tools are convenient operations, not mandatory routes for native commands.

`completed: true` confirms that the private `.printf` completion marker was observed; it does not certify that the debugger command succeeded. Command errors are returned in debugger output. Commands that take over stdin or suppress marker output can leave completion unconfirmed. A timeout neither cancels execution nor proves failure. If the debugger exits before emitting the marker, the tool returns an error with captured output and the exited session is removed.

`windbg_detach` sends `qd` to the current debugger context and waits for process exit without force-killing on failure. Kernel `qd` support is retained; the catalog separates this compatibility fact from the upstream topic's outdated user-mode-only restriction. Failed interruption or detachment returns an error and leaves the debugger available for recovery. `windbg_close` first requests `q`, then forces debugger termination if cooperative closing fails, including when commands have disrupted the text channel. Closing a user-mode debugger can terminate its targets.

Hosts without a console remain console-free. Their debugger runs in a hidden console, and a short-lived Node/Bun helper attaches to that console to send CTRL+BREAK to the debugger's process group. The host's native signal handlers and MCP standard handles are left unchanged.

Launched console targets use CDB's `-2` option and have a separate console window, so debugger CTRL+BREAK events do not terminate the target. Attaching to an existing process leaves its console unchanged.

### Trust boundary

Run this server only for trusted clients and inputs, under appropriate host privileges. Debugger commands, extensions, symbols and `.shell` programs can execute native code; MCP input validation and tool annotations are not a sandbox. Use an isolated environment for untrusted binaries, dumps, symbols or extensions.

## Command reference

The catalog includes standard commands, meta-commands and extension commands such as `!analyze`, `!process`, `!irp` and `!wdfkd.wdfdevice`. Exact command identities rank ahead of fuzzy matches. Command cards present reference content without classifying executability or imposing tool routes; they retain source links and separate compatibility notes from upstream text. Relative Markdown/HTML documentation links are resolved when the catalog loads; imported source bodies remain intact. Refresh extension pages from a local Windows Driver documentation checkout with:

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

Tests exercise the official SDK client against legacy and modern stdio connections, plus actual child processes and debugger sessions. Protocol tests need Windows; session tests detect installed Debugging Tools. The explicit CDB path enables the stdio debugging scenarios. Set `WINDBG_MCP_TEST_RUNTIME` to a Bun executable to run protocol and stdio scenarios through Bun.

## References

- [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — agent design patterns that motivate the tool/agent boundaries here
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol this server implements
