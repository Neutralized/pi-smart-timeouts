import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveCallTimeout, resolveConfig } from "../src/config.ts";
import { CUSTOM_TYPE } from "../src/index.ts";
import { createHarness, isAlive, killPid, textOf, waitFor } from "./helpers.ts";

// Pi's own full-output files and the job files go to os.tmpdir(); keep them in one run directory.
const runTmp = mkdtempSync(join(tmpdir(), "pi-smart-timeouts-run-"));
process.env.TMPDIR = runTmp;
after(() => {
	const left = readdirSync(runTmp);
	rmSync(runTmp, { recursive: true, force: true });
	assert.deepEqual(left.filter((name) => name.startsWith("pi-job-")), [], "job files outside the harness dirs");
});

const JOB_ID = /background job (bg-[0-9a-f]{6})/;
const STILL_RUNNING = "The job keeps running, and a message arrives when it exits.";

function jobIdOf(result: { content: Array<{ text?: string }> }): string {
	const match = textOf(result as never).match(JOB_ID);
	assert.ok(match, `no job id in: ${textOf(result as never)}`);
	return match[1];
}

describe("default timeout", () => {
	it("turns a long command into a job and returns the output so far", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "1" } });
		try {
			const started = Date.now();
			const result = await h.bash({ command: "echo start; sleep 2; echo end" });
			const elapsed = Date.now() - started;
			const text = textOf(result);
			assert.ok(elapsed >= 900 && elapsed < 1900, `returned after ${elapsed} ms`);
			assert.match(text, /^start\n/);
			assert.match(text, /Command still running after 1 second\. It continues as background job bg-[0-9a-f]{6}\./);
			assert.match(text, /\nJob output file: .*pi-job-bg-[0-9a-f]{6}-[0-9a-f]{8}\.log\n/);
			assert.ok(text.endsWith(STILL_RUNNING));
			assert.equal(result.isError, undefined);
			const id = jobIdOf(result);
			assert.equal(result.structuredContent.exit_code, -1);
			assert.equal(result.structuredContent.job_id, id);
			assert.equal(result.structuredContent.output, "start\n");

			const sent = await h.waitForMessage((m) => m.message.details.jobId === id);
			assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "steer" });
			assert.equal(sent.message.customType, CUSTOM_TYPE);
			assert.equal(sent.message.display, true);
			assert.match(sent.message.content, new RegExp(`^Background job ${id} exited with code 0 after \\d`));
			assert.match(sent.message.content, /\nCommand: echo start; sleep 2; echo end\n/);
			assert.match(sent.message.content, /Last 2 lines:\nstart\nend/);
			assert.equal(readFileSync(result.structuredContent.job_output_path, "utf8"), "start\nend\n");
		} finally {
			await h.close();
		}
	});

	it("returns Pi's normal result for a command that ends in time", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "5" } });
		try {
			const result = await h.bash({ command: "echo hi" });
			assert.equal(textOf(result), "hi\n");
			assert.equal(result.structuredContent.exit_code, 0);
			assert.equal(result.structuredContent.job_id, undefined);
			assert.equal(h.messages.length, 0);
		} finally {
			await h.close();
		}
	});
});

