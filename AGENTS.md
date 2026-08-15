# Repository Guidelines

## Project Overview

`windbg-mcp` is a Windows-only, zero-dependency TypeScript MCP server running on **Bun**. It drives `cdb.exe` (user mode) and `kd.exe` (kernel mode) as Win32 subprocesses and exposes WinDbg debugging — crash-dump analysis, live process debugging, kernel debugging — to LLM agents over the Model Context Protocol.

The MCP protocol is **hand-rolled** (no `@modelcontextprotocol/sdk`): newline-delimited JSON-RPC 2.0 over stdio. It supports both the `server/discover` era (`2026-07-28`) and legacy `initialize` version negotiation.

## Architecture & Data Flow

```
stdin (JSON-RPC lines)
  → src/index.ts          serialized dispatch (promise-chain `tail`)
  → src/mcp.ts            McpServer.handle → tool methods
  → src/session.ts        DebuggerSession + factories
  → src/spawn_win32.ts    kernel32.dll FFI (CreateProcessW)
  → cdb.exe / kd.exe      child process, piped stdio
  → marker protocol       `.echo COMMAND_COMPLETED_MARKER_N`
  → stdout (JSON-RPC response lines)
```

- **`src/index.ts`** — entry point (`#!/usr/bin/env bun`). Buffers stdin, splits newline-delimited JSON, and chains each dispatch onto `tail` so pipelined requests cannot interleave and corrupt the marker protocol. Handles parse errors (`-32700`). Cleans up child processes on SIGINT/SIGTERM/SIGHUP (async) and `exit` (sync).
- **`src/mcp.ts`** — `McpServer` class, the session registry (`Map<string, SessionRecord>`), and all 10 `windbg_*` tool definitions and implementations. Also serves the guide and `windbg://command/{id}` resources.
- **`src/session.ts`** — `DebuggerSession`: one cdb/kd child per session. Owns the marker protocol, prompt detection, execution-state inference, and child lifecycle (`start`/`execute`/`interrupt`/`close`/`detach`/`killSync`). Exposes factory functions `createCdbExecutableSession`, `createCdbDumpSession`, `createCdbAttachSession`, `createKdSession`.
- **`src/spawn_win32.ts`** — raw `kernel32.dll` FFI via `bun:ffi` (`dlopen`), with manual `STARTUPINFOW`/`PROCESS_INFORMATION` struct layouts. Spawns with `CREATE_NEW_PROCESS_GROUP` and piped stdio.
- **`src/catalog.ts`** — `Catalog` singleton loading `src/data/catalog.json`; search scoring and `windbg://command/...` URI resolution.
- **`src/resources.ts`** — text renderers for the guide and command cards.

### Session state model

`DebuggerSession` never queries the engine for state. It **infers** state from three signals:

1. Process liveness (`WaitForSingleObject`) → `no_debuggee` if dead.
2. `_atPrompt` (prompt regex `/\d+:\s*(?:\d+|kd)>\s*$/` seen at line end) → `break`.
3. A pending marker with no prompt → target is `go` (running).

`DebuggerExecutionState` maps these to `ready_for_commands` / `requires_interrupt_before_command`.

### Marker protocol

Every command is sent as `<command>\n.echo COMMAND_COMPLETED_MARKER_<seq>\n`. A 50ms `setInterval` polls the child's stdout via `PeekNamedPipe` (non-blocking) through a streaming `TextDecoder`. The echoed marker line is dropped and flushes all waiting resolvers; output lines before it are captured.

## Key Directories

- `src/` — all source (7 files, no subdirs except `data/`)
- `src/data/` — `catalog.json`, the static WinDbg/KD command catalog (~700 KB)
- No `tests/`, `scripts/`, `.github/`, or lockfile exist.

## Development Commands

There is **no build, test, or lint pipeline** — the published bin entry is raw TypeScript executed by Bun.

```sh
bun run src/index.ts      # run the server (also: bun run start / bun run dev)
bun x windbg-mcp@latest   # install/run from npm as an MCP client
```

- Run/start/dev: `bun run src/index.ts` (`start` and `dev` scripts are identical).
- No `build` script; no `tsc`, bundler, or TypeScript devDependency. `tsconfig.json` `outDir`/`rootDir` are dead config.
- No `test` script and no `lint` script.

