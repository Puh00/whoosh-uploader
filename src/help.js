import { WhooshError } from './workout.js';

const inputHelp = `Input:
  Use a JSON file path, or - to read JSON from stdin.
  Required fields: version: 1, name, ftp_watts, and steps.
  Each step needs whole seconds and one target: watts, ramp_watts, or free_ride.
  Maximum 30 steps after expanding repeats. Use your current MyWhoosh FTP.

Minimal format example (adjust FTP and power for your own session):
  {"version":1,"name":"Easy session","ftp_watts":200,"steps":[{"seconds":600,"watts":120}]}

Other step formats:
  {"seconds":60,"watts":[120,130]}
  {"seconds":300,"ramp_watts":[100,150]}
  {"seconds":120,"free_ride":true}
  {"repeat":3,"steps":[{"seconds":60,"watts":180},{"seconds":60,"watts":100}]}
  Optional step fields: cadence in RPM and text for a start-of-step caption.
  Optional workout fields: description, author, and range_policy.
  range_policy is midpoint (default), lower, or upper; a range becomes one target.
`;

const overview = `whoosh-uploader: create and manage MyWhoosh cycling workouts

Usage:
  whoosh-uploader <command> [arguments] [options]
  whoosh-uploader <command> --help
  whoosh-uploader help [command] [subcommand]

Commands:
  validate <workout.json|->           Check a workout without signing in
  build <workout.json|-> --out <file> Export ZWO or native MyWhoosh JSON
  upload <workout.json|->             Upload and verify a workout
  list                               List your custom workouts
  delete <workout-id>                 Delete a workout without prompting
  auth login                         Sign in through a browser and save the session
  auth import                        Read an existing session token from stdin
  auth status                        Check the local session's format and expiry
  auth clear                         Remove the saved local session

Upload options:
  --dry-run          Validate and print the upload payload; no account changes
  -h, --help         Show help without reading input or accessing your account

Examples:
  whoosh-uploader upload workout.json --dry-run
  whoosh-uploader auth login
  whoosh-uploader upload workout.json
  whoosh-uploader upload --help

At zero credits, upload deletes the oldest custom cycling workout without asking,
including workouts created outside this CLI. At most one deletion per upload run.
Duplicate uploads and dry runs never delete workouts. No POST or DELETE retries.

Results are JSON on stdout; errors are JSON on stderr. Help is plain text.
Exit codes: 0 success, 2 input/usage, 3 authentication, 4 other failures.
Use MYWHOOSH_TOKEN for process-level authentication or sign in to save a session.
Node.js 22 or newer is required. From a checkout, replace whoosh-uploader with node bin/whoosh.js.
`;

