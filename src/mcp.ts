/**
 * MCP server — JSON-RPC 2.0 dispatch over stdio.
 *
 * Implements the MCP 2026-07-28 protocol:
 * - `server/discover` (mandatory)
 * - `tools/list`, `tools/call`
 * - `resources/list`, `resources/templates/list`, `resources/read`
 * - Dual-era: also answers legacy `initialize` for backward compatibility.
 *
 * Tools (per user spec):
 * - windbg_open_executable  — cdb <exe> [args...], debuggee is a cdb child
 * - windbg_open_dump        — cdb -z <dump>
 * - windbg_close            — `q`: end debugging, debuggee terminated with it
 * - windbg_attach_process   — cdb -p <pid> | -pn <name>
 * - windbg_attach_kernel    — kd -k <connection>
 * - windbg_detach           — `qd`: end debugging, debuggee keeps running
 * - windbg_sessions         — enumerate sessions with type/target/state
 * - windbg_interrupt_target — CTRL+BREAK into the running target
 * - windbg_execute_command  — run any debugger command
 * - windbg_search_commands  — search the command catalog by keyword
 */

import { Catalog, entrySyntaxBlock } from "./catalog.ts";
import { renderCompactCommand, renderFullCommand, renderGuide, GUIDE_URI } from "./resources.ts";
import {
  type DebuggerSession,
  createCdbExecutableSession,
  createCdbDumpSession,
  createCdbAttachSession,
  createKdSession,
} from "./session.ts";

/** Discover-era protocol revision (server/discover). */
const PROTOCOL_VERSION = "2026-07-28";
/**
 * Newest revision mainstream SDKs support (@modelcontextprotocol/sdk
 * SUPPORTED_PROTOCOL_VERSIONS). Used as the initialize fallback so that
 * clients which predate the discover era can connect.
 */
const LATEST_OFFICIAL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  PROTOCOL_VERSION,
  LATEST_OFFICIAL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const SERVER_NAME = "windbg-mcp";
const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = `WinDbg MCP server: drives cdb.exe (user mode) and kd.exe (kernel).

## Choose a tool by task
- Analyze a crash dump (.dmp/.mdmp) → windbg_open_dump, then windbg_execute_command with "!analyze -v"
- Debug a running process → windbg_attach_process (by pid or name)
- Start a new process under the debugger → windbg_open_executable
- Debug a kernel target (VM, test machine) → windbg_attach_kernel with a connection string
- Check debugger state → windbg_sessions (look for ready_for_commands=true)
- Target is running, need prompt → windbg_interrupt_target, then re-check windbg_sessions
- Run any debugger command → windbg_execute_command
- Unsure of the exact command → windbg_search_commands with a keyword
- End session, kill debuggee → windbg_close
- End session, keep debuggee running → windbg_detach

## After opening a session
1. Set symbols: windbg_execute_command with ".symfix" then ".reload"
2. For dumps: windbg_execute_command with "!analyze -v" first
3. For live targets: windbg_execute_command with "kb" for stack trace

## Resources
- windbg://guide/overview — full workflow guide
- windbg://command/{id} — per-command syntax card`;

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface SessionRecord {
  id: string;
  type: "executable" | "dump" | "process" | "kernel";
  session: DebuggerSession;
}

let sessionCounter = 0;
const sessions = new Map<string, SessionRecord>();

/** Close every open session (kills kd/cdb children). Used on server exit. */
export async function closeAllSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(all.map((rec) => rec.session.close()));
}

/** Synchronously kill every session's debugger child. Used from "exit" handler. */
export function killAllSessionsSync(): void {
  const all = [...sessions.values()];
  sessions.clear();
  for (const rec of all) rec.session.killSync();
}

function genSessionId(): string {
  sessionCounter++;
  return sessionCounter.toString(16).padStart(8, "0");
}

