# Agent instructions

## Working on this repository

Use Node.js 22 or newer. Keep changes scoped to the requested behavior and follow the existing JavaScript modules. `bin/whoosh.js` handles commands, `src/workout.js` compiles workouts, `src/auth.js` manages sessions, and `src/api.js` handles HTTP operations.

Run `npm test` and `npm run check` after implementation changes. Tests use synthetic credentials and mocked HTTP; ordinary checks must not call the live account. Use live upload or deletion only when the user authorizes it. Never print real credentials or include them in fixtures, documentation, logs, or commits.

Keep public documentation user-focused. Put agent-specific workflow instructions here. Preserve duplicate and conflict checks before slot recovery, at most one deletion per upload invocation, readback verification, and no automatic retries of writes with uncertain outcomes. Update the README flow and reference when these behaviors change.

## Producing workout input

Produce JSON matching `workout.schema.json`. Required fields are `version: 1`, `name`, current MyWhoosh `ftp_watts`, and `steps`.

Each step has whole `seconds` and exactly one target: `watts: 165`, `watts: [125,130]`, `ramp_watts: [100,180]`, or `free_ride: true`. Optional `cadence` is RPM; `text` is a start-of-step cue. Repeat groups are `{"repeat": 3, "steps": [...]}`. Range policy defaults to `midpoint`; choose `lower` or `upper` explicitly when intended. Maximum 30 steps after expansion.

Preserve the prescribed workout. Do not invent a warmup, cooldown, recovery, or FTP. Ask for missing essential coaching data. Read the user's current FTP instead of assuming the example's 210 W. Use a unique date or session name for a new workout. For an exact retry, keep the same name and JSON.

Save the JSON, then run `whoosh-uploader.cmd upload <absolute-input-path>` on Windows, or `whoosh-uploader upload ...` on Linux. Read the JSON result from stdout. `--dry-run` validates without uploading. `build ... --out workout.zwo` provides a manual-import fallback.

If slot credits are exhausted, upload automatically deletes the oldest custom cycling workout by creation time without confirmation, verifies removal and a free slot, then uploads. This includes workouts created outside the CLI. It removes at most one per run and stops if deletion is blocked or no credit returns. Report `deleted_workout` when present in the result or error. Do not retry capacity or deletion errors automatically, because another run could remove another workout. `delete <workout-id>` is also available and does not prompt.

Require exit code 0 and `verified: true`. Both `uploaded` and `already_exists` are successful. Report duration and resolved ranges. Do not repeatedly retry authentication, capacity, conflict, or unknown-outcome errors. Use `list` to check remote state. Uploads must run serially for each account. Never print credentials or copy them into workouts, logs, or prompts.

The session cache avoids browser work on normal runs. If authentication expires, use `auth login`; a CAPTCHA may require the user. Upload verification confirms MyWhoosh's stored workout, not in-game playback. This tool handles cycling workouts, not a triathlon training-plan calendar.
