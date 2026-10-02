# MyWhoosh Workout Uploader

[![npm version](https://img.shields.io/npm/v/whoosh-uploader)](https://www.npmjs.com/package/whoosh-uploader)

Unofficial CLI tool for uploading and managing MyWhoosh cycling workouts. Uploads use JSON files that follow the [workout schema](workout.schema.json); see [examples](examples/) for starting points. Also exports ZWO files. Package and command: `whoosh-uploader`.

**When slots are full, uploading deletes your oldest custom cycling workout without confirmation, including workouts created outside this tool.** At most one is deleted per run, selected by creation date.

## How it works

```mermaid
flowchart LR
    File["Workout JSON following the schema"] --> Check["Validate the workout"]
    Check --> Preview["Preview without saving"]
    Check --> Export["Export a ZWO file"]
    Check --> Upload["Save to MyWhoosh"]
    Upload --> Verify["Verify the saved workout"]
    Verify --> Result["Show the result"]
```

## Quick start

Requires Node.js 22+ and a MyWhoosh account for uploads.

```sh
npm install -g whoosh-uploader
whoosh-uploader upload --help
whoosh-uploader upload workout.json --dry-run
whoosh-uploader auth login
whoosh-uploader upload workout.json
```

Create `workout.json` using the schema or the example in `upload --help`. Set `ftp_watts` to your current MyWhoosh FTP and adjust the workout to your training needs. Examples demonstrate the format, not personalized training advice.

Run `auth login` to sign in and save your token locally for later uploads. Login defaults to Chromium on Windows and Linux. The npm dependency downloads Chromium during installation when install scripts are allowed. Use `--channel chrome` or `--channel msedge` to use an installed Chrome or Edge instead. See [setup](REFERENCE.md#setup) for download troubleshooting, Linux requirements, and session storage.

Without a global install, use `npx whoosh-uploader <command>`. On Windows, use the `.cmd` wrappers if PowerShell blocks scripts.

## What happens during upload

```mermaid
flowchart TD
    Start["Upload a checked workout"] --> Token["Load saved token or MYWHOOSH_TOKEN"]
    Token --> Ready{"Usable token available?"}
    Ready -->|No| AuthStop["Stop: sign-in required"]
    AuthStop -.-> Login["Run auth login and sign in"]
    Login --> Cache["Save token locally"]
    Cache --> Retry["Rerun upload"]
    Retry --> Start
    Ready -->|Yes| Duplicate{"Already saved?"}
    Duplicate -->|Yes| Existing["Verify and return the existing workout"]
    Duplicate -->|No| Conflict{"Name or ID already taken?"}
    Conflict -->|Yes| Rename["Stop and choose a new name"]
    Conflict -->|No| Space{"Free slot available?"}
    Space -->|Yes| Save["Upload the new workout"]
    Space -->|No| Delete["Delete the oldest custom cycling workout"]
    Delete --> Confirm{"Removal and free slot confirmed?"}
    Confirm -->|Yes| Save
    Confirm -->|No| Stop["Stop and report the problem"]
    Save --> Verify["Read back and verify the workout"]
    Verify --> Result["Report the result and any deletion"]
```

Missing, invalid, or expired tokens stop the upload; login is a separate command, not automatic. `MYWHOOSH_TOKEN` overrides the saved token. If MyWhoosh rejects a token, the CLI stops and asks you to sign in again or check account access.

Unchanged uploads return the verified existing copy without deletion. Name or ID conflicts stop before slot recovery. Blocked deletion or a missing slot refund also stops the upload.

A failed upload cannot undo a deletion. Writes are never automatically retried; inspect errors before rerunning, since another run could delete another workout. Run uploads serially per account.

## Common commands

```sh
whoosh-uploader validate workout.json
whoosh-uploader build workout.json --out dist/workout.zwo
whoosh-uploader upload workout.json
whoosh-uploader upload workout.json --dry-run
whoosh-uploader list
whoosh-uploader delete <workout-id>
whoosh-uploader --help
whoosh-uploader upload --help
```

- `--dry-run` validates and prints the upload payload offline. It never uploads or deletes, and does not check authentication, credits, duplicates, or server acceptance. Validation and exports also work offline.
- `delete` removes the specified workout without confirmation.
- Results are JSON on stdout; errors are JSON on stderr. Successful uploads return `uploaded` or `already_exists` with `verified: true`; any removal is reported as `deleted_workout`.
- `<command> --help` or `help <command>` works offline and includes options, examples, and workout input formats.

## Limits and compatibility

- Time-based cycling workouts: steady efforts, ramps, repeats, cadence, captions, and free ride. Maximum 30 expanded steps.
- Power scales with your MyWhoosh FTP; the tool does not change your profile FTP.
- Uses an undocumented API that may change. Uploads are verified on Windows and Linux under WSL, but not in-game playback or trainer behavior.
- Sessions use DPAPI on Windows and owner-only plaintext files on Linux.

## Development

```sh
npm ci
npm test
npm run check
```

From a checkout, run `node bin/whoosh.js` or use `npm link` to install the local command. Tests use synthetic credentials and mocked HTTP, never your live account. CI runs on Windows and Linux with Node.js 22 and 24.

## Documentation

- [Reference](REFERENCE.md): setup, workout format, commands, API behavior, and troubleshooting.
- [Workout schema](workout.schema.json) and [examples](examples/): supported input files.
