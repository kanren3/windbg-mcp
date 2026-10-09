import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandOutput,
  DEFAULT_OUTPUT_PAGE_BYTES,
  MAX_OUTPUT_PAGE_BYTES,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../dist/command_output.js";

async function ownedDirectories(output) {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && entry.name.includes(output.id))
    .map((entry) => join(tmpdir(), entry.name));
}

async function outputDirectory(output) {
  const directories = await ownedDirectories(output);
  assert.equal(directories.length, 1, "Expected exactly one command-owned temporary directory");
  return directories[0];
}

async function readAllPages(output, maxBytes) {
  const pages = [];
  let offset = 0;
  do {
    const page = await output.readPage(offset, maxBytes);
    assert.equal(page.output_offset, offset);
    assert.ok(Buffer.byteLength(page.output, "utf8") <= maxBytes);
    assert.equal(page.next_output_offset, offset + Buffer.byteLength(page.output, "utf8"));
    pages.push(page.output);
    offset = page.next_output_offset;
    if (!page.has_more_output) {
      assert.equal(offset, page.total_output_bytes);
      return pages.join("");
    }
    assert.ok(page.output.length > 0, "A non-final page must make progress");
  } while (true);
}

test("output storage is lazy and gives each command a stable unique id", async () => {
  const output = new CommandOutput();
  const other = new CommandOutput();
  try {
    assert.notEqual(output.id, other.id);
    assert.match(output.id, /^[0-9a-f-]{36}$/);
    assert.equal(DEFAULT_OUTPUT_PAGE_BYTES, 65_536);
    assert.equal(MAX_OUTPUT_PAGE_BYTES, 262_144);
    assert.equal(MAX_COMMAND_OUTPUT_BYTES, 268_435_456);
    assert.deepEqual(await output.readPage(), {
      output: "", output_offset: 0, next_output_offset: 0,
      total_output_bytes: 0, has_more_output: false,
    });
    await output.append("");
    assert.deepEqual(await ownedDirectories(output), []);
  } finally {
    await Promise.all([output.close(), other.close()]);
  }
});

test("more than six MiB reconstructs exactly through bounded Unicode pages", async () => {
  const output = new CommandOutput();
  const id = output.id;
  const chunk = "Aé中😀\n".repeat(8192);
  const expectedHash = createHash("sha256");
  let totalBytes = 0;
  try {
    for (let index = 0; index < 72; index++) {
      await output.append(chunk);
      expectedHash.update(chunk, "utf8");
      totalBytes += Buffer.byteLength(chunk, "utf8");
    }
    assert.ok(totalBytes > 6 * 1024 * 1024);
    const directory = await outputDirectory(output);
    assert.deepEqual(await readdir(directory), ["output.bin"]);
    const actualHash = createHash("sha256");
    let offset = 0;
    let pageCount = 0;
    while (offset < totalBytes) {
      const page = await output.readPage(offset);
      const pageBytes = Buffer.byteLength(page.output, "utf8");
      assert.equal(output.id, id);
      assert.equal(page.output_offset, offset);
      assert.equal(page.total_output_bytes, totalBytes);
      assert.ok(pageBytes > 0 && pageBytes <= 65_536);
      assert.equal(page.next_output_offset, offset + pageBytes);
      assert.equal(page.has_more_output, page.next_output_offset < totalBytes);
      assert.ok(!page.output.includes("\ufffd"));
      actualHash.update(page.output, "utf8");
      offset = page.next_output_offset;
      pageCount++;
    }
    assert.ok(pageCount > 96);
    assert.equal(actualHash.digest("hex"), expectedHash.digest("hex"));
    assert.equal((await output.readPage(totalBytes)).output, "");
    await output.close();
    await assert.rejects(access(directory), { code: "ENOENT" });
  } finally {
    await output.close();
  }
});

test("small pages stop at full UTF-8 characters and append uses bounded encoding chunks", async () => {
  const output = new CommandOutput();
  const chunked = new CommandOutput();
  try {
    await output.append("aé中😀z");
    assert.equal((await output.readPage(0, 4)).output, "aé");
    assert.equal((await output.readPage(3, 4)).output, "中");
    assert.equal((await output.readPage(6, 4)).output, "😀");
    assert.equal(await readAllPages(output, 4), "aé中😀z");
    const text = "x".repeat(16_383) + "😀" + "é".repeat(32_769) + "\ud800!\udc00";
    await chunked.append(text);
    assert.equal(await readAllPages(chunked, 4097), Buffer.from(text, "utf8").toString("utf8"));
  } finally {
    await Promise.all([output.close(), chunked.close()]);
  }
});

