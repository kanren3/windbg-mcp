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
  writeFile(handle: bigint, buf: ArrayBuffer, count: number, bytesBuf: ArrayBuffer, overlapped: null): boolean;
  getLastError(): number;
  generateConsoleCtrlEvent(event: number, processGroupId: number): boolean;
  terminateProcess(handle: bigint, exitCode: number): boolean;
  waitForSingleObject(handle: bigint, ms: number): number;
  peekNamedPipe(handle: bigint, buf: ArrayBuffer | null, size: number, bytesBuf: ArrayBuffer | null, availBuf: ArrayBuffer | null, leftoverBuf: ArrayBuffer | null): boolean;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export const kernel32Ffi: Kernel32Ffi = isBun
  ? (await import("./ffi_bun.js")).kernel32Ffi
  : (await import("./ffi_node.js")).kernel32Ffi;
