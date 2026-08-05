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
 */

import { Catalog } from "./catalog.ts";
import { renderCompactCommand, renderFullCommand, renderGuide, GUIDE_URI } from "./resources.ts";
import {
  type DebuggerSession,
  createCdbExecutableSession,
  createCdbDumpSession,
  createCdbAttachSession,
  createKdSession,
} from "./session.ts";

const PROTOCOL_VERSION = "2026-07-28";
const SERVER_NAME = "windbg-mcp";
const SERVER_VERSION = "0.1.0";

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
    description: "Launch a process under cdb.exe (cdb <exe> [args...]). Returns a session_id. The debuggee runs as a child of cdb; `windbg_close` terminates it, `windbg_detach` lets it keep running.",
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
    description: "Open a crash dump file (.dmp/.mdmp/.hdmp) with cdb -z for analysis. Returns a session_id. A dump is a static target: commands run directly, there is nothing to break into.",
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
    description: "End debugging by executing `q`. For a session created by windbg_open_executable the debuggee process is terminated together with the debugger.",
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
    description: "Attach cdb.exe to an existing user-mode process by pid (-p) or name (-pn). Returns a session_id. The debugger breaks in at attach; use `windbg_detach` to leave the process running.",
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
    description: "Attach kd.exe to a kernel target with -k. Waits for the target to connect, then breaks in. Returns a session_id. Connection strings: KDNET 'net:port=50000,key=1.2.3.4', named pipe 'com:pipe,port=\\\\.\\pipe\\com_1,baud=115200,reconnect,resets=0', serial 'com:port=COM1,baud=115200'.",
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
    description: "End debugging by executing `qd` (quit and detach). The debuggee process is NOT terminated and keeps running.",
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
    description: "Enumerate all live sessions created by windbg_open_* and windbg_attach_*. Each entry includes the session id, creation time, session type, target, and current state (break, running, busy, ...). Use the state to isolate multiple sessions and to decide whether `windbg_execute_command` can be called.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "windbg_interrupt_target",
    title: "Interrupt the running target",
    description: "Break into the currently running target by sending CTRL+BREAK to the debugger's process group. Use it when the target is running or busy and you need the prompt back. Query `windbg_sessions` afterwards to confirm the state changed to break.",
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
    description: "Execute an arbitrary WinDbg/KD command string on a session. The debugger must be in break state (ready for commands); check `windbg_sessions` first and use `windbg_interrupt_target` if the target is running.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The debugger command string to execute (e.g. kb, lm, !analyze -v)" },
        session_id: { type: "string", description: "Session id (uses the active session if omitted)" },
        timeout: { type: "number", description: "Override the session timeout in seconds" },
      },
      required: ["command"],
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
          result = this.handleLegacyInitialize();
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
      supportedVersions: [PROTOCOL_VERSION],
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
      instructions:
        "This server drives cdb.exe (user mode) and kd.exe (kernel). Open a session with windbg_open_executable, windbg_open_dump, windbg_attach_process, or windbg_attach_kernel; list sessions and their states with windbg_sessions. When a target is running, break in with windbg_interrupt_target before running commands with windbg_execute_command. End sessions with windbg_close (`q`, debuggee terminated) or windbg_detach (`qd`, debuggee keeps running). Read windbg://command/{id} resources for command syntax.",
      ttlMs: 3600000,
      cacheScope: "public",
    };
  }

  private handleLegacyInitialize(): unknown {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        resources: {},
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "This server drives cdb.exe (user mode) and kd.exe (kernel). Open a session with windbg_open_executable, windbg_open_dump, windbg_attach_process, or windbg_attach_kernel; list sessions and their states with windbg_sessions. When a target is running, break in with windbg_interrupt_target before running commands with windbg_execute_command. End sessions with windbg_close (`q`, debuggee terminated) or windbg_detach (`qd`, debuggee keeps running).",
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
    return toolResult({ sessions: list });
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
    return toolResult({
      command: result.command,
      output: result.output,
      state_before: result.state_before,
      state_after: result.state_after,
    });
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
function toolResult(data: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

/** Tool error as text content (isError=true). */
function toolError(message: string): unknown {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