test("offsets are byte offsets and reject malformed ranges or continuation bytes", async () => {
  const output = new CommandOutput();
  try {
    await output.append("Aé中😀Z");
    for (const offset of [0, 1, 3, 6, 10, 11]) {
      const page = await output.readPage(offset, 4);
      assert.equal(page.output_offset, offset);
    }
    for (const offset of [2, 4, 5, 7, 8, 9]) {
      await assert.rejects(output.readPage(offset, 4), /UTF-8 character boundary/);
    }
    for (const offset of [-1, 12, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(output.readPage(offset), RangeError);
    }
    for (const maxBytes of [-1, 0, 1, 2, 3, 4.5, NaN, Infinity, MAX_OUTPUT_PAGE_BYTES + 1]) {
      await assert.rejects(output.readPage(0, maxBytes), RangeError);
    }
    assert.equal((await output.readPage(0, MAX_OUTPUT_PAGE_BYTES)).output, "Aé中😀Z");
    assert.equal(await readAllPages(output, 4), "Aé中😀Z");
  } finally {
    await output.close();
  }
});

test("quota is explicit, preflighted, and never truncates accepted output", async () => {
  const output = new CommandOutput({ maxBytes: 3 });
  const empty = new CommandOutput({ maxBytes: 0 });
  try {
    await assert.rejects(output.append("😀"), /storage quota exceeded.*4 incoming bytes.*3 bytes/);
    assert.deepEqual(await ownedDirectories(output), []);
    await output.append("é");
    await assert.rejects(output.append("中"), /2 stored bytes.*3 incoming bytes.*3 bytes/);
    assert.equal((await output.readPage()).output, "é");
    assert.equal((await output.readPage()).total_output_bytes, 2);
    await output.append("a");
    assert.equal((await output.readPage()).output, "éa");
    const directory = await outputDirectory(output);
    assert.equal(await readFile(join(directory, "output.bin"), "utf8"), "éa");
    await assert.rejects(output.append("b"), /storage quota exceeded/);
    await empty.append("");
    await assert.rejects(empty.append("a"), /storage quota exceeded/);
    assert.deepEqual(await ownedDirectories(empty), []);
    for (const maxBytes of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new CommandOutput({ maxBytes }), RangeError);
    }
  } finally {
    await Promise.all([output.close(), empty.close()]);
  }
});

test("queued appends and reads preserve operation order and page snapshots", async () => {
  const output = new CommandOutput();
  try {
    const results = await Promise.all([
      output.append("α"),
      output.readPage(),
      output.append("😀"),
      output.readPage(),
      output.append("中"),
      output.readPage(),
    ]);
    assert.equal(results[1].output, "α");
    assert.equal(results[1].total_output_bytes, 2);
    assert.equal(results[3].output, "α😀");
    assert.equal(results[3].total_output_bytes, 6);
    assert.equal(results[5].output, "α😀中");
    assert.equal(results[5].total_output_bytes, 9);
  } finally {
    await output.close();
  }
});

test("close is idempotent, removes its own storage, and rejects all later access", async () => {
  const output = new CommandOutput();
  const other = new CommandOutput();
  try {
    await Promise.all([output.append("closed output"), other.append("still open")]);
    const directory = await outputDirectory(output);
    const otherDirectory = await outputDirectory(other);
    const closing = output.close();
    assert.equal(output.close(), closing);
    await closing;
    await assert.rejects(access(directory), { code: "ENOENT" });
    await access(otherDirectory);
    assert.equal((await other.readPage()).output, "still open");
    await assert.rejects(output.append("later"), /closed/);
    await assert.rejects(output.readPage(), /closed/);
    output.closeSync();
  } finally {
    await Promise.all([output.close(), other.close()]);
  }
});

test("close does not recursively delete unexpected files", async () => {
  const output = new CommandOutput();
  let directory;
  let unrelated;
  try {
    await output.append("owned");
    directory = await outputDirectory(output);
    unrelated = join(directory, "test-owned-unrelated.txt");
    await writeFile(unrelated, "preserve me");
    await assert.rejects(output.close(), AggregateError);
    assert.equal(await readFile(unrelated, "utf8"), "preserve me");
    await assert.rejects(access(join(directory, "output.bin")), { code: "ENOENT" });
  } finally {
    if (unrelated) await unlink(unrelated).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    output.closeSync();
    if (directory) await assert.rejects(access(directory), { code: "ENOENT" });
  }
});

test("close during lazy creation drains callbacks before cleanup", async () => {
  const output = new CommandOutput();
  try {
    const append = output.append("a".repeat(131_072));
    const queuedPage = output.readPage();
    // The operation starts lazy mkdtemp before this microtask resumes.
    await Promise.resolve();
    const closing = output.close();
    const results = await Promise.allSettled([append, queuedPage]);
    assert.ok(results.every((result) => result.status === "rejected" && /closed/.test(result.reason.message)));
    await closing;
    assert.deepEqual(await ownedDirectories(output), []);
  } finally {
    await output.close();
  }
});

test("close during queued append and in-flight page read safely releases storage", async () => {
  for (const operation of ["append", "read"]) {
    const output = new CommandOutput();
    try {
      await output.append("Aé中😀".repeat(32_768));
      const directory = await outputDirectory(output);
      const pending = operation === "append"
        ? output.append("😀".repeat(262_144))
        : output.readPage(0, MAX_OUTPUT_PAGE_BYTES);
      const queued = output.append("never accepted after close");
      await Promise.resolve();
      await Promise.resolve();
      const closing = output.close();
      const results = await Promise.allSettled([pending, queued]);
      assert.ok(results.every((result) => result.status === "rejected" && /closed/.test(result.reason.message)));
      await closing;
      await assert.rejects(access(directory), { code: "ENOENT" });
    } finally {
      await output.close();
    }
  }
});

test("closeSync cleans idle storage immediately and defers pending callbacks", async () => {
  const idle = new CommandOutput();
  try {
    await idle.append("idle");
    const directory = await outputDirectory(idle);
    idle.closeSync();
    await assert.rejects(access(directory), { code: "ENOENT" });
    await assert.rejects(idle.readPage(), /closed/);
  } finally {
    await idle.close();
  }

  for (const phase of ["create", "append", "read"]) {
    const output = new CommandOutput();
    try {
      if (phase !== "create") await output.append("ready".repeat(16_384));
      const pending = phase === "read" ? output.readPage() : output.append("😀".repeat(131_072));
      await Promise.resolve();
      await Promise.resolve();
      output.closeSync();
      await assert.rejects(pending, /closed/);
      await output.close();
      assert.deepEqual(await ownedDirectories(output), []);
      await assert.rejects(output.append("later"), /closed/);
    } finally {
      await output.close();
    }
  }
});
