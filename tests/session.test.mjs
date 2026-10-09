import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const options = { skip: process.platform !== 'win32', timeout: 30000 };
let sessions;

async function openSession(t, { maxOutputBytes, executable = process.execPath, execArgs = ['-e', 'setInterval(() => {}, 1000)'] } = {}) {
  sessions ??= await import('../dist/session.js');
  let session;
  try {
    session = sessions.createCdbExecutableSession(executable, execArgs, {
      symbolsPath: process.env.SystemRoot,
      timeout: 10,
      maxOutputBytes,
    });
  } catch (error) {
    if (error.message.includes('Could not find cdb.exe')) {
      t.skip('Windows Debugging Tools are not installed');
      return;
    }
    throw error;
  }
  t.after(() => session.killSync());
  await session.start();
  return session;
}

async function targetPid(session) {
  const result = await session.execute('? @$tpid');
  const match = result.output.match(/Evaluate expression: (\d+)/);
  assert.ok(match, result.output);
  return Number(match[1]);
}

function stopTarget(pid) {
  try {
    process.kill(pid);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

test('preserves output without a newline, blank lines, and trailing spaces', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const result = await session.execute('.printf "VALUE=%d", 7');
  assert.equal(result.output, 'VALUE=7');
  assert.equal(result.completed, true);
  const whitespace = await session.execute('.printf " A \\n\\nB  "');
  assert.equal(whitespace.output, ' A \n\nB  ');
});

test('preserves prompt-shaped prefixes and suffixes in command output', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const result = await session.execute('.printf "0:000> payload\\n0:000> "');
  assert.equal(result.completed, true);
  assert.equal(result.output, '0:000> payload\n0:000> ');
});

test('pending snapshots retain prompt-shaped data through interruption', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  await session.execute('.printf "before\\n0:000> "\n.while (1) { .sleep 0n10 }', undefined, false);
  let snapshot;
  const deadline = Date.now() + 5000;
  do {
    await delay(50);
    snapshot = await session.execute(undefined, undefined, false);
  } while (snapshot.output !== 'before\n0:000> ' && Date.now() < deadline);
  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.output, 'before\n0:000> ');
  await session.interrupt();
  const completed = await session.execute();
  assert.equal(completed.completed, true);
  assert.equal(completed.output.slice(0, snapshot.output.length), snapshot.output);
});

test('completion markers preserve the selected expression evaluator', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  assert.equal((await session.execute('.expr /s c++')).completed, true);
  const result = await session.execute('.printf "%d", sizeof(void*)');
  assert.equal(result.completed, true);
  assert.equal(result.output, '8');
  assert.equal((await session.execute('.expr /s masm')).completed, true);
});

test('marker-like text cannot finish a multiline command or leak into the next result', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const result = await session.execute('.echo COMMAND_COMPLETED_MARKER_20\n.sleep 0n100\n.echo FIRST_DONE');
  assert.equal(result.completed, true);
  assert.match(result.output, /COMMAND_COMPLETED_MARKER_20/);
  assert.match(result.output, /FIRST_DONE/);
  const next = await session.execute('.echo SECOND_DONE');
  assert.match(next.output, /SECOND_DONE/);
  assert.doesNotMatch(next.output, /FIRST_DONE|COMMAND_COMPLETED_MARKER/);
});

test('concurrent commands in one session keep their results separate', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const [first, second] = await Promise.all([
    session.execute('.echo FIRST_RESULT'),
    session.execute('.echo SECOND_RESULT'),
  ]);
  assert.equal(first.output, 'FIRST_RESULT');
  assert.equal(second.output, 'SECOND_RESULT');
});

test('collect keeps the command captured before a queued successor starts', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const first = session.execute('.echo FIRST_CAPTURED\n.sleep 0n300');
  const second = session.execute('.echo SECOND_CAPTURED');
  const collected = session.execute();
  const [firstResult, secondResult, collectedResult] = await Promise.all([first, second, collected]);
  assert.equal(collectedResult.command, firstResult.command);
  assert.equal(collectedResult.output, firstResult.output);
  assert.equal(collectedResult.completed, true);
  assert.equal(collectedResult.state_after.ready_for_commands, true);
  assert.equal(secondResult.output, 'SECOND_CAPTURED');
  assert.doesNotMatch(collectedResult.output, /SECOND_CAPTURED/);
});

