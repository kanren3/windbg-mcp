import { randomUUID } from "node:crypto";
import {
  close as closeFile,
  closeSync as closeFileSync,
  mkdtemp,
  open,
  read,
  rmdir,
  rmdirSync,
  unlink,
  unlinkSync,
  write,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_OUTPUT_PAGE_BYTES = 65_536;
export const MAX_OUTPUT_PAGE_BYTES = 262_144;
export const MAX_COMMAND_OUTPUT_BYTES = 268_435_456;

const WRITE_BUFFER_BYTES = 65_536;
const ENCODE_CHUNK_CHARACTERS = 16_384;
const encoder = new TextEncoder();

export interface OutputPage {
  output: string;
  output_offset: number;
  next_output_offset: number;
  total_output_bytes: number;
  has_more_output: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** File-backed UTF-8 output. Operations are ordered, including cleanup. */
export class CommandOutput {
  readonly id = randomUUID();
  private readonly maxBytes: number;
  private totalBytes = 0;
  private directory: string | null = null;
  private filePath: string | null = null;
  private fd: number | null = null;
  private closed = false;
  private activeOperation = false;
  private storageError: Error | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MAX_COMMAND_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) {
      throw new RangeError("maxBytes must be a nonnegative safe integer");
    }
  }

  append(text: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertReadable();
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength > this.maxBytes - this.totalBytes) {
        throw new Error(
          `Command output storage quota exceeded for ${this.id}: ` +
          `${this.totalBytes} stored bytes + ${byteLength} incoming bytes exceed ${this.maxBytes} bytes`,
        );
      }
      if (byteLength === 0) return;

      try {
        const fd = await this.ensureFile();
        const buffer = Buffer.allocUnsafe(WRITE_BUFFER_BYTES);
        let characterOffset = 0;
        let byteOffset = this.totalBytes;
        while (characterOffset < text.length) {
          let end = Math.min(characterOffset + ENCODE_CHUNK_CHARACTERS, text.length);
          // A chunk must not turn one surrogate pair into two replacement characters.
          if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 &&
              text.charCodeAt(end - 1) <= 0xdbff && text.charCodeAt(end) >= 0xdc00 &&
              text.charCodeAt(end) <= 0xdfff) end--;
          const encoded = encoder.encodeInto(text.slice(characterOffset, end), buffer);
          let written = 0;
          while (written < encoded.written) {
            const { promise, resolve, reject } = Promise.withResolvers<number>();
            write(fd, buffer, written, encoded.written - written, byteOffset,
              (error, bytesWritten) => error ? reject(error) : resolve(bytesWritten));
            const count = await promise;
            this.assertOpen();
            if (count === 0) throw new Error("Output storage write made no progress");
            written += count;
            byteOffset += count;
          }
          characterOffset += encoded.read;
        }
        this.totalBytes = byteOffset;
      } catch (error) {
        if (this.closed) throw error;
        // An incomplete write may end inside a UTF-8 character. Do not expose it as a page.
        this.storageError = new Error(
          `Command output storage failed for ${this.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        throw this.storageError;
      }
    });
  }

  readPage(offset = 0, maxBytes = DEFAULT_OUTPUT_PAGE_BYTES): Promise<OutputPage> {
    return this.enqueue(async () => {
      this.assertReadable();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.totalBytes) {
        throw new RangeError(`output offset must be an integer between 0 and ${this.totalBytes}`);
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > MAX_OUTPUT_PAGE_BYTES) {
        throw new RangeError(`maxBytes must be an integer between 4 and ${MAX_OUTPUT_PAGE_BYTES}`);
      }

      let output = "";
      let nextOffset = offset;
      if (offset < this.totalBytes) {
        const fd = this.fd;
        if (fd === null) throw new Error("Command output storage is unavailable");
        // One lookahead byte determines whether the requested page ends inside a character.
        const length = Math.min(maxBytes + 1, this.totalBytes - offset);
        const buffer = Buffer.allocUnsafe(length);
        let received = 0;
        while (received < length) {
          const { promise, resolve, reject } = Promise.withResolvers<number>();
          read(fd, buffer, received, length - received, offset + received,
            (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
          const count = await promise;
          this.assertOpen();
          if (count === 0) throw new Error("Command output storage ended before the recorded output length");
          received += count;
        }
        if (isContinuation(buffer[0])) {
          throw new RangeError("output offset must be on a UTF-8 character boundary");
        }
        let pageLength = Math.min(maxBytes, length);
        if (pageLength < length) {
          while (isContinuation(buffer[pageLength])) pageLength--;
        }
        output = buffer.toString("utf8", 0, pageLength);
        nextOffset += pageLength;
      }
      return {
        output,
        output_offset: offset,
        next_output_offset: nextOffset,
        total_output_bytes: this.totalBytes,
        has_more_output: nextOffset < this.totalBytes,
      };
    });
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closePromise === null) {
      this.closePromise = this.enqueue(() => this.releaseStorage(), false);
    }
    return this.closePromise;
  }

  /**
   * Emergency best-effort cleanup. Pending I/O retains its descriptor and buffers
   * until its callback completes; cleanup is then asynchronous. A hard process
   * exit before those callbacks run can leave temporary files behind.
   */
  closeSync(): void {
    this.closed = true;
    if (this.activeOperation) {
      void this.close();
      return;
    }
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      try { closeFileSync(fd); } catch { /* Emergency cleanup cannot report an error. */ }
    }
    if (this.filePath !== null) {
      try {
        unlinkSync(this.filePath);
        this.filePath = null;
      } catch (error) {
        if (isMissing(error)) this.filePath = null;
      }
    }
    if (this.directory !== null) {
      try {
        rmdirSync(this.directory);
        this.directory = null;
      } catch (error) {
        if (isMissing(error)) this.directory = null;
      }
    }
    // Retry any filesystem cleanup that could not complete synchronously.
    if (this.filePath !== null || this.directory !== null) void this.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Command output ${this.id} is closed`);
  }

  private assertReadable(): void {
    this.assertOpen();
    if (this.storageError !== null) throw this.storageError;
  }

  private enqueue<T>(operation: () => Promise<T>, requireOpen = true): Promise<T> {
    const result = this.queue.then(async () => {
      if (requireOpen) this.assertOpen();
      this.activeOperation = true;
      try {
        return await operation();
      } finally {
        this.activeOperation = false;
      }
    });
    // Internal queue and emergency cleanup never produce unhandled rejections.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureFile(): Promise<number> {
    if (this.fd !== null) return this.fd;
    try {
      const directoryReady = Promise.withResolvers<string>();
      mkdtemp(join(tmpdir(), `windbg-mcp-output-${this.id}-`),
        (error, directory) => error ? directoryReady.reject(error) : directoryReady.resolve(directory));
      this.directory = await directoryReady.promise;
      this.assertOpen();
      this.filePath = join(this.directory, "output.bin");
      const fileReady = Promise.withResolvers<number>();
      open(this.filePath!, "wx+", 0o600,
        (error, fd) => error ? fileReady.reject(error) : fileReady.resolve(fd));
      this.fd = await fileReady.promise;
      this.assertOpen();
      return this.fd;
    } catch (error) {
      try {
        await this.releaseStorage();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Command output setup and cleanup failed");
      }
      throw error;
    }
  }

  private async releaseStorage(): Promise<void> {
    const errors: unknown[] = [];
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        closeFile(fd, (error) => error ? reject(error) : resolve());
        await promise;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.filePath !== null) {
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        unlink(this.filePath!, (error) => error ? reject(error) : resolve());
        await promise;
        this.filePath = null;
      } catch (error) {
        if (isMissing(error)) this.filePath = null;
        else errors.push(error);
      }
    }
    if (this.directory !== null) {
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        rmdir(this.directory!, (error) => error ? reject(error) : resolve());
        await promise;
        this.directory = null;
      } catch (error) {
        if (isMissing(error)) this.directory = null;
        else errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Command output cleanup failed");
  }
}