## Code Conventions & Common Patterns

- **ESM with explicit `.ts` extensions** in relative imports (Bun-native; plain Node cannot resolve them). Example: `import { McpServer } from "./mcp.ts";`.
- **Zero dependencies**; everything (MCP protocol, JSON-RPC, FFI) is hand-rolled. Do not introduce a dependency casually.
- **Naming**: `snake_case` for JSON-RPC/wire/tool-argument fields (`session_id`, `cdb_path`, `symbols_path`, `kernel_connection`, `dump_path`); `camelCase` for TypeScript identifiers. Tool names are `windbg_`-prefixed verbs.
- **Strict TypeScript** (`strict: true`, `types: ["bun"]`); single quotes; semicolons; private instance fields use a leading underscore (`_ready`, `_atPrompt`, `_expectedMarker`).
- **Error handling**: tool handlers return structured errors (`toolError(...)`, `isError: true`) instead of throwing — exceptions are caught at the JSON-RPC boundary and mapped to `-32603`. Subprocess I/O is wrapped in best-effort `try { } catch { /* process may be gone */ }`. Use `errMsg(err)` to normalize unknown throwables.
- **Async**: promise-chain serialization in `index.ts`; `Promise.withResolvers()` for one-shot waiter/resolver patterns (see `waitForReady`, `waitForConnectedToTarget`); `Bun.sleep()` for delays; `setInterval` polling (50ms) instead of stream events; stale timers are guarded by resolver identity checks.
- **State management**: module-level mutable registry in `mcp.ts` (`sessions`, `sessionCounter`); the `Catalog` singleton (`private static instance` + `load()`); per-session mutable state lives on the `DebuggerSession` instance. No DI framework — factories construct sessions.
- **FFI**: `dlopen("kernel32.dll", { … })` with typed `args`/`returns`; manual struct layouts with hardcoded x64 offsets and `DataView` little-endian get/set. Constants mirror Win32 (e.g. `CREATE_NEW_PROCESS_GROUP = 0x00000200`).

## Important Files

| File | Role |
| --- | --- |
| `package.json` | manifest: `bin` → `./src/index.ts`, `os: ["win32"]`, `engines.bun >=1.1.0`, zero deps |
| `tsconfig.json` | `ESNext`/`moduleResolution: bundler`, `strict`, `types: ["bun"]` |
| `src/index.ts` | entry point; serialized dispatch; shutdown cleanup |
| `src/mcp.ts` | `McpServer`, tool definitions, session registry |
| `src/session.ts` | `DebuggerSession` lifecycle + marker protocol + executable auto-detection |
| `src/spawn_win32.ts` | `kernel32.dll` FFI subprocess spawn |
| `src/catalog.ts` | command catalog singleton + search + URI resolution |
| `src/data/catalog.json` | static command reference data |

## Runtime/Tooling Preferences

- **Runtime**: Bun ≥ 1.1 (required for `bun:ffi`). Node is not supported.
- **Platform**: Windows only (`os: ["win32"]`). Requires Windows Debugging Tools — `cdb.exe`/`kd.exe` auto-detected from Store execution aliases (`%LOCALAPPDATA%\Microsoft\WindowsApps\cdbX64.exe`) or Windows Kits / legacy Debugging Tools paths. A custom `cdb_path`/`kd_path` tool argument overrides detection.
- **Package manager**: Bun (implicit; no `packageManager` field, no lockfile).

## Testing & QA

- **No tests, no test runner, no CI, no lint config.** `package.json` has no `test`/`lint` scripts and empty `dependencies`/`devDependencies`.
- If tests are added, Bun's built-in runner (`bun test`) is the natural fit given the Bun-only runtime; update `tsconfig.json` `include` (currently `["src"]`) to cover test files.

## Gotchas

- `src/mcp.ts` declares `SERVER_VERSION = "0.1.0"` while `package.json` says `0.1.3` — keep them in sync when bumping.
- `src/session.ts` has a dead private field `_hasDebuggee` (never read).
- `cdb` parses options only before the first non-option token; `-y <symbols>` must precede the debuggee path (see `createCdbExecutableSession`).
- Kernel sessions attach in two stages: wait for "Connected to target", then `sendCtrlBreak()` before waiting for the prompt.
