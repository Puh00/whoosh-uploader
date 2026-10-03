#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  compile,
  summary,
  toZwo,
  toMyWhoosh,
  WhooshError
} from '../src/workout.js';
import { MyWhoosh, identity } from '../src/api.js';
import { getToken, saveToken, clearToken, login } from '../src/auth.js';
import { helpFor } from '../src/help.js';

/**
 * Read standard input with the same size bound used for workout files.
 * @returns {Promise<string>} Collected input text.
 * @throws {WhooshError} INPUT_TOO_LARGE when input exceeds the limit.
 */
async function stdin() {
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (source.length > 1024 * 1024) {
      throw new WhooshError('INPUT_TOO_LARGE', 'Input exceeds 1 MiB');
    }
  }
  return source;
}
/**
 * Write UTF-8 output, creating parent directories as needed.
 * @param {string} file - Destination path, resolved from the current directory.
 * @param {string} content - File contents.
 * @returns {Promise<string>} Absolute output path.
 * @throws {Error} If directory creation or writing fails.
 */
async function outputFile(file, content) {
  const absolutePath = resolve(file);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  return absolutePath;
}
/**
 * Reject invalid command arguments with a user-facing explanation.
 * @param {string} message - Usage error to report.
 * @returns {never} Throws WhooshError with code USAGE.
 */
function usage(message) {
  throw new WhooshError('USAGE', message);
}
/**
 * Parse process arguments, execute one command, and write its output to stdout.
 * @returns {Promise<void>} Help text or one JSON result is emitted.
 * @throws {Error} Command failures are handled by the top-level error reporter.
 * Commands may read or write files, open a login browser, or call the API.
 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      out: { type: 'string' },
      format: { type: 'string' },
      'dry-run': { type: 'boolean' },
      channel: { type: 'string' }
    }
  });
  if (positionals[0] === 'help') {
    process.stdout.write(helpFor(positionals.slice(1)));
    return;
  }
  if (values.help || !positionals.length) {
    const topics = positionals.slice(0, positionals[0] === 'auth' ? 2 : 1);
    process.stdout.write(helpFor(topics));
    return;
  }
  const [command, input, ...extra] = positionals;
  const options = {
    validate: [],
    build: ['out', 'format'],
    upload: ['dry-run'],
    list: [],
    delete: [],
    auth: ['channel']
  }[command];
  if (!options) {
    usage(`Unknown command ${command}`);
  }
  for (const option of Object.keys(values)) {
    if (!options.includes(option)) {
      usage(`--${option} is not supported by ${command}`);
    }
  }
  if (extra.length) {
    usage('Unexpected positional arguments');
  }
  let result;
  if (command === 'auth') {
    result = await runAuthCommand(input, values.channel);
  } else if (command === 'list') {
    if (input) {
      usage('list takes no input');
    }
    const workouts = await new MyWhoosh(await getToken()).list();
    result = {
      workouts: workouts.map((workout) => ({
        id: workout.WorkoutId,
        name: workout.Name,
        duration_seconds: workout.Time,
        step_count: workout.StepCount,
        created_at: workout.createdAt
      }))
    };
  } else if (command === 'delete') {
    if (!input || !/^\d+$/.test(input)) {
      usage('delete requires a numeric workout ID from list');
    }
    const client = new MyWhoosh(await getToken());
    const workout = (await client.list()).find(
      (workout) => String(workout.WorkoutId) === input
    );
    if (!workout) {
      throw new WhooshError(
        'WORKOUT_NOT_FOUND',
        'Workout ID is not in My Workouts. No deletion attempted.'
      );
    }
    result = {
      status: 'deleted',
      deleted_workout: await client.deleteWorkout(workout),
      verified: true
    };
  } else {
    if (!input) {
      usage('A workout JSON path or - for stdin is required');
    }
    if (command === 'build' && !values.out) {
      usage('build requires --out');
    }
    if (
      command === 'build' &&
      values.format &&
      !['zwo', 'mywhoosh'].includes(values.format)
    ) {
      usage('--format must be zwo or mywhoosh');
    }
    const source =
      input === '-' ? await stdin() : await readFile(input, 'utf8');
    if (source.length > 1024 * 1024) {
      throw new WhooshError('INPUT_TOO_LARGE', 'Input exceeds 1 MiB');
    }
    let parsed;
    try {
      parsed = JSON.parse(source.replace(/^\uFEFF/, ''));
    } catch {
      throw new WhooshError('INVALID_JSON', 'Input must be valid JSON.');
    }
    const workout = compile(parsed);
    if (command === 'validate') {
      result = { status: 'valid', ...summary(workout) };
    } else if (command === 'build') {
      const format = values.format ?? 'zwo';
      result = {
        status: 'built',
        ...summary(workout),
        file: await outputFile(
          values.out,
          format === 'zwo'
            ? toZwo(workout)
            : JSON.stringify(toMyWhoosh(workout), null, 2) + '\n'
        ),
        format
      };
    } else if (values['dry-run']) {
      result = {
        status: 'dry_run',
        ...summary(workout),
        payload: toMyWhoosh(workout)
      };
    } else {
      result = await new MyWhoosh(await getToken()).upload(workout);
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch((error) => {
  const code = error.code ?? 'ERROR';
  let message;
  if (error instanceof WhooshError) {
    message = error.message;
  } else if (['ENOENT', 'EACCES', 'EPERM'].includes(code)) {
    message = `File operation failed: ${code}`;
  } else if (error.code?.startsWith('ERR_PARSE_ARGS')) {
    message = 'Invalid command arguments. Run whoosh-uploader --help.';
  } else {
    message =
      'Command failed. Check installation, input files, and permissions.';
  }
  process.stderr.write(
    JSON.stringify({
      error: {
        code,
        message,
        ...(error.deletion_attempt
          ? { deletion_attempt: error.deletion_attempt }
          : {}),
        ...(error.deleted_workout
          ? { deleted_workout: error.deleted_workout }
          : {})
      }
    }) + '\n'
  );
  if (
    ['INVALID_INPUT', 'INVALID_JSON', 'USAGE', 'INPUT_TOO_LARGE'].includes(code)
  ) {
    process.exitCode = 2;
  } else if (code.startsWith('AUTH')) {
    process.exitCode = 3;
  } else {
    process.exitCode = 4;
  }
});

/**
 * Execute an authentication subcommand after validating its browser option.
 * @param {string} input - login, import, status, or clear.
 * @param {string} [channel] - Optional browser selection for login.
 * @returns {Promise<object>} Command result without any token contents.
 * @throws {Error} For invalid arguments, missing input, or authentication failures.
 * May open a browser or update the local session cache.
 */
async function runAuthCommand(input, channel) {
  let result;
  if (channel && input !== 'login') {
    usage('--channel is only valid for auth login');
  }
  if (channel && !['msedge', 'chrome', 'chromium'].includes(channel)) {
    usage('Unsupported browser channel');
  }
  if (input === 'login') {
    result = await login(channel);
  } else if (input === 'import') {
    if (process.stdin.isTTY) {
      usage(
        'auth import requires a token piped through stdin. Use auth login for interactive sign-in.'
      );
    }
    result = {
      status: 'signed_in',
      session_file: await saveToken((await stdin()).trim())
    };
  } else if (input === 'status') {
    identity(await getToken());
    result = {
      status: 'session_present',
      note: 'Token shape and expiry checked locally; server access is checked by list.'
    };
  } else if (input === 'clear') {
    await clearToken();
    result = { status: 'local_session_removed' };
  } else {
    usage('Expected auth login, import, status, or clear');
  }
  return result;
}
