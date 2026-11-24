# pi-smart-timeouts

A [Pi](https://pi.dev) extension that gives the `bash` tool the long-command behaviour of the
Claude Code harness: a command that runs past its timeout keeps running as a background job, the
tool call returns at once, and a message enters the conversation when the job exits.

## What it does

- Every `bash` command gets a default timeout of **120 s**. Explicit timeouts are capped at
  **600 s**. Both are configurable.
- At the timeout the command is **not killed**. It continues as a background job and the call
  returns with the output so far, a job id, the path of a file that keeps receiving the job's
  output, and the sentence "The job keeps running, and a message arrives when it exits."
- `run_in_background: true` starts a command as a job immediately (servers, watchers, long builds).
- When a job exits, a message with the job id, command, exit code, run time and the last 20 lines
  of output is added to the conversation. If Pi is idle, the message starts a new turn. If Pi is
  busy, it is delivered before the next model call of the current run. During a compaction it
  waits until the compaction ends.
- `job_output`, `job_status` and `job_kill` read a job's output (tail or from a byte offset), show
  job state, and kill a job's process tree.
- Jobs still running when the session ends (quit, `/reload`, `/new`, `/resume`, `/fork`) are killed.
- The footer shows `N background jobs` while jobs run.

### Compared with Pi's default and the timeout packages

| | Pi 1.5 `bash` | `pi-bash-timeout`, `@piotr-oles/pi-bash-timeout` | pi-smart-timeouts |
|---|---|---|---|
| Default timeout | none, waits forever | 120 s | 120 s |
| Cap on `timeout` | ~24.8 days | 600 s | 600 s |
| At the timeout | kills the process tree | kills the process tree (Pi's behaviour) | keeps it running as a job |
| Start in background | no | no | `run_in_background` |
| Notification on exit | no | no | message, starts a turn when idle |
| Job output / status / kill | no | no | `job_output`, `job_status`, `job_kill` |
| `timeout` unit | seconds | ms (`pi-bash-timeout` 0.2) / seconds | seconds |

The two timeout packages only set a default and a cap; the command still dies when the timeout
passes. A model that writes milliseconds (`timeout: 120000`) here gets the 600 s cap, so the
command becomes a job after 10 minutes instead of blocking for 33 hours.

## Install

```bash
pi install npm:pi-smart-timeouts      # from npm
pi install git:github.com/Neutralized/pi-smart-timeouts   # from GitHub
pi -e npm:pi-smart-timeouts           # try it for one run
pi -e /path/to/pi-smart-timeouts      # from a local checkout
```

The package has no runtime dependencies. Pi loads the TypeScript source directly.

## What the model sees

A command that outlives its timeout:

```text
Compiling crate 1/240
Compiling crate 2/240


Command still running after 120 seconds. It continues as background job bg-3f9a1c.
Job output file: /tmp/pi-job-bg-3f9a1c-5aa37445.log
The job keeps running, and a message arrives when it exits.
```

The message when it exits:

```text
Background job bg-3f9a1c exited with code 0 after 6m 12s.
Command: cargo build --release
Job output file: /tmp/pi-job-bg-3f9a1c-5aa37445.log (48.2KB)
Last 20 lines:
...
```

In the TUI the message appears as a `[pi-smart-timeouts]` block.

## Tools

| Tool | Parameters | Result |
|---|---|---|
| `bash` | `command`, `timeout?` (seconds), `run_in_background?` | Pi's bash result; for a job, the output so far plus the job notice |
| `job_output` | `job_id`, `lines?` (default 100), `offset?` (bytes) | Last lines, or output from the offset; state, size and next offset. Capped at 2000 lines / 50 KB |
| `job_status` | `job_id?` | State, exit code, run time, PID and output file of one or all jobs |
| `job_kill` | `job_id` | SIGTERM to the job's process group, SIGKILL after 2 s; final state and last lines |

## Configuration

| Setting | Pi flag | Environment variable | Default |
|---|---|---|---|
| Default timeout (s) | `--smart-timeouts-default <s>` | `PI_SMART_TIMEOUTS_DEFAULT_S` | 120 |
| Maximum timeout (s) | `--smart-timeouts-max <s>` | `PI_SMART_TIMEOUTS_MAX_S` | 600 |

The flag wins over the environment variable, which wins over the default. Invalid values are
reported as a warning and ignored. A default above the maximum is lowered to the maximum.

```bash
PI_SMART_TIMEOUTS_DEFAULT_S=60 pi
pi --smart-timeouts-default 300 --smart-timeouts-max 1800
```

## Compatibility with Pi's bash tool

- The tool is still named `bash`. `command` and `timeout` (seconds, optional) are unchanged; only
  `run_in_background` is added.
- Execution goes through Pi's own `createBashToolDefinition()`, so output streaming, tail
  truncation (2000 lines / 50 KB), the full-output temp file, error texts (`Command exited with
  code N`, `Command aborted`), `details` and the renderer are Pi's. Only process spawning is
  replaced. The tests compare the results with Pi's own tool.
- The `shellPath` (including `~` and `file://` forms) and `shellCommandPrefix` settings and the
  `PI_*` session variables apply as with the built-in tool.
- When output was truncated, Pi's footer still names Pi's own `pi-bash-*.log` file, which holds
  the output up to the timeout. The job's complete output is in the "Job output file".
- For a call that became a job, `structuredContent` (used by codemode scripts) has
  `exit_code: -1` plus `job_id` and `job_output_path`. Everything else is unchanged.

## Limits

- Tool names are unique, so other extensions that replace `bash` conflict with this one.
- A job is its shell's process group. Processes that leave the group (`setsid`, daemons that
  detach themselves) are not killed by `job_kill` or at shutdown.
- A job ends when its shell exits and the output pipes fall quiet, as in Pi. Processes the
  command starts with `&` can outlive the job.
- If Pi is killed with SIGKILL, or gets SIGINT in print mode (Pi installs no SIGINT handler
  there), jobs keep running.
- In print and JSON mode Pi exits after the last prompt; jobs still running then are killed.
  Exits that happen during the run are delivered.
- Pressing Escape in the TUI clears Pi's message queue. An exit message caught in it is
  re-queued and reaches the model with the next prompt.
- Job output files stay in the system temp directory, like Pi's own `pi-bash-*.log` files.
- Jobs live in memory. They do not survive a restart, `/reload` or a session switch.
- Windows code paths mirror Pi's (`taskkill /T /F`) but are untested.

## Development

No dependencies to install. The tests use Node's built-in test runner and load Pi's modules from
the `pi` found on `PATH` (or from `PI_SMART_TIMEOUTS_PI_ROOT`).

```bash
npm test          # unit and compatibility tests
npm run smoke     # runs the installed pi with a scripted faux model, no network
```

See [DESIGN.md](DESIGN.md) for the verified Pi APIs this builds on.

## License

MIT
