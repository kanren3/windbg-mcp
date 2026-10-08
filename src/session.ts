/**
 * One cdb/kd process per session. Command writes are serialized, while
 * CTRL+BREAK remains available during a pending command. Completion markers
 * delimit output; they do not reveal whether a live target is running.
 */

import { randomUUID } from "node:crypto";
import { spawnWin32, type Win32Process } from "./spawn_win32.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_BASE = "COMMAND_COMPLETED_MARKER";
const PROMPT_RE = /^\d+:\s*(?:\d+(?::\w+)?|kd)>\s*$/;
const DEBUG_STATUS_BREAK = 6;
const DEBUG_STATUS_NO_DEBUGGEE = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebuggerExecutionState {
  raw_status: number | null;
  status_name: string;
  running: boolean | null;
  busy: boolean;
  ready_for_commands: boolean;
  requires_interrupt_before_command: boolean;
  summary: string;
}

export interface CommandExecutionResult {
  command: string;
  output: string;
  completed: boolean;
  state_before: DebuggerExecutionState;
  state_after: DebuggerExecutionState;
}

interface PendingCommand {
  command: string;
  stateBefore: DebuggerExecutionState;
  output: string[];
  completed: boolean;
  stateAfter: DebuggerExecutionState | null;
}

export type SessionKind = "cdb" | "kd";

export interface SessionOptions {
  /** Path to cdb.exe or kd.exe */
  debuggerPath: string;
  /** Full launch args (including the debugger path at [0]) */
  launchArgs: string[];
  /** Seconds to wait for the debugger to become ready (default 60) */
  timeout: number;
  /** Distinguishes a live target from a static dump; both permit command cancellation. */
  isLiveSession: boolean;
  /** Human-readable target description (executable, dump path, pid, kernel string) */
  target: string;
}

// ---------------------------------------------------------------------------
// DebuggerSession
// ---------------------------------------------------------------------------

export class DebuggerSession {
  kind: SessionKind;
  target: string;
  createdAt: number;
  private process: Win32Process;
  private isLiveSession: boolean;
  private timeout: number;

  private outputBuffer: string[] = [];
  private _markerPrefix = `${MARKER_BASE}_${randomUUID()}`;
  private _markerSeq = 0;
  private _expectedMarker: string | null = null;
  private _readyResolvers: ((value: boolean) => void)[] = [];
  private _atPrompt = false;
  private _stdoutBuffer = "";
  private _connectedToTarget = false;
  private _connectedToTargetResolvers: ((value: boolean) => void)[] = [];
  private _readTimer: NodeJS.Timeout | undefined;
  private _readError: Error | null = null;
  private _queue: Promise<void> | null = null;
  private _ending = false;
  private _interruptPromise: Promise<DebuggerExecutionState> | null = null;
  private _interruptCommand: PendingCommand | null = null;
  private _lastCommand: PendingCommand | null = null;

  constructor(kind: SessionKind, opts: SessionOptions) {
    if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new Error("timeout must be a positive finite number");
    }
    this.kind = kind;
    this.isLiveSession = opts.isLiveSession;
    this.timeout = opts.timeout;
    this.target = opts.target;
    this.createdAt = Date.now();

    const cmdLine = opts.launchArgs
      .map((a) => {
        if (!a.includes(" ") && !a.includes('"') && a.length > 0) return a;
        // Windows argument quoting doubles backslashes before quotes and the closing quote.
        const escaped = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
        return `"${escaped}"`;
      })
      .join(" ");
    this.process = spawnWin32(cmdLine);