function getSessionById(id: string): SessionRecord | null {
  return sessions.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "windbg_open_executable",
    title: "Start and debug an executable",
    description: "Launch a process under cdb.exe. Returns a session_id. The debuggee runs as a child of cdb; windbg_close terminates it, windbg_detach lets it keep running.\nAfter opening: set symbols with \".symfix\" + \".reload\", then run \"g\" to start execution or \"bp <symbol>\" to set breakpoints first.",
    inputSchema: {
      type: "object",
      properties: {
        executable: { type: "string", description: "Path to the executable to debug" },
        args: { type: "array", items: { type: "string" }, description: "Optional command-line arguments for the debuggee" },
        cdb_path: { type: "string", description: "Custom cdb.exe path (auto-detected if omitted)" },
        symbols_path: { type: "string", description: "Symbol search path (-y)" },
        timeout: { type: "number", description: "Seconds to wait for the debugger to become ready (default 60)" },
      },
      required: ["executable"],
    },
  },
  {
    name: "windbg_open_dump",
    title: "Open a crash dump",
    description: "Open a crash dump file (.dmp/.mdmp/.hdmp) for analysis. Returns a session_id. A dump is static: commands run immediately, no break-in needed.\nAfter opening: set symbols with \".symfix\" + \".reload\", then run \"!analyze -v\" for automated crash analysis.",
    inputSchema: {
      type: "object",
      properties: {
        dump_path: { type: "string", description: "Path to the crash dump file" },
        cdb_path: { type: "string", description: "Custom cdb.exe path" },
        symbols_path: { type: "string", description: "Symbol search path (-y)" },
        timeout: { type: "number", description: "Seconds to wait for the debugger to become ready (default 60)" },
      },
      required: ["dump_path"],
    },
  },
  {
    name: "windbg_close",
    title: "Close a debug session",
    description: "End debugging by executing `q`. For a session created by windbg_open_executable the debuggee is terminated with it. For kernel sessions, sends `g` to resume the target before quitting.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id to close (closes the active session if omitted)" },
      },
    },
  },
  {
    name: "windbg_attach_process",
    title: "Attach to a running process",
    description: "Attach cdb.exe to a running user-mode process by pid or name. Returns a session_id. The debugger breaks in at attach.\nAfter attaching: set symbols with \".symfix\" + \".reload\", then use \"kb\" for stack trace or \"dv\" for local variables. Use windbg_detach to leave the process running.",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Decimal process ID to attach to (-p)" },
        name: { type: "string", description: "Process name to attach to (-pn), e.g. notepad.exe" },
        cdb_path: { type: "string", description: "Custom cdb.exe path" },
        symbols_path: { type: "string", description: "Symbol search path (-y)" },
        timeout: { type: "number", description: "Seconds to wait for attach (default 60)" },
      },
      oneOf: [
        { required: ["pid"] },
        { required: ["name"] },
      ],
    },
  },
  {
    name: "windbg_attach_kernel",
    title: "Attach to a kernel target",
    description: "Attach kd.exe to a kernel target. Returns a session_id. The target must be booted with debugging enabled.\nConnection strings: KDNET 'net:port=50000,key=1.2.3.4', named pipe 'com:pipe,port=\\\\.\\pipe\\com_1,baud=115200,reconnect,resets=0', serial 'com:port=COM1,baud=115200'.\nAfter connecting: set symbols with \".symfix\" + \".reload\", then use \"kb\" for stack trace or \"!process 0 0\" to list processes.",
    inputSchema: {
      type: "object",
      properties: {
        kernel_connection: { type: "string", description: "Kernel connection string (-k)" },
        kd_path: { type: "string", description: "Custom kd.exe path" },
        symbols_path: { type: "string", description: "Symbol search path (-y)" },
        timeout: { type: "number", description: "Seconds to wait for the target to connect (default 60)" },
      },
      required: ["kernel_connection"],
    },
  },
  {
    name: "windbg_detach",
    title: "Detach from a debug session",
    description: "End debugging by executing `qd` (quit and detach). The debuggee process is NOT terminated and keeps running. Use this after attaching to a production process you must not kill.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id to detach (detaches the active session if omitted)" },
      },
    },
  },
  {
    name: "windbg_sessions",
    title: "List active debug sessions",
    description: "List all active debug sessions. Each entry includes session_id, type (executable/dump/process/kernel), kind (cdb/kd), target, and state. Check state.ready_for_commands before calling windbg_execute_command — if false, call windbg_interrupt_target first.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              session_id: { type: "string", description: "Unique session identifier" },
              created_at: { type: "string", description: "ISO 8601 creation timestamp" },
              type: { type: "string", description: "Session type (executable, dump, process, kernel)" },
              kind: { type: "string", description: "Debugger kind (cdb or kd)" },
              target: { type: "string", description: "Target description (path, pid, or connection string)" },
              state: {
                type: "object",
                properties: {
                  status_name: { type: "string" },
                  ready_for_commands: { type: "boolean", description: "True if the debugger accepts commands" },
                  running: { type: "boolean" },
                  busy: { type: "boolean" },
                },
              },
            },
            required: ["session_id", "type", "target", "state"],
          },
        },
      },
      required: ["sessions"],
    },
  },
  {
    name: "windbg_interrupt_target",
    title: "Interrupt the running target",
    description: "Break into a running target (like pressing Ctrl+C in the debugger console). Use when the target is running and you need to enter commands. After interrupting, call windbg_sessions to confirm state changed to break.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id to interrupt (interrupts the active session if omitted)" },
      },
    },
  },
  {
    name: "windbg_execute_command",
    title: "Execute a debugger command",
    description: "Execute any WinDbg/KD command string. The debugger must be at a prompt (break state) — check windbg_sessions first.\nCommon commands: \"kb\" (stack trace), \"lm\" (loaded modules), \"dt <type>\" (display type), \"dv\" (local variables), \"r\" (registers), \"u <addr>\" (disassemble), \"d <addr>\" (display memory), \"bp <symbol>\" (set breakpoint), \"g\" (continue), \"!analyze -v\" (crash analysis), \".symfix\" + \".reload\" (set symbols).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The debugger command string to execute (e.g. kb, lm, !analyze -v)" },
        session_id: { type: "string", description: "Session id (uses the active session if omitted)" },
        timeout: { type: "number", description: "Override the session timeout in seconds" },
      },
      required: ["command"],
    },
    outputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        output: { type: "string", description: "Raw debugger output text" },
        state_before: { type: "object" },
        state_after: { type: "object" },
      },
      required: ["command", "output"],
    },
  },
  {
    name: "windbg_search_commands",
    title: "Search WinDbg command reference",
    description: "Search the WinDbg/KD command catalog by keyword. Returns matching commands with syntax, summary, and a resource URI for full documentation. Use when unsure of the exact command name or syntax.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g. 'breakpoint', 'stack trace', 'dt', '.sympath')" },
        limit: { type: "number", description: "Max results to return (default 10)" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              tokens: { type: "array", items: { type: "string" } },
              summary: { type: "string" },
              syntax: { type: ["string", "null"], description: "Command syntax (may be null)" },
              resource: { type: "string", description: "URI for full documentation" },
            },
            required: ["id", "title", "tokens", "summary"],
          },
        },
      },
      required: ["results"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

export class McpServer {
  private catalog: Catalog;

  constructor() {
    this.catalog = Catalog.load();
  }

  /** Process a single JSON-RPC request and return the result (or error). */
  async handle(request: unknown): Promise<unknown> {
    if (typeof request !== "object" || request === null) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const { id, method, params } = request as { id?: unknown; method?: unknown; params?: unknown };
    const isNotification = id === undefined || id === null;

    if (typeof method !== "string") {
      if (isNotification) return null;
      return jsonRpcError(id, -32600, "Invalid Request: missing method");
    }

    try {
      let result: unknown;

      switch (method) {
        case "server/discover":
          result = this.handleDiscover();
          break;
        case "initialize":
          result = this.handleLegacyInitialize(params);
          break;
        case "tools/list":
          result = this.handleToolsList();
          break;
        case "tools/call":
          result = await this.handleToolsCall(params);
          break;
        case "resources/list":
          result = this.handleResourcesList();
          break;
        case "resources/templates/list":
          result = this.handleResourceTemplatesList();
          break;
        case "resources/read":
          result = this.handleResourcesRead(params);
          break;
        case "ping":
          result = { resultType: "complete" };
          break;
        default:
          if (isNotification) return null;
          return jsonRpcError(id, -32601, `Method not found: ${method}`);
      }

      if (isNotification) return null;
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (isNotification) return null;
      const message = err instanceof Error ? err.message : String(err);
      return jsonRpcError(id, -32603, message);
    }
  }

  // -- Discovery -----------------------------------------------------------

  private handleDiscover(): unknown {
    return {
      resultType: "complete",
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: {
        tools: { listChanged: true },
        resources: {},
      },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      },
      instructions: SERVER_INSTRUCTIONS,
      ttlMs: 3600000,
      cacheScope: "public",
    };
  }

  private handleLegacyInitialize(params: unknown): unknown {
    // Version negotiation: echo the client's requested version when we
    // support it (spec: server MUST respond with the same version); fall
    // back to the newest version mainstream SDKs recognize otherwise.
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const negotiated = typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_OFFICIAL_VERSION;
    return {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: true },
        resources: {},
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: SERVER_INSTRUCTIONS,
    };
  }

  // -- Tools --------------------------------------------------------------

  private handleToolsList(): unknown {
    return {
      tools: TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        ...("outputSchema" in t ? { outputSchema: t.outputSchema } : {}),
      })),
    };
  }

  private async handleToolsCall(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof p.name === "string" ? p.name : "";
    const args = (typeof p.arguments === "object" && p.arguments !== null
      ? p.arguments
      : {}) as Record<string, unknown>;

    switch (name) {
      case "windbg_open_executable":
        return await this.toolOpenExecutable(args);
      case "windbg_open_dump":
        return await this.toolOpenDump(args);
      case "windbg_close":
        return await this.toolClose(args);
      case "windbg_attach_process":
        return await this.toolAttachProcess(args);
      case "windbg_attach_kernel":
        return await this.toolAttachKernel(args);
      case "windbg_detach":
        return await this.toolDetach(args);
      case "windbg_sessions":
        return await this.toolSessions(args);
      case "windbg_interrupt_target":
        return await this.toolInterruptTarget(args);
      case "windbg_execute_command":
        return await this.toolExecuteCommand(args);
      case "windbg_search_commands":
        return this.toolSearchCommands(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async toolOpenExecutable(args: Record<string, unknown>): Promise<unknown> {
    const executable = args.executable;
    if (typeof executable !== "string" || !executable) {
      return toolError("Missing required argument: executable");
    }
    const execArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
    try {
      const session = createCdbExecutableSession(executable, execArgs, {
        cdbPath: strOrUndefined(args.cdb_path),
        symbolsPath: strOrUndefined(args.symbols_path),
        timeout: numOrUndefined(args.timeout),
      });
      await session.start();
      const id = genSessionId();
      sessions.set(id, { id, type: "executable", session });
      return toolResult({
        session_id: id,
        kind: "cdb",
        type: "executable",
        target: executable,
        state: await session.queryState(),
      });
    } catch (e) {
      return toolError(`Failed to start debug session: ${errMsg(e)}`);
    }
  }

  private async toolOpenDump(args: Record<string, unknown>): Promise<unknown> {
    const dumpPath = args.dump_path;
    if (typeof dumpPath !== "string" || !dumpPath) {
      return toolError("Missing required argument: dump_path");
    }
    try {
      const session = createCdbDumpSession(dumpPath, {
        cdbPath: strOrUndefined(args.cdb_path),
        symbolsPath: strOrUndefined(args.symbols_path),
        timeout: numOrUndefined(args.timeout),
      });
      await session.start();
      const id = genSessionId();
      sessions.set(id, { id, type: "dump", session });
      return toolResult({
        session_id: id,
        kind: "cdb",
        type: "dump",
        target: dumpPath,
        state: await session.queryState(),
      });
    } catch (e) {
      return toolError(`Failed to open dump: ${errMsg(e)}`);
    }
  }

  private async toolClose(args: Record<string, unknown>): Promise<unknown> {
    const rec = resolveSession(args.session_id);
    if (!rec) return toolError("No matching debug session. Use windbg_sessions to list open sessions.");
    await rec.session.close();
    sessions.delete(rec.id);
    return toolResult({ closed: rec.id, type: rec.type, target: rec.session.target });
  }

  private async toolAttachProcess(args: Record<string, unknown>): Promise<unknown> {
    const pid = typeof args.pid === "number" ? String(args.pid) : undefined;
    const name = typeof args.name === "string" && args.name ? args.name : undefined;
    if (!pid && !name) {
      return toolError("Provide either pid or name to attach to a process");
    }
    const attachSpec = pid ?? name!;
    try {
      const session = createCdbAttachSession(attachSpec, {
        cdbPath: strOrUndefined(args.cdb_path),
        symbolsPath: strOrUndefined(args.symbols_path),
        timeout: numOrUndefined(args.timeout),
      });
      await session.start();
      const id = genSessionId();
      sessions.set(id, { id, type: "process", session });
      return toolResult({
        session_id: id,
        kind: "cdb",
        type: "process",
        target: session.target,
        state: await session.queryState(),
      });
    } catch (e) {
      return toolError(`Failed to attach to process: ${errMsg(e)}`);
    }
  }

  private async toolAttachKernel(args: Record<string, unknown>): Promise<unknown> {
    const kernel = args.kernel_connection;
    if (typeof kernel !== "string" || !kernel) {
      return toolError("Missing required argument: kernel_connection");
    }
    try {
      const session = createKdSession(kernel, {
        kdPath: strOrUndefined(args.kd_path),
        symbolsPath: strOrUndefined(args.symbols_path),
        timeout: numOrUndefined(args.timeout),
      });
      await session.start();
      const id = genSessionId();
      sessions.set(id, { id, type: "kernel", session });
      return toolResult({
        session_id: id,
        kind: "kd",
        type: "kernel",
        target: kernel,
        state: await session.queryState(),
      });
    } catch (e) {
      return toolError(`Failed to connect to kernel target: ${errMsg(e)}`);
    }
  }

  private async toolDetach(args: Record<string, unknown>): Promise<unknown> {
    const rec = resolveSession(args.session_id);
    if (!rec) return toolError("No matching debug session. Use windbg_sessions to list open sessions.");
    await rec.session.detach();
    sessions.delete(rec.id);
    return toolResult({ detached: rec.id, type: rec.type, target: rec.session.target });
  }

  private async toolSessions(args: Record<string, unknown>): Promise<unknown> {
    void args;
    const list: unknown[] = [];
    for (const rec of sessions.values()) {
      const state = await rec.session.queryState();
      list.push({
        session_id: rec.id,
        created_at: new Date(rec.session.createdAt).toISOString(),
        type: rec.type,
        kind: rec.session.kind,
        target: rec.session.target,
        state,
      });
    }
    return toolResult({ sessions: list }, { sessions: list });
  }

  private async toolInterruptTarget(args: Record<string, unknown>): Promise<unknown> {
    const rec = resolveSession(args.session_id);
    if (!rec) return toolError("No matching debug session. Use windbg_sessions to list open sessions.");
    const state = await rec.session.interrupt();
    return toolResult({ session_id: rec.id, state });
  }

  private async toolExecuteCommand(args: Record<string, unknown>): Promise<unknown> {
    const command = args.command;
    if (typeof command !== "string" || !command) {
      return toolError("Missing required argument: command");
    }
    const rec = resolveSession(args.session_id);
    if (!rec) return toolError("No matching debug session. Use windbg_sessions to list open sessions.");

    const timeout = numOrUndefined(args.timeout);
    const result = await rec.session.execute(command, timeout);
    const payload = {
      command: result.command,
      output: result.output,
      state_before: result.state_before,
      state_after: result.state_after,
    };
    return toolResult(payload, payload);
  }

  private toolSearchCommands(args: Record<string, unknown>): unknown {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return toolError("Missing required argument: query");
    const limit = numOrUndefined(args.limit) ?? 10;
    if (limit < 1) return toolError("Invalid argument: limit must be >= 1");
    const results = this.catalog.search(query, limit).map((entry) => ({
      id: entry.id,
      title: entry.title,
      tokens: entry.tokens,
      summary: entry.summary,
      syntax: entrySyntaxBlock(entry),
      resource: `windbg://command/${entry.id}`,
    }));
    return toolResult({ results }, { results });
  }

  // -- Resources ----------------------------------------------------------

  private handleResourcesList(): unknown {
    const guide = renderGuide(this.catalog);
    return {
      resources: [
        {
          uri: GUIDE_URI,
          name: "windbg guide",
          title: "WinDbg MCP guide",
          description: "Workflow for mapping debugger requests to tools and command resources",
          mimeType: "text/plain",
          size: guide.length,
        },
      ],
    };
  }

  private handleResourceTemplatesList(): unknown {
    return {
      resourceTemplates: [
        {
          uriTemplate: "windbg://command/{id}",
          name: "windbg compact command card",
          title: "WinDbg compact command card",
          description: "Compact syntax-first WinDbg command card by extracted catalog id",
          mimeType: "text/plain",
        },
        {
          uriTemplate: "windbg://command-full/{id}",
          name: "windbg full command page",
          title: "WinDbg full command page",
          description: "Full extracted debugger command topic by extracted catalog id",
          mimeType: "text/plain",
        },
      ],
    };
  }

  private handleResourcesRead(params: unknown): unknown {
    const p = (params ?? {}) as { uri?: unknown };
    const uri = typeof p.uri === "string" ? p.uri : "";
    if (!uri) {
      throw new Error("Missing uri parameter");
    }

    if (uri === GUIDE_URI) {
      return {
        contents: [{ uri, mimeType: "text/plain", text: renderGuide(this.catalog) }],
      };
    }

    const resolved = this.catalog.resolveResourceUri(uri);
    if (!resolved) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    const content = resolved.kind === "compact"
      ? renderCompactCommand(resolved.entry)
      : renderFullCommand(resolved.entry);

    return {
      contents: [{ uri, mimeType: "text/plain", text: content }],
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSession(sessionId: unknown): SessionRecord | null {
  if (typeof sessionId === "string" && sessionId) {
    return getSessionById(sessionId);
  }
  // No session_id → the most recently opened session.
  let last: SessionRecord | null = null;
  for (const rec of sessions.values()) last = rec;
  return last;
}

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonRpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Tool result as structured text content (isError=false). */
function toolResult(data: unknown, structured?: unknown): unknown {
  const result: Record<string, unknown> = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
  if (structured !== undefined) {
    result.structuredContent = structured;
  }
  return result;
}

/** Tool error as text content (isError=true). */
function toolError(message: string): unknown {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