describe("run_in_background", () => {
	it("starts a job at once and reports the exit with the code and the output tail", async () => {
		const h = await createHarness();
		try {
			const started = Date.now();
			const result = await h.bash({
				command: "sleep 0.3; for i in $(seq 1 50); do echo line$i; done; exit 3",
				run_in_background: true,
			});
			assert.ok(Date.now() - started < 500);
			const text = textOf(result);
			assert.match(text, /^Command started as background job bg-[0-9a-f]{6}\.\nJob output file: /);
			assert.ok(text.endsWith(STILL_RUNNING));
			const id = jobIdOf(result);

			const sent = await h.waitForMessage((m) => m.message.details.jobId === id);
			const content = sent.message.content;
			assert.match(content, new RegExp(`^Background job ${id} exited with code 3 after `));
			assert.match(content, /Last 20 lines:\nline31\n/);
			assert.match(content, /line50$/);
			assert.doesNotMatch(content, /^line30$/m);
			assert.equal(sent.message.details.exitCode, 3);
		} finally {
			await h.close();
		}
	});

	it("re-queues an undelivered exit message as nextTurn after an aborted run", async () => {
		const h = await createHarness();
		try {
			h.idle = false;
			const first = jobIdOf(await h.bash({ command: "true", run_in_background: true }));
			const sent = await h.waitForMessage((m) => m.message.details.jobId === first);
			await h.emit("agent_settled", { aborted: true });
			const parked = h.messages.filter((m) => m.message.details.jobId === first);
			assert.equal(parked.length, 2);
			assert.deepEqual(parked[1].options, { deliverAs: "nextTurn" });
			assert.equal(parked[1].message.content, sent.message.content);

			const second = jobIdOf(await h.bash({ command: "true", run_in_background: true }));
			const delivered = await h.waitForMessage((m) => m.message.details.jobId === second);
			await h.emit("message_end", { message: { role: "custom", ...delivered.message } });
			await h.emit("agent_settled", { aborted: true });
			assert.equal(h.messages.filter((m) => m.message.details.jobId === second).length, 1);

			// A notice that started a run while idle is not re-queued.
			h.idle = true;
			const third = jobIdOf(await h.bash({ command: "true", run_in_background: true }));
			await h.waitForMessage((m) => m.message.details.jobId === third);
			await h.emit("agent_settled", { aborted: true });
			assert.equal(h.messages.filter((m) => m.message.details.jobId === third).length, 1);
		} finally {
			await h.close();
		}
	});

	it("drops repeated exit messages of one job from the model context", async () => {
		const h = await createHarness();
		try {
			const notice = (jobId: string) => ({ role: "custom", customType: CUSTOM_TYPE, content: jobId, details: { jobId } });
			const user = { role: "user", content: "hi" };
			const result = await h.runHandler("context", { messages: [user, notice("bg-1"), notice("bg-2"), notice("bg-1")] });
			assert.deepEqual(result, { messages: [user, notice("bg-1"), notice("bg-2")] });
			assert.equal(await h.runHandler("context", { messages: [user, notice("bg-1")] }), undefined);
		} finally {
			await h.close();
		}
	});

	it("holds exit messages while a compaction runs", async () => {
		const h = await createHarness();
		try {
			// Pi reports busy while it compacts.
			h.idle = false;
			await h.emit("session_before_compact", {});
			const id = jobIdOf(await h.bash({ command: "true", run_in_background: true }));
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(h.messages.length, 0);
			h.idle = true;
			await h.emit("session_compact", {});
			const sent = await h.waitForMessage((m) => m.message.details.jobId === id, 1000);
			assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "steer" });

			// Without a closing event, Pi turning idle releases the held message.
			h.idle = false;
			await h.emit("session_before_compact", {});
			const second = jobIdOf(await h.bash({ command: "true", run_in_background: true }));
			await new Promise((resolve) => setTimeout(resolve, 400));
			assert.equal(h.messages.filter((m) => m.message.details.jobId === second).length, 0);
			h.idle = true;
			await h.waitForMessage((m) => m.message.details.jobId === second, 1000);
		} finally {
			await h.close();
		}
	});
});

