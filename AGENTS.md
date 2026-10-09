# Repository Guidelines

## General Principles

- **Read before you change.** Before modifying code, read the relevant files and existing implementations in the same module; prefer reuse.
- **Simple, but well designed.** Avoid over-engineering; do not add abstractions or complexity for hypothetical requirements. New dependencies must have clear benefits; prefer capabilities the project already has.
- **Low coupling, high readability.** Keep module responsibilities clear and dependencies simple; use accurate naming and appropriate comments so code is easy to understand and review.
- **Natural comments.** Express intent primarily through naming and structure; comments supplement only the rationale, constraints, and special logic that the code itself cannot express. Write comments as final content; do not repeat the code, describe change history, comparisons, or the implementation process, or leave awkward implementation notes.
- **Implement based on facts.** For external behavior involving APIs, frameworks, libraries, or protocols, rely primarily on official documentation, source code, specifications, or existing tests. When these are insufficient to determine behavior that affects the implementation, do not assume — pause and ask. Existing project code, tests, and explicit conventions are also reliable sources.
- **Confirm the problem exists first.** Before fixing a bug, understand the relevant code, check existing tests, and reproduce the problem when conditions allow, while confirming the expected behavior has a reliable basis. If reproduction is impossible due to environment, timing, or other constraints, base your judgment on code, tests, logs, documentation, or other reliable evidence — never modify on guesswork. If the problem is confirmed not to exist, do not change code for the sake of changing it.
- **Minimal changes.** Modify only what is necessary to solve the current problem; avoid unrelated refactoring and drive-by optimizations. When changing behavior, also review comments, documentation, and examples directly affected by that behavior; update them only when they are outdated or contradict the new behavior.
- **One-directional constraints.** When writing rules (including this file), state each rule once, in its clearest form; do not append a redundant restatement of its inverse.

## Project Overview

`windbg-mcp` is a Windows-only TypeScript MCP server supporting **Node.js and Bun** on x64 and ARM64. It drives `cdb.exe` (user mode) and `kd.exe` (kernel mode) as Win32 subprocesses and exposes crash-dump analysis, live process debugging, and kernel debugging to LLM agents over the Model Context Protocol.

MCP is implemented through the official **`@modelcontextprotocol/server` v2 SDK**. Its `serveStdio` entry serves modern `2026-07-28` and legacy `initialize` clients. The SDK owns transport framing, protocol negotiation, request validation, response encoding, and protocol errors; Zod schemas define tool inputs and outputs.

## Architecture & Data Flow

```
stdin (JSON-RPC lines)
  → src/index.ts          SDK serveStdio + debugger shutdown lifecycle
  → src/mcp.ts            createMcpServer → SDK tool/resource registrations
  → src/session.ts        DebuggerSession + per-session command queue + factories
  → src/spawn_win32.ts    kernel32.dll FFI (CreateProcessW)
  → src/ffi.ts            Node (koffi) or Bun (bun:ffi) backend
  → cdb.exe / kd.exe      child process, piped stdio
  → marker protocol       `.printf` with a private per-session completion marker
  → src/command_output.ts UTF-8 temporary storage + bounded output pages
  → SDK stdio transport   JSON-RPC response lines
```

- **`src/index.ts`** — entry point (`#!/usr/bin/env node`). Hosts `serveStdio` with a transport whose public `close()` lifecycle triggers debugger cleanup. EOF cancels outstanding protocol requests without responses. Cleanup has a 1.5-second forced-termination deadline and synchronous process-exit fallback; discovery-probe instance disposal is not a wire disconnect.
- **`src/mcp.ts`** — `createMcpServer`, explicit session IDs, an eight-session active/opening budget, and all 10 SDK tool registrations with Zod schemas and annotations. Prunes exited debuggers and registers the guide and command resource template.
- **`src/session.ts`** — one cdb/kd process per session. Owns command serialization, streaming marker parsing, readiness inference, output-page collection and lifecycle. Collections pin the command they captured; fresh cursors for replaced commands fail rather than reading a successor's output.
- **`src/spawn_win32.ts`** — native process creation and handle ownership. Parent stdin is an overlapped named-pipe write handle; writes return ordered promises while stdout is drained independently. Cancellation is reaped before native I/O storage and handles are released.
- **`src/ffi.ts`**, **`src/ffi_node.ts`**, **`src/ffi_bun.ts`** — shared FFI contract, 64-bit structure layouts, and explicitly owned nonmoving write buffers (Koffi allocation on Node, process heap on Bun).
- **`src/console_control.ts`** — short-lived helper that attaches to a debugger console to send CTRL+BREAK without changing the MCP host's console attachment or signal handlers.
- **`src/catalog.ts`** — `Catalog` singleton loading `src/data/catalog.json`; search scoring, `windbg://command/...` URI resolution, and catalog counts.
- **`src/resources.ts`** — guide workflow and command-card rendering, preserving source documentation without execution classification or command-to-tool routing.
- **`src/command_policy.ts`** — physical input constraints only: ASCII text, control-byte rejection, command/line budgets and blank-line normalization. Command semantics are delegated to CDB/KD.
- **`src/command_output.ts`** — lazy temporary-file output, asynchronous ordered I/O, UTF-8 byte pagination and explicit storage quotas. Normal cleanup removes only owned files; emergency cleanup defers outstanding callbacks to avoid descriptor-reuse races.

