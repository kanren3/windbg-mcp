export interface Kernel32Ffi {
  createPipe(readBuf: ArrayBuffer, writeBuf: ArrayBuffer, sa: ArrayBuffer, size: number): boolean;
  setHandleInformation(handle: bigint, mask: number, flags: number): boolean;
  createProcessW(
    appName: null, commandLine: ArrayBuffer, processAttrs: null, threadAttrs: null,
    inheritHandles: boolean, creationFlags: number, env: null, cwd: null,
    startupInfo: ArrayBuffer, processInfo: ArrayBuffer,
  ): boolean;
  closeHandle(handle: bigint): boolean;
  readFile(handle: bigint, buf: ArrayBuffer, count: number, bytesBuf: ArrayBuffer, overlapped: null): boolean;
  writeFile(handle: bigint, buf: Uint8Array, count: number, bytesBuf: ArrayBuffer, overlapped: null): boolean;
  getLastError(): number;
  generateConsoleCtrlEvent(event: number, processGroupId: number): boolean;
  terminateProcess(handle: bigint, exitCode: number): boolean;
  waitForSingleObject(handle: bigint, ms: number): number;
  peekNamedPipe(handle: bigint, buf: ArrayBuffer | null, size: number, bytesBuf: ArrayBuffer | null, availBuf: ArrayBuffer | null, leftoverBuf: ArrayBuffer | null): boolean;
  getConsoleProcessList(processList: ArrayBuffer, count: number): number;
  /** Used only by the isolated control helper, never by the MCP host. */
  freeConsole(): boolean;
  attachConsole(pid: number): boolean;
}

// The manually encoded Win32 structures and HANDLE arguments use the 64-bit ABI.
if (process.arch !== "x64" && process.arch !== "arm64") {
  throw new Error(`Win32 FFI requires x64 or arm64; received ${process.arch}`);
}

const isBun = "Bun" in globalThis;
// Bun's native FFI module cannot be loaded by Node; select the runtime backend here.

export const kernel32Ffi: Kernel32Ffi = isBun
  ? (await import("./ffi_bun.js")).kernel32Ffi
  : (await import("./ffi_node.js")).kernel32Ffi;
