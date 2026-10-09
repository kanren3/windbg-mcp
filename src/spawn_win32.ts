/**
 * Native Win32 spawn with a new process group and piped stdio.
 * Console-free hosts use a short-lived helper to interrupt the child's console.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { kernel32Ffi, type PinnedBuffer } from "./ffi.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const STARTF_USESHOWWINDOW = 0x00000001;
const STARTF_USESTDHANDLES = 0x00000100;
const HANDLE_FLAG_INHERIT = 0x00000001;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x00000102;
const WAIT_FAILED = 0xffffffff;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const PIPE_ACCESS_OUTBOUND = 0x00000002;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_IO_PENDING = 997;
const ERROR_IO_INCOMPLETE = 996;
const ERROR_NOT_FOUND = 1168;
const STDIN_WRITE_BYTES = 65536;
const IO_POLL_MS = 5;

// ---------------------------------------------------------------------------
// Struct sizes (Windows x64 and arm64: 8-byte pointers, 4-byte DWORD/BOOL)
// ---------------------------------------------------------------------------
const SIZEOF_STARTUPINFOW = 104;
const SIZEOF_PROCESS_INFORMATION = 24;
const SIZEOF_SECURITY_ATTRIBUTES = 24;
const SIZEOF_OVERLAPPED = 32;
const OVERLAPPED_HEVENT = 24;

// STARTUPINFOW offsets
const SI_CB = 0;
const SI_DWFLAGS = 60;
const SI_WSHOWWINDOW = 64;
const SI_HSTDINPUT = 80;
const SI_HSTDOUTPUT = 88;
const SI_HSTDERROR = 96;

// PROCESS_INFORMATION offsets
const PI_HPROCESS = 0;
const PI_HTHREAD = 8;
const PI_DWPROCESSID = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toWideString(s: string): Uint16Array {
  const buf = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  buf[s.length] = 0;
  return buf;
}

function readHandle(buf: ArrayBuffer, offset: number): bigint {
  return new DataView(buf).getBigUint64(offset, true);
}

function writeHandle(buf: ArrayBuffer, offset: number, val: bigint): void {
  new DataView(buf).setBigUint64(offset, val, true);
}

function readU32(buf: ArrayBuffer, offset: number): number {
  return new DataView(buf).getUint32(offset, true);
}

function writeU32(buf: ArrayBuffer, offset: number, val: number): void {
  new DataView(buf).setUint32(offset, val, true);
}

function createStdinPipe(sa: ArrayBuffer): [bigint, bigint] {
  const ffi = kernel32Ffi;
  const name = toWideString(`\\\\.\\pipe\\windbg-mcp-${process.pid}-${randomUUID()}`).buffer as ArrayBuffer;
  const server = ffi.createNamedPipeW(name, PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_REJECT_REMOTE_CLIENTS, 1, STDIN_WRITE_BYTES, 0, 0);
  if (server === INVALID_HANDLE_VALUE) throw new Error(`CreateNamedPipeW(stdin) failed: ${ffi.getLastError()}`);
  let client = INVALID_HANDLE_VALUE;
  let overlapped: PinnedBuffer | undefined;
  let pending = false;
  try {
    // Only the child's synchronous read end is inheritable. Open it before
    // ConnectNamedPipe: ERROR_PIPE_CONNECTED then denotes an established connection.
    client = ffi.createFileW(name, GENERIC_READ, 0, sa, OPEN_EXISTING, 0);
    if (client === INVALID_HANDLE_VALUE) throw new Error(`CreateFileW(stdin) failed: ${ffi.getLastError()}`);
    overlapped = ffi.allocatePinnedBuffer(SIZEOF_OVERLAPPED);
    new Uint8Array(overlapped.buffer).fill(0);
    if (!ffi.connectNamedPipe(server, overlapped.buffer)) {
      const error = ffi.getLastError();
      pending = error === ERROR_IO_PENDING;
      if (error !== ERROR_PIPE_CONNECTED) throw new Error(`ConnectNamedPipe(stdin) failed: ${error}`);
    }
    overlapped.free();
    return [client, server];
  } catch (error) {
    if (client !== INVALID_HANDLE_VALUE) ffi.closeHandle(client);
    if (pending && overlapped) {
      // Defensive setup-failure path: cancellation is not completion. Keep the
      // native struct and server alive until the canceled operation is reaped.
      const retained = overlapped;
      const transferred = new ArrayBuffer(4);
      ffi.cancelIoEx(server, retained.buffer);
      const reap = () => {
        if (!ffi.getOverlappedResult(server, retained.buffer, transferred) && ffi.getLastError() === ERROR_IO_INCOMPLETE) {
          setTimeout(reap, IO_POLL_MS);
          return;
        }
        ffi.closeHandle(server);
        retained.free();
      };
      reap();
    } else {
      ffi.closeHandle(server);
      overlapped?.free();
    }
    throw error;
  }
}


// ---------------------------------------------------------------------------
// Win32Process
// ---------------------------------------------------------------------------
export interface Win32Process {
  pid: number;
  /** Read up to `max` bytes from the child's stdout. Returns bytes read, or empty on EOF/error. */
  readStdout(max: number): Uint8Array;
  /** Ordered asynchronous write. Do not mutate or detach the supplied view until it settles. */
  writeStdin(data: Uint8Array): Promise<number>;
  /** Send CTRL+BREAK to the child's process group. */
  sendCtrlBreak(): Promise<boolean>;
  /** Terminate the child and dispose. Pending native writes are canceled and reaped asynchronously. */
  kill(): void;
  /** Dispose without terminating; pending I/O storage/handles remain owned until reaped. Idempotent. */
  dispose(): void;
  /** Check for a running child. Returns false after disposal; throws on wait failure. */
  isAlive(): boolean;
}