    const decoder = new TextDecoder("utf-8");
    this._readTimer = setInterval(() => {
      try {
        // Drain bursts without monopolizing the event loop on an unbounded output stream.
        let drained = false;
        for (let bytes = 0; bytes < 1024 * 1024;) {
          const chunk = this.process.readStdout(64 * 1024);
          if (chunk.length === 0) {
            drained = true;
            break;
          }
          bytes += chunk.length;
          this.onStdout(decoder.decode(chunk, { stream: true }));
        }
        if (drained && !this.process.isAlive()) {
          this.onStdout(decoder.decode());
          if (this._stdoutBuffer) this.outputBuffer.push(this._stdoutBuffer);
          this._stdoutBuffer = "";
          this.release();
        }
      } catch (error) {
        this._readError = error instanceof Error ? error : new Error(String(error));
        this._atPrompt = false;
        this.stopReader();
        this.flushResolvers(false);
      }
    }, 50);
  }

  async start(): Promise<void> {
    try {
      if (this.kind === "kd") {
        const connected = await this.waitForConnectedToTarget(this.timeout);
        if (!connected) throw new Error("Timed out waiting for the kernel target to connect");
        if (!this._atPrompt) {
          // KDNET announces its transport before the engine can service a break-in.
          await sleep(1000);
          await this.sendCtrlBreak();
        }
      }
      if (!await this.waitForPrompt(this.timeout)) {
        throw new Error("Debugger initialization did not reach a command prompt");
      }
    } catch (error) {
      const detail = this.outputBuffer.join("\n");
      this.killSync();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`);
    }
  }

  private waitForConnectedToTarget(timeoutSec: number): Promise<boolean> {
    if (this._connectedToTarget) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this._connectedToTargetResolvers.push(resolve);
    const timer = setTimeout(() => {
      this._connectedToTargetResolvers = this._connectedToTargetResolvers.filter((r) => r !== resolve);
      resolve(false);
    }, timeoutSec * 1000);
    void promise.then(() => clearTimeout(timer));
    return promise;
  }

  async queryState(): Promise<DebuggerExecutionState> {
    return this.executionState();
  }

  private executionState(): DebuggerExecutionState {
    const alive = this.process.isAlive();
    const ready = alive && !this._readError && !this._ending && !this._expectedMarker && this._atPrompt;
    const status = !alive ? "no_debuggee" : this._readError ? "unknown"
      : this._ending ? "closing" : this._expectedMarker ? "busy" : ready ? "break" : "unknown";
    return {
      raw_status: !alive ? DEBUG_STATUS_NO_DEBUGGEE : ready ? DEBUG_STATUS_BREAK : null,
      status_name: status,
      running: !alive || ready || !this.isLiveSession ? false : null,
      busy: alive && !ready,
      ready_for_commands: ready,
      requires_interrupt_before_command: alive && !ready && !this._ending,
      summary: !alive ? "Debugger process has exited. Open a new session."
        : this._readError ? `Debugger output is unavailable: ${this._readError.message}`
        : this._ending ? "The session is ending."
        : ready ? "The debugger is at a command prompt."
        : this._expectedMarker ? "A command is pending. Collect its result without submitting another command, or interrupt it. A pending command does not identify the target's execution state."
        : "Debugger readiness is unknown. Interrupt to establish a command prompt.",
    };
  }

  /** Omitting command captures the latest command without joining the write queue. */
  execute(command?: string, timeout?: number, waitForCompletion = true): Promise<CommandExecutionResult> {
    const collect = async (last: PendingCommand): Promise<CommandExecutionResult> => {
      const waitSeconds = timeout ?? this.timeout;
      if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
        throw new Error("timeout must be a positive finite number");
      }
      if (this._readError) throw this._readError;
      if (waitForCompletion && !last.completed) await this.waitForReady(waitSeconds * 1000);
      if (this._readError) throw this._readError;
      const output = this.commandOutput(last);
      if (!last.completed && !this.process.isAlive()) {
        throw new Error(`Debugger exited before command completion.\n${output}`);
      }
      return {
        command: last.command,
        output,
        completed: last.completed,
        state_before: last.stateBefore,
        state_after: last.stateAfter ?? this.executionState(),
      };
    };
    if (command === undefined) {
      if (this._ending) return Promise.reject(new Error("The session is ending"));
      const last = this._lastCommand;
      if (!last) return Promise.reject(new Error("No command has been executed in this session"));
      return collect(last);
    }
    return this.enqueue(async () => {
      if (this._ending) throw new Error("The session is ending");
      const waitSeconds = timeout ?? this.timeout;
      if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
        throw new Error("timeout must be a positive finite number");
      }
      if (this._readError) throw this._readError;
      if (!command.trim()) throw new Error("command must not be empty");
      // A console helper must finish before another command can become its break target.
      if (this._interruptPromise) await this._interruptPromise;
      const stateBefore = this.executionState();
      if (!stateBefore.ready_for_commands) {
        throw new Error(`Debugger is not ready for a new command. ${stateBefore.summary}`);
      }
      const last: PendingCommand = { command, stateBefore, output: [], completed: false, stateAfter: null };
      this._lastCommand = last;
      this.outputBuffer = last.output;
      this._atPrompt = false;
      this._expectedMarker = this.nextMarker();
      this.writeStdin(`${command}\n${this.markerCommand(this._expectedMarker)}`);
      return collect(last);
    });
  }

  /** This control path must remain outside the command queue. */
  interrupt(): Promise<DebuggerExecutionState> {
    // An idle observation belongs only to this call, not to a command submitted after it.
    if (this.process.isAlive() && !this._readError && this._atPrompt && !this._expectedMarker) {
      return Promise.resolve(this.executionState());
    }
    const command = this._lastCommand;
    if (this._interruptPromise && this._interruptCommand === command) return this._interruptPromise;
    const previous = this._interruptPromise;
    const operation = previous ? previous.then(() => this.interruptAndWait()) : this.interruptAndWait();
    const result = operation.finally(() => {
      if (this._interruptPromise === result) {
        this._interruptPromise = null;
        this._interruptCommand = null;
      }
    });
    this._interruptCommand = command;
    this._interruptPromise = result;
    return result;
  }

  private async interruptAndWait(): Promise<DebuggerExecutionState> {
    if (!this.process.isAlive()) throw new Error("Debugger process has exited");
    if (this._readError) throw this._readError;
    if (this._atPrompt && !this._expectedMarker) return this.executionState();
    await this.sendCtrlBreak();
    if (!this._expectedMarker && !this._atPrompt) {
      this._expectedMarker = this.nextMarker();
      this.writeStdin(this.markerCommand(this._expectedMarker));
    }
    if (!await this.waitForReady(this.timeout * 1000)) {
      throw new Error("Interrupt did not reach a command prompt. The session remains unavailable for new commands.");
    }
    return this.executionState();
  }

  private async sendCtrlBreak(): Promise<void> {
    if (!await this.process.sendCtrlBreak()) {
      throw new Error("Could not send CTRL+BREAK to the debugger process.");
    }
  }

  /** q closes user-mode targets and leaves a stopped kernel target locked. */
  async close(): Promise<void> {
    await this.end("q");
  }

  /** qd detaches from live user-mode or kernel-mode targets without terminating them. */
  async detach(): Promise<void> {
    if (!this.isLiveSession) throw new Error("A crash dump cannot be detached; close it instead");
    await this.end("qd");
  }

  private async end(command: "q" | "qd"): Promise<void> {
    if (this._ending) throw new Error("The session is already ending");
    if (!this.process.isAlive()) {
      this.release();
      if (command === "qd") throw new Error("Debugger already exited; detachment cannot be confirmed");
      return;
    }
    this._ending = true;
    try {
      if (!this._atPrompt || this._expectedMarker) await this.interrupt();
      if (this._interruptPromise) await this._interruptPromise;
      await this.enqueue(async () => {
        if (!this._atPrompt || this._expectedMarker) throw new Error("Debugger is not at a command prompt");
        this._atPrompt = false;
        this._lastCommand = null;
        this.outputBuffer = [];
        this.writeStdin(`${command}\n`);
        const deadline = Date.now() + this.timeout * 1000;
        while (this.process.isAlive() && Date.now() < deadline) await sleep(25);
        if (this.process.isAlive()) {
          throw new Error(`Debugger did not exit after ${command}; it has been left alive.\n${this.outputBuffer.join("\n")}`);
        }
        this.release();
      });
    } finally {
      this._ending = false;
    }
  }

  killSync(): void {
    this.stopReader();
    this._atPrompt = false;
    this.flushResolvers(false);
    const connected = this._connectedToTargetResolvers;
    this._connectedToTargetResolvers = [];
    for (const resolve of connected) resolve(false);
    try { this.process.kill(); } catch { /* Best effort during process exit. */ }
  }

  private release(): void {
    this.stopReader();
    this._atPrompt = false;
    this.flushResolvers(false);
    const connected = this._connectedToTargetResolvers;
    this._connectedToTargetResolvers = [];
    for (const resolve of connected) resolve(false);
    this.process.dispose();
  }

  private stopReader(): void {
    clearInterval(this._readTimer);
    this._readTimer = undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Clear the write slot before resolving the caller, so its next command starts immediately.
    const operationResult = this._queue ? this._queue.then(operation) : operation();
    const result = operationResult.then((value) => {
      if (this._queue === settled) this._queue = null;
      return value;
    }, (error: unknown) => {
      if (this._queue === settled) this._queue = null;
      throw error;
    });
    const settled = result.then(() => {}, () => {});
    this._queue = settled;
    return result;
  }

  get pid(): number | undefined { return this.process.pid; }
  get exited(): boolean { return !this.process.isAlive(); }

  private nextMarker(): string {
    return `\x1e${this._markerPrefix}_${++this._markerSeq}`;
  }

  private markerCommand(marker: string): string {
    // RS separates framing from printable output. One argument avoids the C++ comma operator.
    return `.printf "%c${marker.slice(1)}\\n", 0x1e\n`;
  }

  private writeStdin(data: string): void {
    const bytes = new TextEncoder().encode(data);
    if (this.process.writeStdin(bytes) !== bytes.length) {
      throw new Error("Debugger input was not written completely; command completion is unknown");
    }
  }

  private waitForPrompt(timeoutSec: number): Promise<boolean> {
    this._expectedMarker = this.nextMarker();
    this._atPrompt = false;
    // Suppress only prompt output; prompt-shaped command data must remain intact.
    this.writeStdin(`.outmask- /l 0x10\n${this.markerCommand(this._expectedMarker)}`);
    return this.waitForReady(timeoutSec * 1000);
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    if (this._atPrompt && !this._expectedMarker) return Promise.resolve(true);
    if (this._readError || !this.process.isAlive()) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this._readyResolvers.push(resolve);
    const timer = setTimeout(() => {
      const idx = this._readyResolvers.indexOf(resolve);
      if (idx >= 0) {
        this._readyResolvers.splice(idx, 1);
        resolve(false);
      }
    }, timeoutMs);
    void promise.then(() => clearTimeout(timer));
    return promise;
  }

  private flushResolvers(value: boolean): void {
    const resolvers = this._readyResolvers;
    this._readyResolvers = [];
    for (const resolve of resolvers) resolve(value);
  }

  private markConnected(): void {
    if (this.kind !== "kd" || this._connectedToTarget) return;
    this._connectedToTarget = true;
    const resolvers = this._connectedToTargetResolvers;
    this._connectedToTargetResolvers = [];
    for (const resolve of resolvers) resolve(true);
  }

  private observePrompt(): void {
    this._atPrompt = true;
    this.markConnected();
  }

  private commandOutput(command: PendingCommand): string {
    const output = command.output.join("\n");
    if (command !== this._lastCommand || command.completed) return output;
    let tail = this._stdoutBuffer.replace(/\r$/, "");
    const marker = this._expectedMarker;
    if (marker) {
      // Withhold an unfinished private marker until the line parser can consume it.
      for (let length = Math.min(marker.length, tail.length); length > 0; length--) {
        if (tail.endsWith(marker.slice(0, length))) {
          tail = tail.slice(0, -length);
          break;
        }
      }
    }
    return tail ? `${output}${command.output.length ? "\n" : ""}${tail}` : output;
  }

  private onStdout(data: string): void {
    this._stdoutBuffer += data;
    let nl: number;
    while ((nl = this._stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this._stdoutBuffer.slice(0, nl).replace(/\r$/, "");
      this._stdoutBuffer = this._stdoutBuffer.slice(nl + 1);
      this.processLine(line);
    }
    if (!this._expectedMarker && PROMPT_RE.test(this._stdoutBuffer)) {
      this.observePrompt();
      this._stdoutBuffer = "";
    }
  }

  private processLine(line: string): void {
    if (line.includes("Connected to target") || line.includes("Kernel Debugger connection established")) {
      this.markConnected();
    }
    if (this._expectedMarker && line.endsWith(this._expectedMarker)) {
      const prefix = line.slice(0, -this._expectedMarker.length);
      if (prefix) this.outputBuffer.push(prefix);
      this._expectedMarker = null;
      this._atPrompt = true;
      if (this._lastCommand) {
        this._lastCommand.completed = true;
        this._lastCommand.stateAfter = this.executionState();
      }
      this.flushResolvers(true);
      return;
    }
    if (!this._expectedMarker && PROMPT_RE.test(line)) {
      this.observePrompt();
    } else if (this._expectedMarker || !this._lastCommand) {
      this.outputBuffer.push(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

const DEFAULT_CDB_PATHS = [
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\cdb.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x64)\\cdb.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x86)\\cdb.exe",
];

const DEFAULT_KD_PATHS = [
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\kd.exe",
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\kd.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x64)\\kd.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x86)\\kd.exe",
];

import { lstatSync } from "node:fs";
import { join } from "node:path";

// existsSync/stat follows reparse points and fails on Store execution-alias
// targets (ACL-blocked package dir); lstat inspects the link itself and works
// for real files and aliases alike.
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WinDbg for Windows (Store/MSIX) auto-detection
// ---------------------------------------------------------------------------
// The Store package's binaries under %ProgramFiles%\WindowsApps are
// ACL-blocked for direct launch, but Microsoft registers per-user App
// Execution Aliases under %LOCALAPPDATA%\Microsoft\WindowsApps (cdbX64.exe,
// kdX64.exe, ...) that launch through the Store activation layer as a normal
// user. Probe those fixed paths, same as the classic paths, on every call.

function storeAliasCandidates(exeName: "cdb.exe" | "kd.exe"): string[] {
  const stem = exeName === "cdb.exe" ? "cdb" : "kd";
  const names = process.arch === "arm64"
    ? [`${stem}ARM64.exe`, `${stem}X64.exe`]
    : [`${stem}X64.exe`, `${stem}X86.exe`];
  const localAppData = process.env.LOCALAPPDATA
    ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return names.map((n) => join(localAppData, "Microsoft", "WindowsApps", n));
}

function findExecutable(customPath: string | undefined, exeName: "cdb.exe" | "kd.exe"): string {
  if (customPath && pathExists(customPath)) return customPath;
  // Priority: explicit path → Store aliases → Windows Kits → legacy Debugging
  // Tools. Everything is probed on every call, so a WinDbg installed after
  // server start is picked up without a restart.
  for (const p of storeAliasCandidates(exeName)) if (pathExists(p)) return p;
  const classicPaths = exeName === "cdb.exe" ? DEFAULT_CDB_PATHS : DEFAULT_KD_PATHS;
  for (const p of classicPaths) if (pathExists(p)) return p;
  throw new Error(
    `Could not find ${exeName}. Install WinDbg (Microsoft Store) or Debugging Tools for Windows, or pass an explicit path (cdb_path / kd_path).`,
  );
}

export function createCdbExecutableSession(
  executable: string,
  execArgs: string[],
  opts?: { cdbPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const cdbPath = findExecutable(opts?.cdbPath, "cdb.exe");
  // cdb parses options before the first non-option token (the debuggee command
  // line), so -y MUST precede the executable; otherwise it is passed to the
  // debuggee as its own argument.
  const args = [
    cdbPath,
    "-2", // Keep debugger CTRL+BREAK out of the target's console.
    ...(opts?.symbolsPath ? ["-y", opts.symbolsPath] : []),
    executable,
    ...execArgs,
  ];
  return new DebuggerSession("cdb", {
    debuggerPath: cdbPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: true,
    target: executable,
  });
}

export function createCdbDumpSession(
  dumpPath: string,
  opts?: { cdbPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const cdbPath = findExecutable(opts?.cdbPath, "cdb.exe");
  const args = [cdbPath, "-z", dumpPath];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("cdb", {
    debuggerPath: cdbPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: false,
    target: dumpPath,
  });
}

export function createCdbAttachSession(
  attachSpec: string,
  opts?: { cdbPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const cdbPath = findExecutable(opts?.cdbPath, "cdb.exe");
  // attachSpec is either a decimal pid (-p) or a process name (-pn)
  const flag = /^\d+$/.test(attachSpec) ? "-p" : "-pn";
  const args = [cdbPath, flag, attachSpec];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("cdb", {
    debuggerPath: cdbPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: true,
    target: `pid ${attachSpec}`,
  });
}

/**
 * KDNET connection strings may omit `port=`; kd.exe then cannot determine
 * which port to use and the connection fails. Default it to 50000.
 */
function normalizeKdConnection(connection: string): string {
  if (connection.startsWith("net:") && !connection.includes("port=")) {
    return connection.replace(/^net:/, "net:port=50000,");
  }
  return connection;
}

export function createKdSession(
  kernelConnection: string,
  opts?: { kdPath?: string; symbolsPath?: string; timeout?: number },
): DebuggerSession {
  const kdPath = findExecutable(opts?.kdPath, "kd.exe");
  const connection = normalizeKdConnection(kernelConnection);
  const args = [kdPath, "-k", connection];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("kd", {
    debuggerPath: kdPath,
    launchArgs: args,
    timeout: opts?.timeout ?? 60,
    isLiveSession: true,
    target: connection,
  });
}