test('nonwaiting collect returns while the original wait remains pending', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  let settled = false;
  const waiting = session.execute('g', 5).finally(() => { settled = true; });
  const snapshot = await session.execute(undefined, undefined, false);
  const wasStillWaiting = !settled;
  await session.interrupt();
  const result = await waiting;
  assert.equal(wasStillWaiting, true);
  assert.equal(snapshot.command, 'g');
  assert.equal(snapshot.completed, false);
  assert.equal(result.completed, true);
});

test('pending snapshots include unterminated data without prompts or private markers', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const command = '.printf " A \\n\\nPROGRESS7  "\n.sleep 0n1200';
  const pending = await session.execute(command, 0.05);
  assert.equal(pending.completed, false);
  let snapshot;
  const deadline = Date.now() + 5000;
  do {
    await delay(50);
    snapshot = await session.execute(undefined, undefined, false);
  } while (!snapshot.output.includes('PROGRESS7  ') && Date.now() < deadline);
  assert.equal(snapshot.output, ' A \n\nPROGRESS7  ');
  assert.doesNotMatch(snapshot.output, /COMMAND_COMPLETED_MARKER|0:000>/);
  const completed = await session.execute(undefined, 5);
  assert.equal(completed.completed, true);
  assert.equal(completed.output, snapshot.output);
  assert.equal((await session.execute('.printf "%d", 7')).output, '7');
});

test('pending snapshots preserve single-character output', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  await session.execute('.printf "C"\n.while (1) { .sleep 0n10 }', undefined, false);
  let snapshot;
  const deadline = Date.now() + 5000;
  do {
    await delay(50);
    snapshot = await session.execute(undefined, undefined, false);
  } while (snapshot.output !== 'C' && Date.now() < deadline);
  assert.equal(snapshot.output, 'C');
  assert.equal(snapshot.completed, false);
  await session.interrupt();
  assert.equal((await session.execute()).completed, true);
});

test('real debugger output split across prompt and marker bytes stays command scoped', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  // Read real CDB bytes in small bursts, with a drain boundary between bursts.
  const nativeProcess = session.process;
  const readStdout = nativeProcess.readStdout.bind(nativeProcess);
  let drainBoundary = false;
  nativeProcess.readStdout = () => {
    if (drainBoundary) {
      drainBoundary = false;
      return new Uint8Array();
    }
    drainBoundary = true;
    return readStdout(5);
  };
  t.after(() => { nativeProcess.readStdout = readStdout; });
  const command = '.printf "0:000> 1234567  "\n.sleep 0n300';
  await session.execute(command, undefined, false);
  let result;
  let sawData = false;
  const deadline = Date.now() + 10000;
  do {
    await delay(50);
    result = await session.execute(undefined, undefined, false);
    sawData ||= result.output.includes('1234567');
    assert.doesNotMatch(result.output, /COMMAND_COMPLETED_MARKER/);
  } while (!result.completed && Date.now() < deadline);
  assert.equal(sawData, true);
  assert.equal(result.completed, true);
  assert.equal(result.output, '0:000> 1234567  ');
  nativeProcess.readStdout = readStdout;
  assert.equal((await session.execute('.echo AFTER_SPLIT')).output, 'AFTER_SPLIT');
});

test('wait expiry preserves a running command until explicit interruption', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const result = await session.execute('g', 0.05);
  assert.equal(result.completed, false);
  const state = await session.queryState();
  assert.equal(state.ready_for_commands, false);
  assert.equal(state.raw_status, null);
  assert.equal(state.running, null);
  await assert.rejects(session.execute('r'), Error);
  const interrupted = await session.interrupt();
  assert.equal(interrupted.ready_for_commands, true);
  const collected = await session.execute();
  assert.equal(collected.command, 'g');
  assert.equal(collected.completed, true);
  assert.equal((await session.execute('r')).completed, true);
});