describe("job tools", () => {
	it("reads output by tail and by offset, shows status and kills the process tree", async () => {
		const h = await createHarness();
		let childPid: number | undefined;
		let shellPid: number | undefined;
		try {
			const result = await h.bash({
				command: "printf 'a\\nb\\nc\\n'; sleep 300 & echo child=$!; sleep 0.5; echo d; wait",
				run_in_background: true,
			});
			const id = jobIdOf(result);
			const path = result.structuredContent.job_output_path;
			assert.ok(await waitFor(() => readFileSync(path, "utf8").includes("d\n")));
			childPid = Number(readFileSync(path, "utf8").match(/child=(\d+)/)?.[1]);
			assert.ok(childPid > 0 && isAlive(childPid));

			const tail = await h.call("job_output", { job_id: id, lines: 2 });
			assert.match(textOf(tail), /^child=\d+\nd\n\n\[Job bg-[0-9a-f]{6} is running for /);
			assert.match(textOf(tail), /Showing the last 2 lines\./);
			const size = tail.details.size as number;
			assert.match(textOf(tail), new RegExp(`Next offset: ${size}\\.\\]$`));

			const head = await h.call("job_output", { job_id: id, offset: 0 });
			assert.ok(textOf(head).startsWith("a\nb\nc\nchild="));
			assert.match(textOf(head), new RegExp(`Showing bytes 0-${size} of ${size}\\. Next offset: ${size}\\.`));
			const fromC = await h.call("job_output", { job_id: id, offset: 4 });
			assert.ok(textOf(fromC).startsWith("c\nchild="));

			const status = await h.call("job_status", {});
			shellPid = status.details.jobs.length === 1 ? Number(textOf(status).match(/PID: (\d+)/)?.[1]) : undefined;
			assert.match(textOf(status), new RegExp(`^Job ${id}: running for .*\\nCommand: printf`));
			assert.ok(shellPid && isAlive(shellPid));

			const killed = await h.call("job_kill", { job_id: id });
			assert.match(textOf(killed), new RegExp(`^Job ${id}: killed with code 143 \\(SIGTERM\\) after `));
			assert.ok(await waitFor(() => !isAlive(childPid as number)), "child process survived");
			assert.ok(await waitFor(() => !isAlive(shellPid as number)), "shell survived");
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(h.messages.length, 0, "a killed job sends no exit message");

			const again = await h.call("job_kill", { job_id: id });
			assert.match(textOf(again), new RegExp(`^Job ${id} already killed with code 143`));
			await assert.rejects(h.call("job_output", { job_id: "bg-000000" }), /Unknown job id: bg-000000\. Known job ids: /);
		} finally {
			killPid(childPid);
			killPid(shellPid);
			await h.close();
		}
	});
});

describe("output file", () => {
	it("keeps all output of a job, also above the memory spill size, and removes spill files of foreground commands", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "1" } });
		try {
			const foreground = await h.bash({ command: "head -c 3000000 /dev/zero | tr '\\0' x; echo" });
			assert.equal(foreground.structuredContent.exit_code, 0);
			assert.deepEqual(readdirSync(h.dir).filter((name) => name.startsWith("pi-job-")), []);

			const result = await h.bash({ command: "head -c 3000000 /dev/zero | tr '\\0' y; echo; sleep 1.5; echo tail-line" });
			const id = jobIdOf(result);
			await h.waitForMessage((m) => m.message.details.jobId === id);
			const content = readFileSync(result.structuredContent.job_output_path, "utf8");
			assert.equal(content.length, 3000000 + 1 + "tail-line\n".length);
			assert.ok(content.endsWith("\ntail-line\n"));
			const tail = await h.call("job_output", { job_id: id, lines: 1 });
			assert.match(textOf(tail), /^tail-line\n\n\[Job bg-[0-9a-f]{6} exited with code 0 after /);
		} finally {
			await h.close();
		}
	});
});

describe("timeouts", () => {
	it("caps an explicit timeout at the maximum", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "1", PI_SMART_TIMEOUTS_MAX_S: "1" } });
		try {
			const started = Date.now();
			const result = await h.bash({ command: "sleep 3", timeout: 100 });
			assert.ok(Date.now() - started < 1900);
			assert.match(textOf(result), /^Command still running after 1 second\./);
		} finally {
			await h.close();
		}
	});

	it("moves a command to a job when its shell exited but a child keeps writing", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "1" } });
		try {
			const started = Date.now();
			const result = await h.bash({ command: "(for i in $(seq 1 40); do echo tick; sleep 0.05; done) & echo started" });
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 1800, `returned after ${elapsed} ms`);
			assert.match(textOf(result), /^(tick\n)*started\n[\s\S]*Command still running after 1 second\./);
			const id = jobIdOf(result);
			const sent = await h.waitForMessage((m) => m.message.details.jobId === id);
			assert.match(sent.message.content, /exited with code 0/);
			assert.equal(readFileSync(result.structuredContent.job_output_path, "utf8").match(/tick/g)?.length, 40);
		} finally {
			await h.close();
		}
	});

	it("uses an explicit timeout below the default", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "30" } });
		try {
			const started = Date.now();
			const result = await h.bash({ command: "sleep 3", timeout: 1 });
			const elapsed = Date.now() - started;
			assert.ok(elapsed >= 900 && elapsed < 1900, `returned after ${elapsed} ms`);
			assert.match(textOf(result), /^Command still running after 1 second\./);
			await assert.rejects(h.bash({ command: "true", timeout: -1 }), /Invalid timeout: must be a finite number of seconds/);
			const theirs = await createBashToolDefinition(h.dir)
				.execute("c", { command: "true", timeout: -1 }, undefined, undefined, h.ctx as never)
				.catch((error: Error) => error.message);
			const ours = await h.bash({ command: "true", timeout: -1 }).catch((error: Error) => error.message);
			assert.equal(ours, theirs);
		} finally {
			await h.close();
		}
	});

	it("kills the process tree on abort, like Pi", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "30" } });
		try {
			const abortAfter = async (tool: { execute: (...args: any[]) => Promise<any> }) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 300);
				const started = Date.now();
				const message = await tool
					.execute("c", { command: "echo before; sleep 10" }, controller.signal, undefined, h.ctx)
					.then(() => "resolved", (error: Error) => error.message);
				return { message, elapsed: Date.now() - started };
			};
			const ours = await abortAfter(h.tool("bash"));
			const theirs = await abortAfter(createBashToolDefinition(h.dir) as never);
			assert.match(ours.message, /^before\n+Command aborted$/);
			assert.equal(ours.message, theirs.message);
			assert.ok(ours.elapsed < 2000);
			assert.equal(h.messages.length, 0);
		} finally {
			await h.close();
		}
	});
});