const commandHelp = {
  validate: `Usage: whoosh-uploader validate <workout.json|->

Validate and normalize a workout offline. Reports duration, expanded step count,
fingerprint, and warnings such as resolved power ranges. Does not read a token,
contact MyWhoosh, or save files. Success has status: "valid".

Example: whoosh-uploader validate workout.json

${inputHelp}`,
  build: `Usage: whoosh-uploader build <workout.json|-> --out <file> [--format zwo|mywhoosh]

Validate a workout and export a file offline. No authentication or network calls.

Options:
  --out <file>       Required output path. Creates parent folders; overwrites the file.
  --format <name>    zwo (default) for XML, or mywhoosh for the native JSON object.
                    Use an output path different from your input file.

Examples:
  whoosh-uploader build workout.json --out dist/workout.zwo
  whoosh-uploader build workout.json --format mywhoosh --out dist/workout.json

Success has status: "built", a summary, and the output file path.

${inputHelp}`,
  upload: `Usage: whoosh-uploader upload <workout.json|-> [--dry-run]

Validate a workout, check for duplicates and free slots, upload, then read back
and verify its saved steps. Sign in with whoosh-uploader auth login first, or supply
MYWHOOSH_TOKEN. A dry run does not need authentication.

Options:
  --dry-run
    Validate and print a summary plus the native upload payload as JSON.
    Does not load a token, contact MyWhoosh, check remote duplicates or credits,
    upload, or delete. Status is "dry_run", not a verified upload.
    Prints to stdout without saving a file.

Examples:
  whoosh-uploader upload workout.json --dry-run
  whoosh-uploader upload workout.json

Account changes:
  At zero credits, automatically delete the oldest custom cycling workout by
  creation date, including workouts created outside this CLI. No confirmation.
  Delete at most one, verify removal and a free slot, then upload. Stop if a plan
  blocks deletion or no credit returns. A failed upload cannot undo a deletion.
  Run uploads serially. Do not blindly retry errors: another run may delete
  another workout. Lost POST or DELETE responses are not retried automatically.

Results:
  uploaded / already_exists with verified: true means stored steps were checked.
  An identical fingerprint returns the existing workout without any deletion.
  WORKOUT_CONFLICT means a different workout has the same name or ID.
  AUTH_* means the session needs attention. WORKOUT_IN_USE or NO_CREDITS stops
  slot recovery. *_UNKNOWN or *_UNVERIFIED means check the library before retrying.
  Errors include deleted_workout or deletion_attempt when applicable.
  Exit codes: 0 success, 2 input/usage, 3 authentication, 4 other failures.
  Verification checks stored data, not in-game playback or trainer behavior.

${inputHelp}`,
  list: `Usage: whoosh-uploader list

Read your custom workouts from MyWhoosh. Requires a valid session; makes no changes.
Returns JSON with a workouts array containing id, name, duration_seconds,
step_count, and created_at. Use an id from this list with whoosh-uploader delete.

Example: whoosh-uploader list
`,
  delete: `Usage: whoosh-uploader delete <workout-id>

Delete one custom cycling workout without asking for confirmation. Requires a
valid session and an exact numeric ID from whoosh-uploader list. Verifies that the workout
is in your library, sends one DELETE, then reads back to confirm its absence.
Does not create a replacement workout or force deletion through a training-plan block.

Example: whoosh-uploader delete 1234567

Success has status: "deleted", deleted_workout, and verified: true.
No automatic DELETE retries. If the outcome is uncertain, inspect your library
before retrying. Deletion does not create a backup.
`,
  auth: `Usage: whoosh-uploader auth <login|import|status|clear>

  login [--channel msedge|chrome|chromium]  Sign in and save the session token
  import                                  Read a token from stdin and save it
  status                                  Check token format and expiry locally
  clear                                   Remove the saved session from this OS

Examples:
  whoosh-uploader auth login --channel chrome
  whoosh-uploader auth login --help
  whoosh-uploader auth status

MYWHOOSH_TOKEN overrides the saved session. WHOOSH_CONFIG_DIR overrides its folder.
Windows uses DPAPI encryption; Linux uses an owner-only plaintext session file.
Never put tokens in command arguments, logs, or workout files.
`,
  'auth login': `Usage: whoosh-uploader auth login [--channel msedge|chrome|chromium]

Open a temporary browser for MyWhoosh sign-in. Complete login and any CAPTCHA
within five minutes. Saves the session token, not your password. This browser
does not share the login or saved passwords from your usual browser.

--channel selects Edge, Chrome, or bundled Chromium. The default is Chromium
on all platforms. npm downloads Chromium when install scripts are allowed.
If the download was skipped or failed, install it with:
  npx playwright@1.63.0 install chromium
Linux also needs browser system libraries and a graphical session.

Example: whoosh-uploader auth login --channel chrome

Success has status: "signed_in" and session_file. Tokens are not printed.
`,
  'auth import': `Usage: whoosh-uploader auth import

Read an existing MyWhoosh workout-builder session token from stdin, check its
format and expiry, and save it. Does not check server access; run whoosh-uploader list
afterward. Use a secure token source piped to stdin, never a command argument.
For browser sign-in, use whoosh-uploader auth login instead.

Success has status: "signed_in" and session_file. Tokens are not printed.
`,
  'auth status': `Usage: whoosh-uploader auth status

Check the selected token's format and expiry locally. MYWHOOSH_TOKEN takes
precedence over the saved session. Makes no network calls and cannot detect
server revocation or permission changes. Run whoosh-uploader list to check server access.

Success has status: "session_present". Tokens are not printed.
`,
  'auth clear': `Usage: whoosh-uploader auth clear

Remove the saved session on this OS. Does not revoke the server session, clear
MYWHOOSH_TOKEN, or sign out your browser. Makes no network calls.

Success has status: "local_session_removed".
`
};

/**
 * Return offline help for the requested command path.
 * @param {string[]} topics - Command and optional subcommand; empty for overview.
 * @returns {string} Human-readable CLI help.
 * @throws {WhooshError} USAGE for an unknown topic.
 */
export function helpFor(topics = []) {
  if (!topics.length) {
    return overview;
  }
  const topic = topics.join(' ');
  if (!Object.hasOwn(commandHelp, topic)) {
    throw new WhooshError(
      'USAGE',
      'Unknown help topic. Run whoosh-uploader --help for available commands.'
    );
  }
  return commandHelp[topic];
}