test('interrupt bypasses a pending synchronous execute', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const waiting = session.execute('g');
  await delay(200);
  const interrupted = await session.interrupt();
  assert.equal(interrupted.ready_for_commands, true);
  assert.equal((await waiting).completed, true);
});

test('a successor cannot start while the native interrupt call is still in flight', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const nativeProcess = session.process;
  const sendCtrlBreak = nativeProcess.sendCtrlBreak.bind(nativeProcess);
  const { promise: held, resolve: release } = Promise.withResolvers();
  nativeProcess.sendCtrlBreak = async () => {
    const sent = await sendCtrlBreak();
    await held;
    return sent;
  };
  t.after(() => { release(); nativeProcess.sendCtrlBreak = sendCtrlBreak; });
  const waiting = session.execute('g', 5);
  const stop = session.interrupt();
  void stop.catch(() => {});
  assert.equal((await waiting).completed, true);
  const successor = session.execute('.echo AFTER_INTERRUPT_HELPER', undefined, false);
  void successor.catch(() => {});
  const duringHelper = await session.execute(undefined, undefined, false);
  release();
  assert.equal(duringHelper.command, 'g');
  assert.equal(duringHelper.completed, true);
  assert.equal((await stop).ready_for_commands, true);
  await successor;
  const afterHelper = await session.execute();
  assert.equal(afterHelper.command, '.echo AFTER_INTERRUPT_HELPER');
  assert.equal(afterHelper.output, 'AFTER_INTERRUPT_HELPER');
  assert.equal(afterHelper.completed, true);
});

test('an immediate interrupt after an awaited command applies to the new command', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  await assert.rejects(session.execute(' '), Error);
  assert.equal((await session.execute('? 1+1')).completed, true);
  const waiting = session.execute('g', 1);
  await session.interrupt();
  assert.equal((await waiting).completed, true);
  assert.equal((await session.queryState()).ready_for_commands, true);
});

test('an idle interrupt cannot mask a subsequent command interrupt', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const idle = session.interrupt();
  const waiting = session.execute('g', 1);
  const stop = session.interrupt();
  assert.notEqual(idle, stop);
  assert.equal((await idle).ready_for_commands, true);
  assert.equal((await stop).ready_for_commands, true);
  assert.equal((await waiting).completed, true);
  assert.equal((await session.queryState()).ready_for_commands, true);
});

test('detach from a running target waits for qd and preserves the target', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const pid = await targetPid(session);
  t.after(() => stopTarget(pid));
  assert.equal((await session.execute('g', undefined, false)).completed, false);
  await session.detach();
  process.kill(pid, 0);
  assert.equal(session.exited, true);
  const state = await session.queryState();
  assert.equal(state.ready_for_commands, false);
  assert.equal(state.requires_interrupt_before_command, false);
});