describe("shutdown", () => {
	it("kills running jobs, also ones that ignore SIGTERM, and sends no message", async () => {
		const h = await createHarness();
		const pids: number[] = [];
		try {
			const plain = await h.bash({ command: "sleep 300", run_in_background: true });
			const stubborn = await h.bash({
				command: "trap '' TERM; sleep 300 & echo child=$!; wait",
				run_in_background: true,
			});
			const path = stubborn.structuredContent.job_output_path;
			assert.ok(await waitFor(() => /child=\d+/.test(readFileSync(path, "utf8"))));
			pids.push(Number(readFileSync(path, "utf8").match(/child=(\d+)/)?.[1]));
			const status = textOf(await h.call("job_status", {}));
			for (const match of status.matchAll(/PID: (\d+)/g)) pids.push(Number(match[1]));
			assert.equal(pids.length, 3);
			assert.ok(pids.every(isAlive));
			assert.ok(jobIdOf(plain));

			const started = Date.now();
			await h.close();
			assert.ok(Date.now() - started < 3000);
			assert.ok(await waitFor(() => !pids.some(isAlive)), `alive: ${pids.filter(isAlive).join(", ")}`);
			assert.equal(h.messages.length, 0);
		} finally {
			for (const pid of pids) killPid(pid);
			await h.close();
		}
	});
});

describe("Pi compatibility", () => {
	const normalize = (value: string) => value.replace(/\/[^\s\]]*pi-bash-[0-9a-f]+\.log/g, "<full-output>");

	async function compare(command: string, truncated = false) {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "30" } });
		try {
			const pi = createBashToolDefinition(h.dir);
			const run = async (tool: { execute: (...args: any[]) => Promise<any> }) => {
				try {
					return { result: await tool.execute("c", { command }, undefined, undefined, h.ctx) };
				} catch (error) {
					return { error: (error as Error).message };
				}
			};
			const ours = await run(h.tool("bash"));
			const theirs = await run(pi as never);
			if (theirs.error !== undefined) {
				assert.equal(ours.error, theirs.error);
				return;
			}
			const a = ours.result;
			const b = theirs.result;
			assert.equal(Boolean(b.details?.truncation?.truncated), truncated);
			assert.equal(normalize(textOf(a)), normalize(textOf(b)));
			assert.equal(a.isError, b.isError);
			assert.deepEqual(a.details?.truncation, b.details?.truncation);
			assert.equal(typeof a.details?.fullOutputPath, typeof b.details?.fullOutputPath);
			const strip = (s: Record<string, unknown>) => ({ ...s, wall_time_seconds: 0, full_output_path: s.full_output_path ? "<path>" : undefined });
			assert.deepEqual(strip(a.structuredContent), strip(b.structuredContent));
		} finally {
			await h.close();
		}
	}

	it("matches Pi for line truncation", () => compare("seq 1 3000", true));
	it("matches Pi for byte truncation", () => compare("for i in $(seq 1 1000); do printf '%0100d\\n' $i; done", true));
	it("matches Pi for one oversized line", () => compare("head -c 70000 /dev/zero | tr '\\0' a", true));
	it("matches Pi for a non-zero exit", () => compare("echo oops >&2; exit 2"));
	it("matches Pi for no output", () => compare("true"));
	it("accepts a file:// shellPath and applies shellCommandPrefix", async () => {
		const h = await createHarness({ settings: { shellPath: "file:///bin/bash", shellCommandPrefix: "PREFIX=set" } });
		try {
			const result = await h.bash({ command: 'echo "$PREFIX bash=${BASH_VERSION%%.*}"' });
			assert.match(textOf(result), /^set bash=\d+\n$/);
		} finally {
			await h.close();
		}
	});

	it("matches Pi for a missing working directory", async () => {
		const h = await createHarness();
		try {
			const missing = `${h.dir}/missing`;
			const ctx = { ...h.ctx, cwd: missing };
			const pi = createBashToolDefinition(missing);
			const ours = await h.tool("bash").execute("c", { command: "true" }, undefined, undefined, ctx).catch((e: Error) => e.message);
			const theirs = await pi.execute("c", { command: "true" }, undefined, undefined, ctx as never).catch((e: Error) => e.message);
			assert.equal(ours, theirs);
		} finally {
			await h.close();
		}
	});

	it("keeps Pi's truncation for the output so far of a backgrounded command", async () => {
		const h = await createHarness({ env: { PI_SMART_TIMEOUTS_DEFAULT_S: "1" } });
		try {
			const result = await h.bash({ command: "seq 1 3000; sleep 3" });
			const text = textOf(result);
			assert.ok(text.startsWith("1001\n1002\n"));
			assert.match(text, /\n3000\n\n\[Showing lines 1001-3000 of 3000\. Full output: [^\]]+\]\n\nCommand still running after 1 second\./);
			assert.equal(result.details.truncation.truncatedBy, "lines");
			assert.equal(readFileSync(result.structuredContent.job_output_path, "utf8").split("\n").length, 3001);
		} finally {
			await h.close();
		}
	});

	it("keeps Pi's schema and prompt text and adds run_in_background", async () => {
		const h = await createHarness();
		try {
			const pi = createBashToolDefinition(h.dir);
			const bash = h.tool("bash");
			assert.deepEqual(Object.keys(bash.parameters.properties), ["command", "timeout", "run_in_background"]);
			assert.deepEqual(bash.parameters.properties.command, pi.parameters.properties.command);
			assert.deepEqual(bash.parameters.required, ["command"]);
			assert.equal(bash.parameters.properties.timeout.type, "number");
			assert.equal(bash.parameters.properties.run_in_background.type, "boolean");
			assert.ok(bash.description.startsWith(pi.description.replace("Optionally provide a timeout in seconds.", "")));
			assert.match(bash.description, /default 120, maximum 600/);
			assert.equal(bash.promptSnippet, pi.promptSnippet);
			for (const guideline of pi.promptGuidelines ?? []) assert.ok(bash.promptGuidelines?.includes(guideline));
			for (const key of Object.keys(pi.outputSchema.properties)) assert.ok(key in bash.outputSchema.properties);
		} finally {
			await h.close();
		}
	});
});

