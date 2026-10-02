# MyWhoosh Workout Uploader reference

See the [README](README.md) for a high-level overview and workflow diagrams.

## Setup

Requires Node.js 22 or newer. From the repository folder:

```sh
npm ci
node bin/whoosh.js auth login
```

Optionally run `npm link` to make the `whoosh-uploader` command available. On Windows, use `npm.cmd` and `whoosh-uploader.cmd` if PowerShell blocks the `.ps1` wrappers. Direct invocation through `node bin/whoosh.js` works without a global link.

### Browser login

Login defaults to an installed Microsoft Edge on Windows and bundled Chromium elsewhere. Select Chrome with `--channel chrome` or Edge with `--channel msedge`. To use bundled Chromium:

```sh
npx playwright install chromium
node bin/whoosh.js auth login --channel chromium
```

Linux also needs the browser's system libraries and a graphical session for interactive login. See [Playwright's browser setup](https://playwright.dev/docs/browsers). Uploads do not need a browser once a valid token is available.

`auth login` opens a temporary browser and waits up to five minutes for sign-in. It saves only the session token, not your password. The temporary browser does not share your normal browser's saved passwords or login. Complete any CAPTCHA yourself.

### Session storage

| Environment | Default session file | Protection |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\whoosh-cli\session.auth.json` | DPAPI encryption for the current Windows user |
| Linux / WSL | `$XDG_CONFIG_HOME/whoosh-cli/session.auth.json`, or `~/.config/whoosh-cli/session.auth.json` | Plaintext in an owner-only file |

`WHOOSH_CONFIG_DIR` overrides the session directory. `MYWHOOSH_TOKEN` supplies a token for the process and takes precedence over the saved session. An existing workout-builder token can also be piped to `auth import` through stdin. Do not put tokens in command arguments, workout files, logs, or source control.

`auth status` checks token format and expiry locally; `list` checks whether the server accepts it. `auth clear` removes the saved token but does not revoke the server session or unset environment variables. An expired or revoked session requires another login; the CLI does not refresh it automatically.

### WSL

Native WSL execution requires Linux Node.js 22 or newer, installed dependencies, and its own session. Windows DPAPI sessions cannot be read directly by Linux. Sign in separately or provide a token securely through stdin or the environment. Keep a native Linux checkout under the Linux filesystem for normal development.

Running Windows Node from WSL uses the Windows installation and session instead. That is different from running the CLI natively on Linux.

## Workout format

[workout.schema.json](workout.schema.json) defines the input format. [examples/tempo-steps.json](examples/tempo-steps.json) shows repeated steady efforts; [examples/mixed-intervals.json](examples/mixed-intervals.json) also demonstrates ramps, cadence, captions, and free ride.

```json
{
  "version": 1,
  "name": "Progressive intervals",
  "ftp_watts": 210,
  "range_policy": "midpoint",
  "steps": [
    {"seconds": 300, "ramp_watts": [100, 150]},
    {"repeat": 3, "steps": [
      {"seconds": 120, "watts": 180, "cadence": 90},
      {"seconds": 60, "watts": [125, 130]}
    ]},
    {"seconds": 300, "watts": 110, "text": "Easy spin"}
  ]
}
```

- Durations are whole seconds. Power inputs are watts, not percentages. FTP must be explicit.
- `watts: 165` is a constant target. A range such as `watts: [125, 130]` resolves to one target. The default `midpoint` is 127.5 W; `lower` and `upper` are alternatives. Results report range resolutions.
- `ramp_watts: [100, 180]` is a linear ramp. A power range does not become a ramp.
- `free_ride: true` creates a segment without an ERG power target.
- Optional `cadence` is RPM; `text` is a caption at the start of the step.
- `repeat` expands nested steps. Maximum nesting is five levels and maximum expanded length is 30 steps.
- Optional top-level fields include `description` and `author`. Unknown fields and ambiguous targets cause validation errors.

Other limits are 24 hours total duration, FTP up to 1,000 W, targets up to 3,000 W, and cadence up to 250 RPM. These are software limits, not training advice. CLI validation checks limits after expansion as well as the input shape.

### Power and estimates

MyWhoosh stores power as a fraction of FTP. For example, 165 W at 210 W FTP becomes `0.78571429`. Set `ftp_watts` to the FTP you use in MyWhoosh. If your profile FTP changes later, the saved workout scales with it. The CLI does not change your profile.

Native uploads preserve eight decimal places in power fractions. Readback allows a tolerance of `0.000001` to accommodate server float32 storage. Estimated IF and TSS use one-second samples with a 30-second rolling average. Estimated kJ comes from power and duration. Free ride uses 70% FTP for estimates only. These values are not measurements from a completed ride.

## Commands

Prefix each command below with `node bin/whoosh.js`, or `whoosh-uploader` after `npm link`.

| Command | Result |
| --- | --- |
| `validate workout.json` | Check the input and report duration, steps, fingerprint, and warnings |
| `build workout.json --out dist/workout.zwo` | Export a ZWO/XML file |
| `build workout.json --format mywhoosh --out dist/workout.json` | Export the native MyWhoosh object |
| `upload workout.json --dry-run` | Preview the upload object without authentication or network calls |
| `upload workout.json` | Check duplicates and capacity, upload, and verify stored steps |
| `list` | Show custom workouts with IDs, durations, steps, and creation dates |
| `delete <workout-id>` | Delete a custom cycling workout without prompting and verify its absence |
| `auth login` | Sign in through a browser and save the session |
| `auth import` | Read an existing token from stdin and save it |
| `auth status` | Check the local session's format and expiry |
| `auth clear` | Remove the saved session |
| `help [command] [subcommand]` | Show offline help, including options and examples |

Use different input and output paths when building files. Pass `-` instead of a workout path to read JSON from stdin. Successful commands except help print one JSON object to stdout. Errors print JSON to stderr. Exit codes are 0 for success, 2 for invalid input or usage, 3 for authentication errors, and 4 for other failures.

`--help` and `-h` work globally or after a command. For example, `upload --help` and `help upload` show the same detailed help; `auth login --help` explains browser setup. Help does not read workout files or load credentials. Upload, build, and validate help include the input format and examples.

### Dry runs

`upload workout.json --dry-run` compiles the input and prints `status: "dry_run"`, the workout summary, and `payload`, the native object that a real upload would send inside `WorkoutsData`. It does not authenticate, contact MyWhoosh, check remote duplicates or credits, upload, or delete. Results go to stdout; no output file is written.

## Upload and deletion behavior

The CLI fingerprints normalized workout content and appends `[whoosh-cli:<hash>]` to the remote description. A matching fingerprint triggers verification and returns `already_exists`. A different workout with the same name or ID causes `WORKOUT_CONFLICT`. Both checks happen before any deletion.

At zero or negative credits, upload automatically deletes the oldest custom cycling workout in My Workouts, including workouts created outside the CLI. It uses `createdAt`, not the name, ID, last edit date, or list order. It deletes at most one workout per invocation, without prompting, then confirms removal and an available credit before uploading. Missing or invalid creation metadata stops deletion.

Deletion verification, credit-refund checks, and upload readback each allow up to three reads, with a one-second wait before subsequent reads. The CLI does not retry the DELETE or upload POST. If MyWhoosh reports training-plan use, it stops without modifying plans or selecting a different workout.

Successful uploads that made room include `deleted_workout` with the removed ID, name, and creation date. `credits_before` is the initial credit count. If upload fails after verified deletion, the error includes `deleted_workout`; uncertain deletion errors include `deletion_attempt`. Deletion and upload are separate operations, so an upload failure cannot restore the deleted workout. Results go to stdout and errors to stderr.

Run uploads serially for each account. Independent processes or machines can race because there is no documented server idempotency key. Inspect uncertain outcomes before retrying. A new invocation can delete another oldest workout if capacity is still exhausted. If someone edits the remote description, the fingerprint may no longer match; the name conflict still prevents another copy with that name.

### Troubleshooting

| Error | Meaning and next step |
| --- | --- |
| `AUTH_EXPIRED`, `AUTH_INVALID`, `AUTH_REQUIRED` | The session is expired, malformed, missing, or rejected. Sign in again or check account access. |
| `WORKOUT_CONFLICT` | A different workout has the same name or ID. Use a new name. |
| `WORKOUT_IN_USE` | MyWhoosh reports training-plan use. Inspect the workout and plan on the website. |
| `NO_CREDITS` | No eligible workout can be removed, or deletion did not return a credit. Inspect capacity before retrying. |
| `DELETE_UNKNOWN`, `DELETE_UNVERIFIED` | Deletion may have happened but could not be confirmed. Check the library before retrying. |
| `UPLOAD_UNKNOWN`, `UPLOAD_UNVERIFIED` | Upload may have happened. Check the library; repeating identical input checks its fingerprint first. |
| `VERIFY_FAILED` | Saved data differs from the requested workout. Inspect the remote workout. |
| `API_CHANGED`, `API_REJECTED`, `NETWORK_ERROR` | The response format, account permissions, server behavior, or network needs investigation. |

## API and limitations

The adapter follows the MyWhoosh website's client. All requests use a bearer token against `https://coaching.mywhoosh.com/api/v2`:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/workout-builder/my-workouts` | List custom workouts and read back changes |
| GET | `/client/my-credits` | Read available slot credits |
| POST | `/client/custom-workout-upload` | Upload a workout |
| DELETE | `/client/custom-workout-upload/0/<WorkoutId>` | Delete a cycling workout |

This is an undocumented integration and may change. Server permissions and slot limits still apply. The CLI does not buy subscriptions, change your profile, schedule training plans, or generate running and swimming workouts. It accepts structured JSON, not free-form workout descriptions.

For a manual fallback, build a ZWO file, open the [workout builder](https://workout.mywhoosh.com/), import the file, check its FTP and name, and select Export to MyWhoosh. The [official workout-builder guide](https://mywhoosh.com/everything-you-need-to-know-about-the-new-mywhoosh-workout-builder/) describes the website workflow.

## Code layout

| Path | Responsibility |
| --- | --- |
| `bin/whoosh.js` | Command parsing, file input/output, JSON results, and exit codes |
| `src/workout.js` | Validation, repeat expansion, watt conversion, fingerprints, and exports |
| `src/auth.js` | Browser login, session storage, and token loading |
| `src/api.js` | API requests, duplicate checks, capacity recovery, deletion, and verification |
| `src/help.js` | Offline command help, examples, and input-format descriptions |
| `workout.schema.json` | Versioned input format |
| `examples/` | Sample workout files |
| `test/` | Offline compiler, CLI, authentication, and mocked HTTP tests |

Run `npm test` and `npm run check` after changes. Tests use synthetic credentials and do not modify a real account. Keep generated exports, saved account results, screenshots of accounts, and credentials out of commits.
