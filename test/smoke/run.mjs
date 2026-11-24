/**
 * Smoke tests against the installed `pi` with the scripted faux model in faux-model.ts.
 * Uses a throwaway agent directory and temp directory; no network, no model, no settings changes.
 *
 *   node test/smoke/run.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = mkdtempSync(join(tmpdir(), "pi-smart-timeouts-smoke-"));
mkdirSync(join(work, "agent"));
mkdirSync(join(work, "tmp"));
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: join(work, "agent"),
	TMPDIR: join(work, "tmp"),
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
};
const piArgs = [
	"--no-session",
	"-ne",
	"-nc",
	"-na",
	"-e",
	"test/smoke/faux-model.ts",
	"-e",
	".",
	"--provider",
	"smoke",
	"--model",
	"smoke-1",
];

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPi(args, scenario, stdin) {
	const child = spawn("pi", [...args], {
		cwd: root,
		env: { ...env, SMOKE_SCENARIO: scenario },
		stdio: [stdin, "pipe", "pipe"],
	});
	const killer = setTimeout(() => {
		if (child.pid) process.kill(child.pid, "SIGKILL");
	}, 60_000);
	const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
	exited.then(() => clearTimeout(killer));
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	return { child, exited, stderr: () => stderr };
}

function parseReport(text, label) {
	assert.ok(text.startsWith(`${label} `), `expected ${label}, got: ${text.slice(0, 300)}`);
	return JSON.parse(text.slice(label.length + 1));
}

async function busyScenario() {
	const pi = startPi(["-p", ...piArgs, "go"], "busy", "ignore");
	let stdout = "";
	pi.child.stdout.on("data", (d) => {
		stdout += d;
	});
	const code = await pi.exited;
	assert.equal(code, 0, pi.stderr());
	const report = parseReport(stdout.trim(), "SMOKE-BUSY");
	assert.match(report.toolResults[0], /^first\n[\s\S]*Command still running after 1 second\. It continues as background job bg-/);
	assert.match(report.toolResults[0], /The job keeps running, and a message arrives when it exits\.$/);
	assert.equal(report.toolResults[1], "waited\n");
	assert.equal(report.exitMessages.length, 1);
	assert.match(report.exitMessages[0], /^Background job bg-[0-9a-f]{6} exited with code 0 after /);
	assert.match(report.exitMessages[0], /Last 2 lines:\nfirst\nsecond/);
	assert.deepEqual(report.order, ["user", "assistant", "toolResult", "assistant", "toolResult", "user"]);
	return "busy: job exit message steered in between the second tool result and the third model call";
}

async function idleScenario() {
	const pi = startPi(["--mode", "rpc", ...piArgs], "idle", "pipe");
	const events = [];
	const waiters = [];
	let buffer = "";
	pi.child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			const event = JSON.parse(line);
			events.push(event);
			for (const waiter of [...waiters]) {
				if (waiter.test(event)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(event);
				}
			}
		}
	});
	const waitFor = (test, ms = 20_000) =>
		new Promise((resolve, reject) => {
			const found = events.find(test);
			if (found) return resolve(found);
			const timer = setTimeout(() => reject(new Error(`timeout; stderr: ${pi.stderr()}`)), ms);
			waiters.push({
				test,
				resolve: (event) => {
					clearTimeout(timer);
					resolve(event);
				},
			});
		});
	const textOf = (message) =>
		(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
	const assistantText = (prefix) => (event) =>
		event.type === "message_end" && event.message?.role === "assistant" && textOf(event.message).startsWith(prefix);
	const send = (command) => pi.child.stdin.write(`${JSON.stringify(command)}\n`);

	send({ id: "1", type: "prompt", message: "go" });
	await waitFor(assistantText("WAITING"));
	await waitFor((event) => event.type === "agent_settled" || event.type === "agent_end");
	const settledAt = events.length;
	const reportEvent = await waitFor(assistantText("SMOKE-IDLE"));
	const report = parseReport(textOf(reportEvent.message), "SMOKE-IDLE");
	const between = events.slice(settledAt, events.indexOf(reportEvent)).map((event) => event.type);
	assert.ok(between.includes("agent_start"), `no new run started: ${between.join(",")}`);
	assert.equal(report.exitMessages.length, 1);
	assert.match(report.exitMessages[0], /exited with code 0 after .*\n[\s\S]*idle-done/);
	assert.deepEqual(report.order, ["user", "assistant", "toolResult", "assistant", "user"]);

	send({ id: "2", type: "prompt", message: "start" });
	await waitFor(assistantText("STARTED"));
	const toolResult = [...events]
		.reverse()
		.find((event) => event.type === "message_end" && event.message?.role === "toolResult");
	const outputPath = textOf(toolResult.message).match(/Job output file: (\S+)/)[1];
	let pid;
	for (let i = 0; i < 100 && !pid; i++) {
		pid = Number(readFileSync(outputPath, "utf8").match(/pid=(\d+)/)?.[1]) || undefined;
		if (!pid) await sleep(50);
	}
	assert.ok(pid && isAlive(pid), "background sleep is not running");
	pi.child.stdin.end();
	const code = await pi.exited;
	let dead = false;
	for (let i = 0; i < 40 && !dead; i++) {
		dead = !isAlive(pid);
		if (!dead) await sleep(50);
	}
	if (!dead) process.kill(pid, "SIGKILL");
	assert.ok(dead, `job pid ${pid} survived Pi's shutdown`);
	return `idle: exit message started a new run; shutdown (stdin closed, exit ${code}) killed job pid ${pid}`;
}

try {
	console.log(await busyScenario());
	console.log(await idleScenario());
	console.log("smoke tests passed");
} finally {
	rmSync(work, { recursive: true, force: true });
}
