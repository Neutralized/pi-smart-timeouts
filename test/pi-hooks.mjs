/**
 * Node module hooks for the tests: resolve Pi's host packages from the installed Pi, the way
 * Pi's extension loader maps them. Nothing is installed.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function isPiRoot(dir) {
	const pkg = join(dir, "package.json");
	if (!existsSync(pkg)) return false;
	try {
		return JSON.parse(readFileSync(pkg, "utf8")).name === PI_PACKAGE;
	} catch {
		return false;
	}
}

export function findPiRoot() {
	const override = process.env.PI_SMART_TIMEOUTS_PI_ROOT;
	if (override) return override;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "pi");
		if (!existsSync(candidate)) continue;
		let current = dirname(realpathSync(candidate));
		while (current !== dirname(current)) {
			if (isPiRoot(current)) return current;
			current = dirname(current);
		}
	}
	throw new Error("Pi not found: put pi on PATH or set PI_SMART_TIMEOUTS_PI_ROOT to the package root");
}

const parentURL = pathToFileURL(join(findPiRoot(), "package.json")).href;
const HOST_PACKAGES = /^(@earendil-works\/pi-(coding-agent|ai|agent-core|tui)|typebox)(\/|$)/;

export async function resolve(specifier, context, nextResolve) {
	if (HOST_PACKAGES.test(specifier)) return nextResolve(specifier, { ...context, parentURL });
	return nextResolve(specifier, context);
}
