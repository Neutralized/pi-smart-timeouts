# Changelog

## [0.1.0] - 2026-11-24

### Added

- `bash` override built on Pi's own bash tool definition: every command gets a default timeout (120 s) and timeouts are capped (600 s).
- A command still running at its timeout continues as a background job instead of being killed. The call returns the output so far, the job id, the output file and a note that a message arrives when the job exits.
- `run_in_background` parameter on `bash` to start a command as a job at once.
- Exit message with the job id, command, exit code, run time and the last 20 lines of output. It starts a turn when Pi is idle and is steered into the running turn otherwise.
- `job_output`, `job_status` and `job_kill` tools.
- Prompt guidelines on `bash`: background servers and watchers, end the turn to wait for a job, kill a job as soon as its result is no longer needed.
- Running jobs are killed when the session ends.
- Configuration through `--smart-timeouts-default` / `--smart-timeouts-max` and `PI_SMART_TIMEOUTS_DEFAULT_S` / `PI_SMART_TIMEOUTS_MAX_S`.
