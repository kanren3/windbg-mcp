/** One debugger process per session, with independent input, output and interrupt paths. */
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { spawnWin32, type Win32Process } from "./spawn_win32.js";
import { CommandOutput, DEFAULT_OUTPUT_PAGE_BYTES, MAX_OUTPUT_PAGE_BYTES, type OutputPage } from "./command_output.js";
import { validateDebuggerCommand } from "./command_policy.js";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const MARKER_BASE = "COMMAND_COMPLETED_MARKER";
const PROMPT_RE = /^\d+:\s*(?:\d+(?::\w+)?|kd)>\s*$/;
const DEBUG_STATUS_BREAK = 6;
const DEBUG_STATUS_NO_DEBUGGEE = 7;

export interface DebuggerExecutionState {
  raw_status: number | null;
  status_name: string;
  running: boolean | null;
  busy: boolean;
  ready_for_commands: boolean;
  requires_interrupt_before_command: boolean;
  summary: string;
}

export interface CommandExecutionResult extends OutputPage {
  command_id: string;
  command: string;
  completed: boolean;
  state_before: DebuggerExecutionState;
  state_after: DebuggerExecutionState;
  output_error?: string;
}

export interface CommandOutputRequest {
  command_id?: string;
  output_offset?: number;
  max_output_bytes?: number;
}

interface PendingCommand {
  command: string;
  stateBefore: DebuggerExecutionState;
  output: CommandOutput;
  completed: boolean;
  stateAfter: DebuggerExecutionState | null;
  outputError: Error | null;
  readers: number;
  retired: boolean;
}

export type SessionKind = "cdb" | "kd";

export interface SessionOptions {
  /** Full argv; the debugger executable is launchArgs[0]. */
  launchArgs: string[];
  timeout: number;
  /** Initial target description; debugger commands may change the active targets. */
  target: string;
  maxOutputBytes?: number;
}

export class DebuggerSession {
  kind: SessionKind;
  target: string;
  createdAt: number;
  private process: Win32Process;
  private timeout: number;
  private maxOutputBytes: number | undefined;
  private _outputs = new Set<CommandOutput>();
  private _capture: CommandOutput;
  private _captureCommand: PendingCommand | null = null;
  private _captureError: Error | null = null;
  private _captureHasLines = false;
  private _lineStarted = false;
  private _markerPrefix = `${MARKER_BASE}_${randomUUID()}`;
  private _markerSeq = 0;
  private _expectedMarker: string | null = null;
  private _readyResolvers: ((value: boolean) => void)[] = [];
  private _atPrompt = false;
  private _stdoutBuffer = "";
  private _connectedToTarget = false;
  private _connectedToTargetResolvers: ((value: boolean) => void)[] = [];
  private _readTimer: NodeJS.Timeout | undefined;
  private _readTask: Promise<void> | null = null;
  private _readerStopped = false;
  private _readError: Error | null = null;
  private _cleanupError: Error | null = null;
  private _queue: Promise<void> | null = null;
  private _ending = false;
  private _interruptPromise: Promise<DebuggerExecutionState> | null = null;
  private _interruptCommand: PendingCommand | null = null;
  private _lastCommand: PendingCommand | null = null;

