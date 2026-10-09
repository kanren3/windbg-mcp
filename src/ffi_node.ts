import koffi from "koffi";
import type { Kernel32Ffi } from "./ffi.js";

const k32 = koffi.load("kernel32.dll");
const bytes = (buf: ArrayBuffer): Uint8Array => new Uint8Array(buf);

const CreatePipe = k32.func("__stdcall", "CreatePipe", "int", ["void *", "void *", "void *", "uint32"]);
const CreateNamedPipeW = k32.func("__stdcall", "CreateNamedPipeW", "uint64", ["void *", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "void *"]);
const CreateFileW = k32.func("__stdcall", "CreateFileW", "uint64", ["void *", "uint32", "uint32", "void *", "uint32", "uint32", "uint64"]);
const ConnectNamedPipe = k32.func("__stdcall", "ConnectNamedPipe", "int", ["uint64", "void *"]);
const CreateEventW = k32.func("__stdcall", "CreateEventW", "uint64", ["void *", "int", "int", "void *"]);
const GetOverlappedResult = k32.func("__stdcall", "GetOverlappedResult", "int", ["uint64", "void *", "void *", "int"]);
const CancelIoEx = k32.func("__stdcall", "CancelIoEx", "int", ["uint64", "void *"]);
const SetHandleInformation = k32.func("__stdcall", "SetHandleInformation", "int", ["uint64", "uint32", "uint32"]);
const CreateProcessW = k32.func("__stdcall", "CreateProcessW", "int", ["void *", "void *", "void *", "void *", "int", "uint32", "void *", "void *", "void *", "void *"]);
const CloseHandle = k32.func("__stdcall", "CloseHandle", "int", ["uint64"]);
const ReadFile = k32.func("__stdcall", "ReadFile", "int", ["uint64", "void *", "uint32", "void *", "void *"]);
const WriteFile = k32.func("__stdcall", "WriteFile", "int", ["uint64", "void *", "uint32", "void *", "void *"]);
const GetLastError = k32.func("__stdcall", "GetLastError", "uint32", []);
const GenerateConsoleCtrlEvent = k32.func("__stdcall", "GenerateConsoleCtrlEvent", "int", ["uint32", "uint32"]);
const TerminateProcess = k32.func("__stdcall", "TerminateProcess", "int", ["uint64", "uint32"]);
const WaitForSingleObject = k32.func("__stdcall", "WaitForSingleObject", "uint32", ["uint64", "uint32"]);
const PeekNamedPipe = k32.func("__stdcall", "PeekNamedPipe", "int", ["uint64", "void *", "uint32", "void *", "void *", "void *"]);
const GetConsoleProcessList = k32.func("__stdcall", "GetConsoleProcessList", "uint32", ["void *", "uint32"]);
const FreeConsole = k32.func("__stdcall", "FreeConsole", "int", []);
const AttachConsole = k32.func("__stdcall", "AttachConsole", "int", ["uint32"]);

export const kernel32Ffi: Kernel32Ffi = {
  createPipe: (readBuf, writeBuf, sa, size) => CreatePipe(bytes(readBuf), bytes(writeBuf), bytes(sa), size) !== 0,
  createNamedPipeW: (name, mode, pipeMode, instances, outSize, inSize, timeout) => BigInt(CreateNamedPipeW(bytes(name), mode, pipeMode, instances, outSize, inSize, timeout, null)),
  createFileW: (name, access, share, sa, disposition, flags) => BigInt(CreateFileW(bytes(name), access, share, bytes(sa), disposition, flags, 0n)),
  connectNamedPipe: (h, ov) => ConnectNamedPipe(h, bytes(ov)) !== 0,
  createEventW: () => BigInt(CreateEventW(null, 1, 0, null)),
  allocatePinnedBuffer: (size) => {
    const allocation = koffi.alloc("uint8", size);
    try {
      const buffer = koffi.view(allocation, size);
      let freed = false;
      return { buffer, free() { if (!freed) { freed = true; koffi.free(allocation); } } };
    } catch (error) {
      koffi.free(allocation);
      throw error;
    }
  },
  getOverlappedResult: (h, ov, transferred) => GetOverlappedResult(h, bytes(ov), bytes(transferred), 0) !== 0,
  cancelIoEx: (h, ov) => CancelIoEx(h, bytes(ov)) !== 0,
  setHandleInformation: (h, mask, flags) => SetHandleInformation(h, mask, flags) !== 0,
  createProcessW: (app, cmd, pa, ta, inherit, flags, env, cwd, si, pi) =>
    CreateProcessW(app, bytes(cmd), pa, ta, inherit ? 1 : 0, flags, env, cwd, bytes(si), bytes(pi)) !== 0,
  closeHandle: (h) => CloseHandle(h) !== 0,
  readFile: (h, buf, count, bytesBuf, ov) => ReadFile(h, bytes(buf), count, bytes(bytesBuf), ov) !== 0,
  writeFile: (h, buf, count, bytesBuf, ov) => WriteFile(h, buf, count, bytesBuf ? bytes(bytesBuf) : null, ov ? bytes(ov) : null) !== 0,
  getLastError: () => GetLastError(),
  generateConsoleCtrlEvent: (e, g) => GenerateConsoleCtrlEvent(e, g) !== 0,
  terminateProcess: (h, c) => TerminateProcess(h, c) !== 0,
  waitForSingleObject: (h, ms) => WaitForSingleObject(h, ms),
  peekNamedPipe: (h, buf, size, bytesBuf, availBuf, leftoverBuf) =>
    PeekNamedPipe(h, buf ? bytes(buf) : null, size, bytesBuf ? bytes(bytesBuf) : null, availBuf ? bytes(availBuf) : null, leftoverBuf ? bytes(leftoverBuf) : null) !== 0,
  getConsoleProcessList: (list, count) => GetConsoleProcessList(bytes(list), count),
  freeConsole: () => FreeConsole() !== 0,
  attachConsole: (pid) => AttachConsole(pid) !== 0,
};