### Session state model

`DebuggerSession` reports a current `state` string describing debugger-process liveness and command-channel readiness; it does not query or emulate DbgEng execution status. Readiness uses reader errors, lifecycle flags, pending markers and prompt observations.

1. An exited debugger process reports `exited`; an ending operation reports `closing`.
2. A live session with a confirmed prompt, no pending marker, no reader error and no ending operation reports `ready`.
3. A pending command reports `busy`; unconfirmed readiness or reader errors report `unavailable`, with I/O failure details in `error`.
4. Session type and target describe the initial opening operation. Commands can change targets, so initial dump/live metadata is not used to infer target execution state or reject lifecycle operations.
5. Command results expose current `state`, not before/after snapshots. A collection pins its captured command's output while reporting current channel state, which may reflect a successor command.

### Marker protocol

Startup clears debugger aliases and disables prompt output with `.outmask- /l 0x10`. Commands use RS-prefixed UUID/sequence `.printf` markers. A non-overlapping 50ms reader drains bounded stdout chunks and asynchronously captures text; matching markers complete commands after prior output is stored. Partial private markers are withheld, but other unterminated text is captured. Wait expiry does not cancel execution. Omitting `command` collects output, with `command_id` and byte offsets used for subsequent pages.

### Resource limits and lifecycle

- Session operations require `session_id`; the process admits at most eight open/opening sessions.
- Redirected debugger command text is ASCII-only, up to 65536 characters per request and 4094 per physical line. Normalize line endings and ignore blank lines; an empty CDB console line repeats its previous command. Unicode paths use the existing wide-character tool parameters.
- Output pages default to 64 KiB, can be 4–256 KiB, and each command has a 256 MiB temporary-storage quota. `output_error` is an explicit capture failure, not successful truncation.
- Native commands, scripts, aliases and callbacks are not semantically filtered. Completion requires observing the private marker; output/input changes can leave it unconfirmed. An observed debugger exit returns `state: "exited"` and captured output, with `completed: false` when no marker was observed; it does not imply command success. I/O and output storage failures remain tool errors. Exit removes the session and output storage, so its final response is the last available page. Explicit close requests q and force-terminates if necessary; detach waits for qd without force-killing on failure.
- Kernel `qd` support is retained based on verified project behavior; preserve that compatibility note separately from the upstream reference.
- Input views passed to native `writeStdin` must remain unchanged until the promise settles. An idle write is submitted before a following interrupt can overtake it.
- Normal command replacement/session closure removes output files. Forced exit during pending filesystem callbacks can leave temporary output directories; do not claim hard-exit cleanup is guaranteed.


## Key Directories

- `src/` — TypeScript implementation, including both FFI backends.
- `src/data/` — static standard-command, meta-command, and extension-command catalog.
- `scripts/` — build asset copying and extension-reference import.
- `tests/` — JavaScript tests using Node's built-in test runner against compiled modules.
- `dist/` — generated JavaScript and catalog assets; the published executable is `dist/index.js`.

## Development Commands

```sh
npm ci                  # install dependencies from package-lock.json
npm run build           # tsc, then copy catalog assets into dist/data
npm start               # run dist/index.js with Node
bun dist/index.js       # run the same build with Bun
npm test                # node --test tests/*.test.mjs; build first
```

- `npm run dev` builds and then starts the server with Node; `prepack` also runs the build.
- `npx -y windbg-mcp@latest` runs the published package with Node. Use `bun x --bun windbg-mcp@latest` to select the Bun runtime rather than follow the Node shebang.
- No lint script is currently defined.
- `.github/workflows/publish.yml` runs on Ubuntu when a `v*` tag is pushed and publishes the committed `package.json` version to npm `latest`, without running tests. Its `npm ci --force` bypasses the Windows-only runtime restriction for the build-only dependency installation.
- Publishing uses npm Trusted Publishing for `kanren3/windbg-mcp`, workflow `publish.yml`, with no GitHub environment and direct `npm publish` enabled; no npm token secret is required.

## Code Conventions & Common Patterns