  constructor(kind: SessionKind, opts: SessionOptions) {
    if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error("timeout must be a positive finite number");
    this.kind = kind;
    this.timeout = opts.timeout;
    this.target = opts.target;
    this.createdAt = Date.now();
    this.maxOutputBytes = opts.maxOutputBytes;
    this._capture = this.newOutput();
    const cmdLine = opts.launchArgs.map((arg) => {
      if (!/[ \t"]/.test(arg) && arg.length > 0) return arg;
      const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
      return `"${escaped}"`;
    }).join(" ");
    this.process = spawnWin32(cmdLine);

    const decoder = new TextDecoder("utf-8");
    this._readTimer = setInterval(() => {
      if (this._readTask || this._readerStopped) return;
      this._readTask = this.readOutput(decoder).catch((error: unknown) => {
        if (this._readerStopped) return;
        this._readError = error instanceof Error ? error : new Error(String(error));
        this._atPrompt = false;
        this.stopReader();
        this.flushResolvers(false);
      }).finally(() => { this._readTask = null; });
    }, 50);
  }

  private async readOutput(decoder: TextDecoder): Promise<void> {
    let drained = false;
    for (let bytes = 0; bytes < 1024 * 1024 && !this._readerStopped;) {
      const chunk = this.process.readStdout(64 * 1024);
      if (chunk.length === 0) { drained = true; break; }
      bytes += chunk.length;
      await this.onStdout(decoder.decode(chunk, { stream: true }));
    }
    if (drained && !this._readerStopped && !this.process.isAlive()) {
      await this.onStdout(decoder.decode());
      if (this._stdoutBuffer) {
        const parts: string[] = [];
        this.captureText(parts, this._stdoutBuffer);
        this._stdoutBuffer = "";
        await this.appendCaptured(parts);
      }
      this.release();
    }
  }

  async start(): Promise<void> {
    try {
      if (this.kind === "kd") {
        if (!await this.waitForConnectedToTarget(this.timeout)) throw new Error("Timed out waiting for the kernel target to connect");
        if (!this._atPrompt) {
          await sleep(1000);
          await this.sendCtrlBreak();
        }
      }
      if (!await this.waitForPrompt(this.timeout)) throw new Error("Debugger initialization did not reach a command prompt");
      if (this._readError) throw this._readError;
    } catch (error) {
      let detail: string;
      try { detail = (await this._capture.readPage()).output; }
      catch (storageError) { detail = storageError instanceof Error ? storageError.message : String(storageError); }
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

  async queryState(): Promise<DebuggerExecutionState> { return this.executionState(); }

  private executionState(): DebuggerExecutionState {
    const alive = this.process.isAlive();
    const ready = alive && !this._readError && !this._ending && !this._expectedMarker && this._atPrompt;
    const status = !alive ? "no_debuggee" : this._readError ? "unknown"
      : this._ending ? "closing" : this._expectedMarker ? "busy" : ready ? "break" : "unknown";
    return {
      raw_status: !alive ? DEBUG_STATUS_NO_DEBUGGEE : ready ? DEBUG_STATUS_BREAK : null,
      status_name: status,
      running: !alive || ready ? false : null,
      busy: alive && !ready,
      ready_for_commands: ready,
      requires_interrupt_before_command: alive && !ready && !this._ending,
      summary: !alive ? "Debugger process has exited. Open a new session."
        : this._readError ? `Debugger I/O is unavailable: ${this._readError.message}`
        : this._ending ? "The session is ending."
        : ready ? "The debugger is at a command prompt."
        : this._expectedMarker ? "A command is pending. Collect its output or interrupt it. A pending command does not identify the target's execution state."
        : "Debugger readiness is unknown. Interrupt to establish a command prompt.",
    };
  }

  execute(command?: string, timeout?: number, waitForCompletion = true, output: CommandOutputRequest = {}): Promise<CommandExecutionResult> {
    const waitSeconds = timeout ?? this.timeout;
    const offset = output.output_offset ?? 0;
    const maxBytes = output.max_output_bytes ?? DEFAULT_OUTPUT_PAGE_BYTES;
    if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) return Promise.reject(new Error("timeout must be a positive finite number"));
    if (!Number.isSafeInteger(offset) || offset < 0) return Promise.reject(new Error("output_offset must be a nonnegative safe integer"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > MAX_OUTPUT_PAGE_BYTES) {
      return Promise.reject(new Error(`max_output_bytes must be between 4 and ${MAX_OUTPUT_PAGE_BYTES}`));
    }
    if (offset !== 0 && !output.command_id) return Promise.reject(new Error("command_id is required when continuing an output page"));
    if (command !== undefined && (output.command_id !== undefined || offset !== 0)) {
      return Promise.reject(new Error("Output cursors apply only when collecting an existing command"));
    }
    const collect = async (last: PendingCommand): Promise<CommandExecutionResult> => {
      last.readers++;
      try {
        if (this._readError) throw this._readError;
        if (waitForCompletion && !last.completed) await this.waitForReady(waitSeconds * 1000);
        if (this._readError) throw this._readError;
        const page = await last.output.readPage(offset, maxBytes);
        if (!last.completed && !this.process.isAlive()) throw new Error(`Debugger exited before command completion.\n${page.output}`);
        return {
          command_id: last.output.id,
          command: last.command,
          ...page,
          completed: last.completed,
          state_before: last.stateBefore,
          state_after: last.stateAfter ?? this.executionState(),
          ...(last.outputError ? { output_error: last.outputError.message } : {}),
        };
      } finally {
        last.readers--;
        if (last.retired && last.readers === 0) this.retireOutput(last.output);
      }
    };
    if (command === undefined) {
      if (this._ending) return Promise.reject(new Error("The session is ending"));
      const last = this._lastCommand;
      if (!last) return Promise.reject(new Error("No command has been executed in this session"));
      if (output.command_id !== undefined && output.command_id !== last.output.id) {
        return Promise.reject(new Error("Command output has expired; collect all pages before starting another command"));
      }
      return collect(last);
    }
    let input: string;
    try { input = validateDebuggerCommand(command); }
    catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      if (this._ending) throw new Error("The session is ending");
      if (this._readError) throw this._readError;
      if (this._interruptPromise) await this._interruptPromise;
      const stateBefore = this.executionState();
      if (!stateBefore.ready_for_commands) throw new Error(`Debugger is not ready for a new command. ${stateBefore.summary}`);
      const previous = this._lastCommand;
      if (previous) {
        previous.retired = true;
        if (previous.readers === 0) this.retireOutput(previous.output);
      } else {
        this.retireOutput(this._capture);
      }
      const last: PendingCommand = {
        command, stateBefore, output: this.newOutput(), completed: false,
        stateAfter: null, outputError: null, readers: 0, retired: false,
      };
      this._lastCommand = last;
      this.beginCapture(last.output, last);
      this._atPrompt = false;
      this._expectedMarker = this.nextMarker();
      // Writes are FIFO and asynchronous; snapshot/control requests must not await pipe capacity.
      void this.writeStdin(`${input}\n${this.markerCommand(this._expectedMarker)}`).catch((error: unknown) => {
        if (this._readerStopped) return;
        this._readError = error instanceof Error ? error : new Error(String(error));
        this._atPrompt = false;
        this.flushResolvers(false);
      });
      return collect(last);
    });
  }

  interrupt(): Promise<DebuggerExecutionState> {
    if (this.process.isAlive() && !this._readError && this._atPrompt && !this._expectedMarker) return Promise.resolve(this.executionState());
    const command = this._lastCommand;
    if (this._interruptPromise && this._interruptCommand === command) return this._interruptPromise;
    const previous = this._interruptPromise;
    const operation = previous ? previous.then(() => this.interruptAndWait()) : this.interruptAndWait();
    const result = operation.finally(() => {
      if (this._interruptPromise === result) { this._interruptPromise = null; this._interruptCommand = null; }
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
      await this.writeStdin(this.markerCommand(this._expectedMarker));
    }
    if (!await this.waitForReady(this.timeout * 1000)) throw new Error("Interrupt did not reach a command prompt. The session remains unavailable for new commands.");
    return this.executionState();
  }

  private async sendCtrlBreak(): Promise<void> {
    if (!await this.process.sendCtrlBreak()) throw new Error("Could not send CTRL+BREAK to the debugger process.");
  }

  async close(): Promise<void> {
    try {
      await this.end("q");
    } catch {
      // Closing must remain possible after commands take over input or suppress markers.
      this.process.kill();
      this.release();
      await this.closeOutputs();
    }
  }

  /** Send qd to the current debugger context and wait for process exit. */
  async detach(): Promise<void> {
    await this.end("qd");
  }

  private async end(command: "q" | "qd"): Promise<void> {
    if (this._ending) throw new Error("The session is already ending");
    if (!this.process.isAlive()) {
      this.release();
      await this.closeOutputs();
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
        this.beginCapture(this.newOutput(), null);
        this._lastCommand = null;
        await this.writeStdin(`${command}\n`);
        const deadline = Date.now() + this.timeout * 1000;
        while (this.process.isAlive() && Date.now() < deadline) await sleep(25);
        if (this.process.isAlive()) {
          const page = await this._capture.readPage();
          throw new Error(`Debugger did not exit after ${command}; it has been left alive.\n${page.output}`);
        }
        this.release();
        await this.closeOutputs();
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
    for (const output of this._outputs) output.closeSync();
    this._outputs.clear();
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
    this._readerStopped = true;
    clearInterval(this._readTimer);
    this._readTimer = undefined;
  }

  private newOutput(): CommandOutput {
    const output = new CommandOutput({ maxBytes: this.maxOutputBytes });
    this._outputs.add(output);
    return output;
  }

  private beginCapture(output: CommandOutput, command: PendingCommand | null): void {
    this._capture = output;
    this._captureCommand = command;
    this._captureError = null;
    this._captureHasLines = false;
    this._lineStarted = false;
    this._stdoutBuffer = "";
  }

  private retireOutput(output: CommandOutput): void {
    void output.close().then(() => this._outputs.delete(output)).catch((error: unknown) => {
      this._cleanupError = error instanceof Error ? error : new Error(String(error));
    });
  }

  private async closeOutputs(): Promise<void> {
    await this._readTask;
    const outputs = [...this._outputs];
    const results = await Promise.allSettled(outputs.map((output) => output.close()));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") this._outputs.delete(outputs[i]);
      else this._cleanupError = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
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

  get exited(): boolean { return !this.process.isAlive(); }
  get outputCleanupError(): string | undefined { return this._cleanupError?.message; }

  private nextMarker(): string { return `\x1e${this._markerPrefix}_${++this._markerSeq}`; }

  private markerCommand(marker: string): string {
    return `.printf "%c${marker.slice(1)}\\n", 0x1e\n`;
  }

  private async writeStdin(data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);
    if (await this.process.writeStdin(bytes) !== bytes.length) throw new Error("Debugger input was not written completely; command completion is unknown");
  }

  private async waitForPrompt(timeoutSec: number): Promise<boolean> {
    this._expectedMarker = this.nextMarker();
    this._atPrompt = false;
    await this.writeStdin(`ad *\n.outmask- /l 0x10\n${this.markerCommand(this._expectedMarker)}`);
    return this.waitForReady(timeoutSec * 1000);
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    if (this._atPrompt && !this._expectedMarker) return Promise.resolve(true);
    if (this._readError || !this.process.isAlive()) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this._readyResolvers.push(resolve);
    const timer = setTimeout(() => {
      const idx = this._readyResolvers.indexOf(resolve);
      if (idx >= 0) { this._readyResolvers.splice(idx, 1); resolve(false); }
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

  private observePrompt(): void { this._atPrompt = true; this.markConnected(); }

  private captureText(parts: string[], text: string): void {
    if (!this._lineStarted && this._captureHasLines) parts.push("\n");
    parts.push(text);
    this._lineStarted = true;
  }

  private async appendCaptured(parts: string[]): Promise<void> {
    if (parts.length === 0 || this._captureError) return;
    try { await this._capture.append(parts.join("")); }
    catch (error) {
      this._captureError = error instanceof Error ? error : new Error(String(error));
      if (this._captureCommand) this._captureCommand.outputError = this._captureError;
    }
  }

  private async onStdout(data: string): Promise<void> {
    this._stdoutBuffer += data;
    let parts: string[] = [];
    let ready = false;
    let nl: number;
    while (!this._readerStopped && (nl = this._stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this._stdoutBuffer.slice(0, nl).replace(/\r$/, "");
      this._stdoutBuffer = this._stdoutBuffer.slice(nl + 1);
      if (line.includes("Connected to target") || line.includes("Kernel Debugger connection established")) this.markConnected();
      if (this._expectedMarker && line.endsWith(this._expectedMarker)) {
        const prefix = line.slice(0, -this._expectedMarker.length);
        if (prefix) this.captureText(parts, prefix);
        await this.appendCaptured(parts);
        parts = [];
        this._expectedMarker = null;
        this._atPrompt = true;
        if (this._lastCommand) {
          this._lastCommand.completed = true;
          this._lastCommand.stateAfter = this.executionState();
        }
        ready = true;
      } else if (!this._expectedMarker && !this._lineStarted && PROMPT_RE.test(line)) {
        this.observePrompt();
      } else if (this._expectedMarker || !this._lastCommand) {
        this.captureText(parts, line);
        this._captureHasLines = true;
        this._lineStarted = false;
      }
    }
    if (!this._expectedMarker && !this._lineStarted && PROMPT_RE.test(this._stdoutBuffer)) {
      this.observePrompt();
      this._stdoutBuffer = "";
    } else if (this._expectedMarker || !this._lastCommand) {
      let keep = this._stdoutBuffer.endsWith("\r") ? 1 : 0;
      if (this._expectedMarker) {
        const marker = this._expectedMarker;
        const tail = keep ? this._stdoutBuffer.slice(0, -1) : this._stdoutBuffer;
        for (let length = Math.min(marker.length, tail.length); length > 0; length--) {
          if (tail.endsWith(marker.slice(0, length))) { keep += length; break; }
        }
      } else {
        // Keep enough startup text for split connection banners and prompts.
        keep = Math.max(keep, Math.min(512, this._stdoutBuffer.length));
      }
      let end = this._stdoutBuffer.length - keep;
      if (end > 0 && end < this._stdoutBuffer.length &&
          this._stdoutBuffer.charCodeAt(end - 1) >= 0xd800 && this._stdoutBuffer.charCodeAt(end - 1) <= 0xdbff) end--;
      if (end > 0) {
        this.captureText(parts, this._stdoutBuffer.slice(0, end));
        this._stdoutBuffer = this._stdoutBuffer.slice(end);
      }
    } else {
      this._stdoutBuffer = "";
    }
    await this.appendCaptured(parts);
    if (ready) this.flushResolvers(true);
  }
}

const DEFAULT_CDB_PATHS = [
  ...(process.arch === "arm64" ? ["C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\arm64\\cdb.exe"] : []),
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe",
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\cdb.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x64)\\cdb.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x86)\\cdb.exe",
];
const DEFAULT_KD_PATHS = [
  ...(process.arch === "arm64" ? ["C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\arm64\\kd.exe"] : []),
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\kd.exe",
  "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x86\\kd.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x64)\\kd.exe",
  "C:\\Program Files\\Debugging Tools for Windows (x86)\\kd.exe",
];

function pathExists(path: string): boolean {
  // Store execution aliases require inspecting the reparse point itself.
  try { lstatSync(path); return true; } catch { return false; }
}

function storeAliasCandidates(exeName: "cdb.exe" | "kd.exe"): string[] {
  const stem = exeName === "cdb.exe" ? "cdb" : "kd";
  const names = process.arch === "arm64" ? [`${stem}ARM64.exe`, `${stem}X64.exe`] : [`${stem}X64.exe`, `${stem}X86.exe`];
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return names.map((name) => join(localAppData, "Microsoft", "WindowsApps", name));
}

function findExecutable(customPath: string | undefined, exeName: "cdb.exe" | "kd.exe"): string {
  if (customPath) {
    if (!pathExists(customPath)) throw new Error(`Debugger executable does not exist: ${customPath}`);
    return customPath;
  }
  for (const path of storeAliasCandidates(exeName)) if (pathExists(path)) return path;
  for (const path of exeName === "cdb.exe" ? DEFAULT_CDB_PATHS : DEFAULT_KD_PATHS) if (pathExists(path)) return path;
  throw new Error(`Could not find ${exeName}. Install WinDbg or Debugging Tools for Windows, or provide cdb_path / kd_path.`);
}

type CdbOptions = { cdbPath?: string; symbolsPath?: string; timeout?: number; maxOutputBytes?: number };

export function createCdbExecutableSession(executable: string, execArgs: string[], opts?: CdbOptions): DebuggerSession {
  const path = findExecutable(opts?.cdbPath, "cdb.exe");
  const args = [path, "-2", ...(opts?.symbolsPath ? ["-y", opts.symbolsPath] : []), executable, ...execArgs];
  return new DebuggerSession("cdb", {
    launchArgs: args, timeout: opts?.timeout ?? 60,
    target: executable, maxOutputBytes: opts?.maxOutputBytes,
  });
}

export function createCdbDumpSession(dumpPath: string, opts?: CdbOptions): DebuggerSession {
  const path = findExecutable(opts?.cdbPath, "cdb.exe");
  const args = [path, "-z", dumpPath];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("cdb", {
    launchArgs: args, timeout: opts?.timeout ?? 60,
    target: dumpPath, maxOutputBytes: opts?.maxOutputBytes,
  });
}

export function createCdbAttachSession(attachSpec: string, opts?: CdbOptions): DebuggerSession {
  const path = findExecutable(opts?.cdbPath, "cdb.exe");
  const args = [path, /^\d+$/.test(attachSpec) ? "-p" : "-pn", attachSpec];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("cdb", {
    launchArgs: args, timeout: opts?.timeout ?? 60,
    target: `pid ${attachSpec}`, maxOutputBytes: opts?.maxOutputBytes,
  });
}

function normalizeKdConnection(connection: string): string {
  return connection.startsWith("net:") && !connection.includes("port=") ? connection.replace(/^net:/, "net:port=50000,") : connection;
}

export function createKdSession(kernelConnection: string, opts?: { kdPath?: string; symbolsPath?: string; timeout?: number; maxOutputBytes?: number }): DebuggerSession {
  const path = findExecutable(opts?.kdPath, "kd.exe");
  const connection = normalizeKdConnection(kernelConnection);
  const args = [path, "-k", connection];
  if (opts?.symbolsPath) args.push("-y", opts.symbolsPath);
  return new DebuggerSession("kd", {
    launchArgs: args, timeout: opts?.timeout ?? 60,
    target: connection, maxOutputBytes: opts?.maxOutputBytes,
  });
}