describe("configuration", () => {
	it("takes flag over env over built-in default", () => {
		assert.deepEqual(resolveConfig({}), { defaultTimeoutS: 120, maxTimeoutS: 600, warnings: [] });
		const env = { PI_SMART_TIMEOUTS_DEFAULT_S: "30", PI_SMART_TIMEOUTS_MAX_S: "900" };
		assert.equal(resolveConfig(env).defaultTimeoutS, 30);
		assert.equal(resolveConfig(env).maxTimeoutS, 900);
		const flagged = resolveConfig(env, { defaultTimeout: "45", maxTimeout: "60" });
		assert.equal(flagged.defaultTimeoutS, 45);
		assert.equal(flagged.maxTimeoutS, 60);
	});

	it("warns about invalid values and lowers a default above the maximum", () => {
		const invalid = resolveConfig({ PI_SMART_TIMEOUTS_DEFAULT_S: "soon", PI_SMART_TIMEOUTS_MAX_S: "-1" });
		assert.equal(invalid.defaultTimeoutS, 120);
		assert.equal(invalid.maxTimeoutS, 600);
		assert.equal(invalid.warnings.length, 2);
		const clamped = resolveConfig({ PI_SMART_TIMEOUTS_DEFAULT_S: "900" });
		assert.equal(clamped.defaultTimeoutS, 600);
		assert.match(clamped.warnings[0], /above the maximum/);
		assert.equal(resolveConfig({}, { defaultTimeout: true }).warnings.length, 1);
		assert.equal(resolveConfig({ PI_SMART_TIMEOUTS_MAX_S: "1e12" }).maxTimeoutS, 2_147_483.647);
	});

	it("resolves one call's timeout", () => {
		const config = resolveConfig({});
		assert.equal(resolveCallTimeout(undefined, config), 120);
		assert.equal(resolveCallTimeout(30, config), 30);
		assert.equal(resolveCallTimeout(5000, config), 600);
		assert.throws(() => resolveCallTimeout(0, config), /Invalid timeout/);
		assert.throws(() => resolveCallTimeout(Number.NaN, config), /Invalid timeout/);
	});

	it("re-registers bash with flag values at session_start", async () => {
		const h = await createHarness({ flags: { "smart-timeouts-default": "5", "smart-timeouts-max": "50" } });
		try {
			assert.match(h.tool("bash").description, /default 5, maximum 50/);
			assert.match(h.tool("bash").parameters.properties.timeout.description, /default 5, maximum 50/);
		} finally {
			await h.close();
		}
	});
});