test('failed interrupt and detach leave a live target and pending command intact', options, async (t) => {
  const available = await openSession(t);
  if (!available) return;
  await available.close();
  const script = String.raw`
    import assert from 'node:assert/strict';
    import koffi from 'koffi';
    import { createCdbExecutableSession } from './dist/session.js';
    const kernel = koffi.load('kernel32.dll');
    const count = kernel.func('uint32_t GetConsoleProcessList(uint32_t *list, uint32_t count)');
    if (count(new Uint32Array(1), 1) === 0) {
      assert.notEqual(kernel.func('int AllocConsole()')(), 0);
    }
    const session = createCdbExecutableSession(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      symbolsPath: process.env.SystemRoot, timeout: 5,
    });
    process.on('exit', () => session.killSync());
    const watchdog = setTimeout(() => process.exit(2), 10000);
    try {
      await session.start();
      const pid = Number((await session.execute('? @$tpid')).output.match(/Evaluate expression: (\d+)/)[1]);
      await session.execute('g', undefined, false);
      assert.ok(count(new Uint32Array(1), 1) > 0);
      assert.notEqual(kernel.func('int FreeConsole()')(), 0);
      await assert.rejects(session.interrupt(), Error);
      assert.equal((await session.queryState()).ready_for_commands, false);
      await assert.rejects(session.detach(), Error);
      process.kill(pid, 0);
      assert.equal(session.exited, false);
      assert.equal((await session.execute(undefined, undefined, false)).completed, false);
      console.log('target-preserved');
    } finally {
      session.killSync();
      clearTimeout(watchdog);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /target-preserved/);
});

test('dump commands remain cancellable without inferring target execution state', options, async (t) => {
  const source = await openSession(t);
  if (!source) return;
  const directory = mkdtempSync(join(tmpdir(), 'windbg-mcp-test-'));
  let dump;
  t.after(() => {
    dump?.killSync();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const path = join(directory, 'target.dmp');
  assert.equal((await source.execute(`.dump /m "${path}"`)).completed, true);
  await source.close();
  dump = sessions.createCdbDumpSession(path, { symbolsPath: process.env.SystemRoot, timeout: 10 });
  await dump.start();
  const pending = await dump.execute('.echo LOOP_STARTED\n.while (1) { .sleep 0n10 }', undefined, false);
  assert.equal(pending.completed, false);
  await delay(200);
  const state = await dump.queryState();
  assert.equal(state.busy, true);
  assert.equal(state.running, null);
  assert.equal((await dump.interrupt()).ready_for_commands, true);
  const result = await dump.execute();
  assert.equal(result.completed, true);
  assert.match(result.output, /LOOP_STARTED/);
  await dump.close();
});

test('invalid redirected input leaves CDB and the previous command intact', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const pid = await targetPid(session);
  t.after(() => stopTarget(pid));
  const commands = [
    '', ' \t\r\n',
    '.echo BEFORE_CONTROL\n\u0002',
    '.echo ' + 'X'.repeat(4089),
    '.echo ' + '中'.repeat(1024),
  ];
  let previous = await session.execute('.printf "POLICY_READY"');
  for (const command of commands) {
    await assert.rejects(session.execute(command), Error, command);
    const collected = await session.execute();
    assert.equal(collected.command_id, previous.command_id, command);
    assert.equal(collected.output, previous.output, command);
    assert.equal(collected.completed, true, command);
    assert.equal((await session.queryState()).ready_for_commands, true, command);
    assert.equal(session.exited, false, command);
    process.kill(pid, 0);
    previous = await session.execute('.printf "POLICY_READY"');
    assert.equal(previous.output, 'POLICY_READY', command);
    assert.equal(previous.completed, true, command);
  }
  assert.equal(await targetPid(session), pid);
});

test('quoted text, ordinary multiline loops, and noninteractive shells remain usable', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  assert.equal((await session.execute('~0s')).completed, true);
  const literal = 'q .create .outmask';
  const quoted = await session.execute(`.printf "${literal}"`);
  assert.equal(quoted.completed, true);
  assert.equal(quoted.output, literal);
  const multiline = await session.execute(
    `.printf "BEGIN|"\n.for (r $t0=0; @$t0<3; r $t0=@$t0+1) { .printf "${literal}|" }\n.printf "END"`,
  );
  assert.equal(multiline.completed, true);
  assert.equal(multiline.output, `BEGIN|${`${literal}|`.repeat(3)}END`);
  const shell = await session.execute('.shell -i- cmd.exe /c echo NONINTERACTIVE_SHELL_WITNESS');
  assert.equal(shell.completed, true);
  assert.match(shell.output, /NONINTERACTIVE_SHELL_WITNESS/);
  assert.equal(shell.state_after.ready_for_commands, true);
  assert.equal(session.exited, false);
  assert.equal((await session.execute('.printf "AFTER_SHELL"')).output, 'AFTER_SHELL');
});

test('CDB launch preserves TAB, empty, quote, and trailing-backslash arguments in an owned Node target', options, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'windbg-mcp-argv-'));
  let session;
  let pid;
  t.after(() => {
    session?.killSync();
    if (pid !== undefined) stopTarget(pid);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true });
  assert.equal(node.status, 0, node.stderr || node.error?.message);
  const script = join(directory, 'record-argv.cjs');
  const record = join(directory, 'argv.json');
  writeFileSync(script, `
    const { renameSync, writeFileSync } = require('node:fs');
    const temporary = process.argv[2] + '.tmp';
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, argv: process.argv.slice(3) }));
    renameSync(temporary, process.argv[2]);
    setInterval(() => {}, 1000);
  `);
  const argv = ['tab\tseparated', '', 'embedded"quote', 'slash\\"quote', 'path with spaces\\', 'plain\\', ''];
  session = await openSession(t, { executable: node.stdout.trim(), execArgs: [script, record, ...argv] });
  if (!session) return;
  pid = await targetPid(session);
  assert.equal((await session.execute('g', undefined, false)).completed, false);
  const deadline = Date.now() + 5000;
  while (!existsSync(record) && Date.now() < deadline) await delay(25);
  assert.equal(existsSync(record), true, 'owned target must record its actual argv');
  const witness = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(witness.pid, pid);
  assert.deepEqual(witness.argv, argv);
  process.kill(pid, 0);
  assert.equal((await session.interrupt()).ready_for_commands, true);
  assert.equal((await session.execute()).completed, true);
  await session.close();
});

test('command pagination reconstructs real CDB output with stable identity and refuses stale cursors', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const count = 9000;
  const expected = Array.from({ length: count }, (_, index) => `PAGE${String(index).padStart(4, '0')}|`).join('');
  const totalBytes = Buffer.byteLength(expected, 'utf8');
  const command = `.for (r $t0=0; @$t0<0n${count}; r $t0=@$t0+1) { .printf "PAGE%04d|", @$t0 }`;
  const first = await session.execute(command, 20);
  assert.equal(first.completed, true);
  assert.equal(first.has_more_output, true);
  assert.equal(first.output_offset, 0);
  assert.ok(first.command_id.length > 0);
  const chunks = [];
  let offset = 0;
  let page = first;
  do {
    assert.equal(page.command_id, first.command_id);
    assert.equal(page.command, command);
    assert.equal(page.completed, true);
    assert.equal(page.output_error, undefined);
    assert.equal(page.output_offset, offset);
    assert.equal(page.total_output_bytes, totalBytes);
    const pageBytes = Buffer.byteLength(page.output, 'utf8');
    assert.ok(pageBytes > 0 && pageBytes <= (page === first ? 65536 : 4096));
    assert.equal(page.next_output_offset, offset + pageBytes);
    assert.equal(page.has_more_output, page.next_output_offset < totalBytes);
    chunks.push(page.output);
    offset = page.next_output_offset;
    if (!page.has_more_output) break;
    page = await session.execute(undefined, undefined, true, {
      command_id: first.command_id, output_offset: offset, max_output_bytes: 4096,
    });
  } while (true);
  assert.equal(chunks.join(''), expected);
  assert.equal(offset, totalBytes);
  const end = await session.execute(undefined, undefined, true, {
    command_id: first.command_id, output_offset: offset, max_output_bytes: 4096,
  });
  assert.equal(end.command_id, first.command_id);
  assert.equal(end.output, '');
  assert.equal(end.output_offset, totalBytes);
  assert.equal(end.next_output_offset, totalBytes);
  assert.equal(end.total_output_bytes, totalBytes);
  assert.equal(end.has_more_output, false);
  const next = await session.execute('.printf "NEW_COMMAND_OUTPUT"');
  assert.notEqual(next.command_id, first.command_id);
  for (const staleOffset of [0, first.next_output_offset]) {
    await assert.rejects(session.execute(undefined, undefined, true, {
      command_id: first.command_id, output_offset: staleOffset, max_output_bytes: 4096,
    }), Error);
  }
  const current = await session.execute(undefined, undefined, true, { command_id: next.command_id });
  assert.equal(current.command_id, next.command_id);
  assert.equal(current.output, 'NEW_COMMAND_OUTPUT');
});

test('a low output quota reports capture failure without blocking interruption, completion, or later commands', options, async (t) => {
  const maxOutputBytes = 1024;
  const session = await openSession(t, { maxOutputBytes });
  if (!session) return;
  const payload = 'QUOTA_OUTPUT_'.repeat(16);
  const started = await session.execute(`.while (1) { .printf "${payload}"; .sleep 0n10 }`, undefined, false);
  assert.equal(started.completed, false);
  let failed;
  const deadline = Date.now() + 5000;
  do {
    await delay(25);
    failed = await session.execute(undefined, undefined, false, { command_id: started.command_id });
  } while (failed.output_error === undefined && Date.now() < deadline);
  assert.equal(typeof failed.output_error, 'string');
  assert.equal(failed.completed, false);
  assert.equal(failed.command_id, started.command_id);
  assert.ok(failed.total_output_bytes <= maxOutputBytes);
  assert.equal(Buffer.byteLength(failed.output, 'utf8'), failed.total_output_bytes);
  assert.equal(failed.has_more_output, false);
  assert.equal(session.exited, false);
  assert.equal((await session.queryState()).ready_for_commands, false);
  assert.equal((await session.interrupt()).ready_for_commands, true);
  const interrupted = await session.execute(undefined, undefined, true, { command_id: started.command_id });
  assert.equal(interrupted.completed, true);
  assert.equal(interrupted.output_error, failed.output_error);
  assert.equal(interrupted.output, failed.output);
  assert.equal(interrupted.total_output_bytes, failed.total_output_bytes);
  const recovered = await session.execute('.printf "AFTER_QUOTA_INTERRUPT"');
  assert.equal(recovered.completed, true);
  assert.equal(recovered.output_error, undefined);
  assert.equal(recovered.output, 'AFTER_QUOTA_INTERRUPT');
  const finite = await session.execute(`.for (r $t0=0; @$t0<0n64; r $t0=@$t0+1) { .printf "${payload}" }`);
  assert.equal(finite.completed, true);
  assert.equal(typeof finite.output_error, 'string');
  assert.ok(finite.total_output_bytes <= maxOutputBytes);
  assert.equal(Buffer.byteLength(finite.output, 'utf8'), finite.total_output_bytes);
  assert.equal(finite.state_after.ready_for_commands, true);
  assert.equal(session.exited, false);
  const final = await session.execute('.printf "AFTER_QUOTA_COMPLETION"');
  assert.equal(final.completed, true);
  assert.equal(final.output_error, undefined);
  assert.equal(final.output, 'AFTER_QUOTA_COMPLETION');
});

test('temporary-file cleanup failures do not misreport successful detachment', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const pid = await targetPid(session);
  t.after(() => stopTarget(pid));
  const captured = await session.execute('.echo CLEANUP_WITNESS');
  const name = readdirSync(tmpdir()).find((entry) => entry.startsWith(`windbg-mcp-output-${captured.command_id}-`));
  assert.equal(typeof name, 'string');
  const directory = join(tmpdir(), name);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const preserved = join(directory, 'separate-file.txt');
  writeFileSync(preserved, 'preserve this file');
  await session.execute('g', undefined, false);
  await session.detach();
  assert.equal(session.exited, true);
  assert.equal(typeof session.outputCleanupError, 'string');
  process.kill(pid, 0);
  assert.equal(readFileSync(preserved, 'utf8'), 'preserve this file');
});

test('blank lines and a trailing newline do not repeat debugger commands', options, async (t) => {
  const session = await openSession(t);
  if (!session) return;
  const result = await session.execute(' \r\n.echo FIRST\n\n.echo SECOND\r\n\t\n');
  assert.equal(result.completed, true);
  assert.equal(result.output, 'FIRST\nSECOND');
  const boundary = await session.execute('.echo ' + 'X'.repeat(4088));
  assert.equal(boundary.completed, true);
  assert.equal(boundary.output, 'X'.repeat(4088));
  await assert.rejects(session.execute('.echo ' + 'X'.repeat(4089)), Error);
  assert.equal((await session.execute('.echo AFTER_LINE_LIMIT')).output, 'AFTER_LINE_LIMIT');
});