/** Spawn a separate process group without changing the host's console attachment. */
export function spawnWin32(commandLine: string): Win32Process {
  const ffi = kernel32Ffi;
  const sharedConsole = ffi.getConsoleProcessList(new ArrayBuffer(4), 1) !== 0;

  // --- Create pipes ---
  // stdin: parent writes to writeStdin, child reads from readStdin
  // stdout: child writes to writeStdout, parent reads from readStdout
  // stderr uses the child's stdout write handle, so both streams share one pipe.

  const sa = new ArrayBuffer(SIZEOF_SECURITY_ATTRIBUTES);
  writeU32(sa, 0, SIZEOF_SECURITY_ATTRIBUTES);
  writeHandle(sa, 8, 0n); // lpSecurityDescriptor = NULL
  writeU32(sa, 16, 1);    // bInheritHandle = TRUE

  // The parent write end uses real overlapped I/O; anonymous pipes do not.
  const stdinRead = new ArrayBuffer(8);
  const stdinWrite = new ArrayBuffer(8);
  const [childStdinRead, overlappedStdinWrite] = createStdinPipe(sa);
  writeHandle(stdinRead, 0, childStdinRead);
  writeHandle(stdinWrite, 0, overlappedStdinWrite);

  // Buffer output bursts while the event loop is between reader polls.
  const stdoutRead = new ArrayBuffer(8);
  const stdoutWrite = new ArrayBuffer(8);
  if (!ffi.createPipe(stdoutRead, stdoutWrite, sa, 64 * 1024)) {
    const err = ffi.getLastError();
    // Don't leak stdin pipe on failure
    ffi.closeHandle(readHandle(stdinRead, 0));
    ffi.closeHandle(readHandle(stdinWrite, 0));
    throw new Error(`CreatePipe(stdout) failed: ${err}`);
  }

  // stderr merges into stdout (like Python subprocess.STDOUT).
  // We point hStdError at the same stdout pipe write end.
  // No separate stderr pipe needed.

  // Prevent parent-side handles from being inherited into the child.
  // If these fail, the pipe ends leak into this and future children.
  if (!ffi.setHandleInformation(readHandle(stdinWrite, 0), HANDLE_FLAG_INHERIT, 0) ||
      !ffi.setHandleInformation(readHandle(stdoutRead, 0), HANDLE_FLAG_INHERIT, 0)) {
    const err = ffi.getLastError();
    ffi.closeHandle(readHandle(stdinRead, 0));
    ffi.closeHandle(readHandle(stdinWrite, 0));
    ffi.closeHandle(readHandle(stdoutRead, 0));
    ffi.closeHandle(readHandle(stdoutWrite, 0));
    throw new Error(`SetHandleInformation failed: ${err}`);
  }

  // --- STARTUPINFOW ---
  const si = new ArrayBuffer(SIZEOF_STARTUPINFOW);
  writeU32(si, SI_CB, SIZEOF_STARTUPINFOW);
  writeU32(si, SI_DWFLAGS, STARTF_USESTDHANDLES | (sharedConsole ? 0 : STARTF_USESHOWWINDOW));
  // Hide only the new child console; never alter an existing user's console.
  if (!sharedConsole) new DataView(si).setUint16(SI_WSHOWWINDOW, 0, true); // SW_HIDE
  writeHandle(si, SI_HSTDINPUT, readHandle(stdinRead, 0));
  writeHandle(si, SI_HSTDOUTPUT, readHandle(stdoutWrite, 0));
  writeHandle(si, SI_HSTDERROR, readHandle(stdoutWrite, 0)); // stderr → stdout pipe

  // --- PROCESS_INFORMATION ---
  const pi = new ArrayBuffer(SIZEOF_PROCESS_INFORMATION);

  // --- Command line (must be mutable) ---
  const cmdBuf = toWideString(commandLine);

  // --- CreateProcess ---
  const ok = ffi.createProcessW(
    null,               // lpApplicationName — use command line
    cmdBuf.buffer as ArrayBuffer, // lpCommandLine
    null,               // lpProcessAttributes
    null,               // lpThreadAttributes
    true,               // bInheritHandles
    CREATE_NEW_PROCESS_GROUP,
    null,               // lpEnvironment (inherit)
    null,               // lpCurrentDirectory (inherit)
    si,                 // lpStartupInfo
    pi,                 // lpProcessInformation
  );
  const createError = ok ? 0 : ffi.getLastError();

  // Close child-side handles (they were duplicated into the child)
  ffi.closeHandle(readHandle(stdinRead, 0));
  ffi.closeHandle(readHandle(stdoutWrite, 0));
  // Note: hStdError points to the same stdoutWrite handle — already closed above.

  if (!ok) {
    ffi.closeHandle(readHandle(stdinWrite, 0));
    ffi.closeHandle(readHandle(stdoutRead, 0));
    throw new Error(`CreateProcessW failed: error ${createError}`);
  }

  const hProcess = readHandle(pi, PI_HPROCESS);
  const hThread = readHandle(pi, PI_HTHREAD);
  const pid = readU32(pi, PI_DWPROCESSID);

  // Close thread handle (not needed)
  ffi.closeHandle(hThread);

  const parentStdinWrite = readHandle(stdinWrite, 0);
  const parentStdoutRead = readHandle(stdoutRead, 0);
  let disposed = false;

  const bytesBuf = new ArrayBuffer(4);
  const availBuf = new ArrayBuffer(4);
  const transferred = new ArrayBuffer(4);
  let writeTail: Promise<void> | null = null;
  let overlapped: PinnedBuffer | undefined;
  let staging: PinnedBuffer | undefined;
  let stagingView: Uint8Array | undefined;
  let writeEvent = 0n;
  let nativePending = false;
  let stdinReleased = false;
  let cancellationError = 0;

  function releaseStdin(): void {
    if (stdinReleased || nativePending) return;
    stdinReleased = true;
    ffi.closeHandle(parentStdinWrite);
    if (writeEvent) ffi.closeHandle(writeEvent);
    overlapped?.free();
    staging?.free();
    overlapped = staging = undefined;
    stagingView = undefined;
  }

  function cancelPendingWrite(): void {
    if (!nativePending || !overlapped) return;
    if (!ffi.cancelIoEx(parentStdinWrite, overlapped.buffer)) {
      const error = ffi.getLastError();
      // Completion may have won the race; the poll still has to reap it.
      cancellationError = error === ERROR_NOT_FOUND ? 0 : error;
    } else {
      cancellationError = 0;
    }
  }

  function prepareWriteStorage(): void {
    if (overlapped) return;
    try {
      overlapped = ffi.allocatePinnedBuffer(SIZEOF_OVERLAPPED);
      staging = ffi.allocatePinnedBuffer(STDIN_WRITE_BYTES);
      stagingView = new Uint8Array(staging.buffer);
      writeEvent = ffi.createEventW();
      if (!writeEvent) throw new Error(`CreateEventW(stdin) failed: ${ffi.getLastError()}`);
    } catch (error) {
      overlapped?.free();
      staging?.free();
      overlapped = staging = undefined;
      stagingView = undefined;
      throw error;
    }
  }

  async function writeInput(data: Uint8Array): Promise<number> {
    if (disposed) throw new Error("Cannot write stdin after process disposal");
    const total = data.byteLength;
    if (total === 0) return 0;
    prepareWriteStorage();
    const ov = overlapped!.buffer;
    const ovView = new Uint8Array(ov);
    const buffer = stagingView!;
    let written = 0;
    try {
      while (written < total) {
        if (disposed) throw new Error(`Stdin write canceled by process disposal after ${written} of ${total} bytes`);
        const count = Math.min(total - written, buffer.byteLength);
        buffer.set(data.subarray(written, written + count));
        ovView.fill(0);
        writeHandle(ov, OVERLAPPED_HEVENT, writeEvent);
        const started = ffi.writeFile(parentStdinWrite, buffer, count, null, ov);
        if (!started) {
          const error = ffi.getLastError();
          if (error !== ERROR_IO_PENDING) throw new Error(`WriteFile(stdin) failed: ${error}, after ${written} of ${total} bytes`);
        }
        nativePending = true;
        let yielded = false;
        for (;;) {
          const completed = ffi.getOverlappedResult(parentStdinWrite, ov, transferred);
          const error = completed ? 0 : ffi.getLastError();
          if (!completed && error === ERROR_IO_INCOMPLETE) {
            if (disposed && cancellationError) cancelPendingWrite();
            yielded = true;
            await delay(IO_POLL_MS);
            continue;
          }
          // Only a terminal native result permits reuse/free of both buffers.
          nativePending = false;
          if (disposed) {
            const cancelDetail = cancellationError ? `; CancelIoEx failed: ${cancellationError}` : "";
            throw new Error(`Stdin write canceled by process disposal after ${written} of ${total} bytes (native result: ${error}${cancelDetail})`);
          }
          if (!completed) throw new Error(`GetOverlappedResult(stdin) failed: ${error}, after ${written} of ${total} bytes`);
          const countWritten = readU32(transferred, 0);
          if (countWritten === 0 || countWritten > count) throw new Error(`WriteFile(stdin) made invalid progress: ${countWritten} of ${count} bytes`);
          written += countWritten;
          break;
        }
        // A continuously readable child can complete every chunk immediately.
        // Bound work per turn so stdout readers, timers and control delivery run.
        if (!yielded && written < total) await delay(0);
      }
      return written;
    } finally {
      if (disposed) releaseStdin();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    ffi.closeHandle(hProcess);
    ffi.closeHandle(parentStdoutRead);
    // CancelIoEx only requests cancellation. The write's timer retains its
    // buffers, event and stdin handle until GetOverlappedResult is terminal.
    cancelPendingWrite();
    releaseStdin();
  }

  return {
    pid,

    readStdout(max: number): Uint8Array {
      if (disposed) return new Uint8Array(0);
      // Peek first — don't block if no data available
      const peekOk = ffi.peekNamedPipe(parentStdoutRead, null, 0, null, availBuf, null);
      if (!peekOk) return new Uint8Array(0);
      const avail = readU32(availBuf, 0);
      if (avail === 0) return new Uint8Array(0);
      const toRead = Math.min(avail, max);
      const buf = new Uint8Array(toRead);
      const ok = ffi.readFile(parentStdoutRead, buf.buffer, toRead, bytesBuf, null);
      if (!ok) return new Uint8Array(0);
      const n = readU32(bytesBuf, 0);
      return n === buf.length ? buf : buf.subarray(0, n);
    },

    writeStdin(data: Uint8Array): Promise<number> {
      if (disposed) return Promise.reject(new Error("Cannot write stdin after process disposal"));
      // Submit an idle write before a following control call can overtake it.
      const operation = writeTail ? writeTail.then(() => writeInput(data)) : writeInput(data);
      const result = operation.then((written) => {
        if (writeTail === settled) writeTail = null;
        return written;
      }, (error: unknown) => {
        if (writeTail === settled) writeTail = null;
        throw error;
      });
      const settled = result.then(() => {}, () => {});
      writeTail = settled;
      return result;
    },

    async sendCtrlBreak(): Promise<boolean> {
      if (disposed) return false;
      if (sharedConsole) {
        if (!ffi.generateConsoleCtrlEvent(1, pid)) {
          throw new Error(`GenerateConsoleCtrlEvent failed: ${ffi.getLastError()}`);
        }
        return true;
      }

      // The helper must run in another process; its URL selects source or compiled code.
      const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
      const helperUrl = new URL(`./console_control${extension}`, import.meta.url);
      const script = `const { sendCtrlBreakToConsole } = await import(${JSON.stringify(helperUrl.href)}); sendCtrlBreakToConsole(${pid});`;
      const args = !("Bun" in globalThis)
        ? ["--input-type=module", "-e", script]
        : ["-e", script];
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, args, { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }, (error, _stdout, stderr) => {
          if (error) reject(new Error(`CTRL+BREAK helper failed: ${stderr.trim() || error.message}`));
          else resolve();
        });
      });
      return true;
    },

    kill(): void {
      if (disposed) return;
      if (!ffi.terminateProcess(hProcess, 1)) {
        const error = ffi.getLastError();
        // TerminateProcess also fails if the child has already exited.
        if (ffi.waitForSingleObject(hProcess, 0) !== WAIT_OBJECT_0) {
          throw new Error(`TerminateProcess failed: ${error}`);
        }
      }
      dispose();
    },

    dispose,

    isAlive(): boolean {
      if (disposed) return false;
      const result = ffi.waitForSingleObject(hProcess, 0);
      if (result === WAIT_OBJECT_0) return false;
      if (result === WAIT_TIMEOUT) return true;
      if (result === WAIT_FAILED) {
        throw new Error(`WaitForSingleObject failed: ${ffi.getLastError()}`);
      }
      throw new Error(`Unexpected process wait result: ${result}`);
    },
  };
}