- **ESM with explicit `.js` extensions** in TypeScript relative imports for NodeNext compilation. Example: `import { createMcpServer } from "./mcp.js";`.
- **Runtime-neutral shared code**: use APIs available under both Node and Bun; keep runtime-specific FFI behind `Kernel32Ffi` in the corresponding backend module.
- **Naming**: `snake_case` for JSON-RPC/wire/tool-argument fields (`session_id`, `cdb_path`, `symbols_path`, `kernel_connection`, `dump_path`); `camelCase` for TypeScript identifiers. Tool names are `windbg_`-prefixed verbs.
- **Strict TypeScript** (`strict: true`, `types: ["node", "bun"]`, `module`/`moduleResolution: "NodeNext"`). Use semicolons and follow the surrounding quote style; existing session-state fields use a leading underscore.
- **MCP errors and schemas**: let the SDK validate registered Zod schemas and convert tool-handler exceptions to `isError: true` results. Resource callbacks use SDK errors such as `ResourceNotFoundError`. Do not duplicate JSON-RPC parsing, version negotiation, validation dispatch, or wire-result formatting.
- **Async**: SDK dispatch, per-session command queues, overlapped stdin, independently drained stdout and asynchronous output storage. Prefer `Promise.withResolvers()` for callback adapters. Interrupts remain outside the command queue; protocol cancellation alone does not interrupt a debugger command.
- **State management**: module-level session registry and opening-session tracking in `mcp.ts`, a `Catalog` singleton, and per-session mutable state on `DebuggerSession`. Factories construct sessions directly; there is no DI framework.
- **FFI**: Node uses `koffi`; Bun uses `dlopen` from `bun:ffi`. Both implement the same `kernel32.dll` contract, with 64-bit handles, 4-byte Win32 BOOL values, and manually encoded x64/ARM64 structure layouts. Constants mirror Win32.

## Important Files

| File | Role |
| --- | --- |
| `package.json` | `dist/index.js` bin; Windows x64/ARM64; Node >=22; SDK v2, Zod and Koffi runtime dependencies; official SDK client for tests |
| `tsconfig.json` | strict NodeNext compilation from `src` to `dist`; Node and Bun types |
| `src/index.ts` | SDK stdio hosting and debugger shutdown cleanup |
| `src/mcp.ts` | `createMcpServer`, Zod tool schemas, resource registrations, session registry |
| `src/session.ts` | `DebuggerSession` lifecycle + marker protocol + executable auto-detection |
| `src/spawn_win32.ts` | `kernel32.dll` FFI subprocess spawn |
| `src/ffi.ts`, `src/ffi_node.ts`, `src/ffi_bun.ts` | shared native API contract and Node/Bun backends |
| `src/command_policy.ts` | redirected input normalization and physical command-text limits |
| `src/command_output.ts` | file-backed UTF-8 output pages and storage lifecycle |
| `src/console_control.ts` | isolated console-control helper |
| `src/catalog.ts` | command catalog singleton + search + URI resolution |
| `src/data/catalog.json` | static command reference data |

## Runtime/Tooling Preferences

- **Runtime**: Node.js >=22 uses `koffi`; Bun uses its native `bun:ffi` backend. `src/ffi.ts` selects the backend at runtime.
- **Platform**: Windows x64 or ARM64. Requires Windows Debugging Tools; discovery probes Store execution aliases, Windows Kits, and legacy Debugging Tools paths. Tools accept explicit `cdb_path`/`kd_path` arguments.
- **Dependency management**: `package-lock.json` is present; `npm ci` provides reproducible installs. There is no `packageManager` field.

## Testing & QA

- Build before running `npm test`: the `.mjs` tests import `dist` modules and use `node:test`. They are not part of the TypeScript `src` compilation.
- Coverage includes SDK interoperability, explicit-session safety, opening capacity, large paginated output, native backpressure/cancellation, UTF-8 file pages, input framing, reference fidelity/links, native target termination, direct debugger exit, forced close after lost markers, argv preservation and real debugger sessions. Native checks require Windows; session tests auto-detect Debugging Tools.
- Set `WINDBG_MCP_TEST_CDB_PATH` to enable stdio debugger scenarios. Set `WINDBG_MCP_TEST_RUNTIME` to a Bun executable to run protocol and stdio scenarios through the Bun backend.

## Gotchas

- Keep `SERVER_VERSION` in `src/mcp.ts` synchronized with `package.json` when changing the package version.
- `cdb` parses options only before the first non-option token; `-y <symbols>` must precede the debuggee path (see `createCdbExecutableSession`).
- Kernel startup first waits for a connection indication or prompt, then sends CTRL+BREAK if needed before establishing marker-confirmed readiness.
