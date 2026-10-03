import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, toMyWhoosh } from '../src/workout.js';
const cli = new URL('../bin/whoosh.js', import.meta.url);
import { fileURLToPath } from 'node:url';
/**
 * Run the CLI in a child process with a supplied stdin and environment overrides.
 * @param {string[]} args - CLI arguments.
 * @param {string} [input] - Standard input text.
 * @param {object} [env] - Environment overrides; real token inheritance is disabled.
 * @returns {object} Synchronous process result including output and exit status.
 */
function run(args, input, env = {}) {
  return spawnSync(process.execPath, [fileURLToPath(cli), ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, MYWHOOSH_TOKEN: '', ...env }
  });
}
test('package exposes the whoosh-uploader command', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  const lock = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
  );
  assert.equal(manifest.name, 'whoosh-uploader');
  assert.deepEqual(manifest.bin, { 'whoosh-uploader': 'bin/whoosh.js' });
  assert.deepEqual(lock.packages[''].bin, manifest.bin);
  assert.equal(
    existsSync(
      new URL(`../${manifest.bin['whoosh-uploader']}`, import.meta.url)
    ),
    true
  );
});
test('stdin pipeline validates and dry-run needs no authentication', () => {
  const input = JSON.stringify({
    version: 1,
    name: 'stdin',
    ftp_watts: 200,
    steps: [{ seconds: 60, watts: 150 }]
  });
  const validation = run(['validate', '-'], input);
  assert.equal(validation.status, 0);
  assert.equal(JSON.parse(validation.stdout).duration_seconds, 60);
  const dryRun = run(['upload', '-', '--dry-run'], input, {
    MYWHOOSH_TOKEN: 'invalid'
  });
  assert.equal(dryRun.status, 0);
  const output = JSON.parse(dryRun.stdout);
  assert.equal(output.status, 'dry_run');
  assert.deepEqual(output.payload, toMyWhoosh(compile(JSON.parse(input))));
  assert.equal(output.verified, undefined);
  assert.equal(output.remote_id, undefined);
});
test('bad input exits nonzero with machine-readable error', () => {
  const result = run(['validate', '-'], 'not json');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_JSON');
  const buildResult = run(['build', '-', '--format', 'unknown'], '{}');
  assert.equal(buildResult.status, 2);
});

test('delete requires an exact numeric ID before authentication', () => {
  for (const args of [
    ['delete'],
    ['delete', 'oldest'],
    ['delete', '../1'],
    ['delete', '1', '2']
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'USAGE');
  }
});

test('help is available offline for every command and auth subcommand', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'whoosh-help-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    MYWHOOSH_TOKEN: 'invalid',
    WHOOSH_CONFIG_DIR: join(directory, 'session')
  };
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const result = run(args, undefined, env);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /whoosh-uploader <command> --help/);
  }
  for (const topic of [
    'validate',
    'build',
    'upload',
    'list',
    'delete',
    'auth',
    'auth login',
    'auth import',
    'auth status',
    'auth clear'
  ]) {
    const parts = topic.split(' ');
    const flag = run([...parts, '--help'], undefined, env);
    const command = run(['help', ...parts], undefined, env);
    assert.equal(flag.status, 0);
    assert.equal(flag.stderr, '');
    assert.equal(command.status, 0);
    assert.equal(command.stdout, flag.stdout);
    assert.ok(flag.stdout.startsWith(`Usage: whoosh-uploader ${topic}`));
  }
  const result = run(['upload', 'missing.json', '-h'], undefined, env);
  assert.equal(result.status, 0);
  assert.equal(existsSync(env.WHOOSH_CONFIG_DIR), false);
  const example = JSON.parse(
    result.stdout
      .split('\n')
      .find((line) => line.trim().startsWith('{"version"'))
  );
  assert.doesNotThrow(() => compile(example));
});

test('unknown help topics return a usage error', () => {
  for (const args of [
    ['unknown', '--help'],
    ['auth', 'unknown', '--help'],
    ['help', 'upload', 'extra'],
    ['help', 'toString']
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'USAGE');
  }
});

test('removed receipt option is rejected before reading input or authenticating', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'whoosh-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'receipt.json');
  for (const options of [[], ['--dry-run']]) {
    const result = run(
      ['upload', 'missing.json', ...options, '--receipt', file],
      undefined,
      { MYWHOOSH_TOKEN: 'invalid' }
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(
      JSON.parse(result.stderr).error.code,
      'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    );
  }
  assert.equal(existsSync(file), false);
});
