/** Timeout configuration: Pi flag beats environment variable beats built-in default. */

export const BUILTIN_DEFAULT_TIMEOUT_S = 120;
export const BUILTIN_MAX_TIMEOUT_S = 600;

export const ENV_DEFAULT_TIMEOUT = "PI_SMART_TIMEOUTS_DEFAULT_S";
export const ENV_MAX_TIMEOUT = "PI_SMART_TIMEOUTS_MAX_S";

export const FLAG_DEFAULT_TIMEOUT = "smart-timeouts-default";
export const FLAG_MAX_TIMEOUT = "smart-timeouts-max";

/** Node's setTimeout fires at once above 2^31 - 1 ms. */
export const TIMER_LIMIT_S = 2_147_483_647 / 1000;

export interface SmartTimeoutsConfig {
	defaultTimeoutS: number;
	maxTimeoutS: number;
	warnings: string[];
}

export interface FlagValues {
	defaultTimeout?: string | boolean;
	maxTimeout?: string | boolean;
}

type Env = Record<string, string | undefined>;

function pickSeconds(
	sources: Array<{ label: string; value: string | boolean | undefined }>,
	fallback: number,
	warnings: string[],
): number {
	for (const { label, value } of sources) {
		if (value === undefined || value === "" || value === false) continue;
		if (value === true) {
			warnings.push(`Ignoring ${label}: it needs a number of seconds.`);
			continue;
		}
		const seconds = Number(value.trim());
		if (!Number.isFinite(seconds) || seconds <= 0) {
			warnings.push(`Ignoring ${label}=${value}: expected a positive number of seconds.`);
			continue;
		}
		return Math.min(seconds, TIMER_LIMIT_S);
	}
	return fallback;
}

export function resolveConfig(env: Env, flags: FlagValues = {}): SmartTimeoutsConfig {
	const warnings: string[] = [];
	const maxTimeoutS = pickSeconds(
		[
			{ label: `--${FLAG_MAX_TIMEOUT}`, value: flags.maxTimeout },
			{ label: ENV_MAX_TIMEOUT, value: env[ENV_MAX_TIMEOUT] },
		],
		BUILTIN_MAX_TIMEOUT_S,
		warnings,
	);
	let defaultTimeoutS = pickSeconds(
		[
			{ label: `--${FLAG_DEFAULT_TIMEOUT}`, value: flags.defaultTimeout },
			{ label: ENV_DEFAULT_TIMEOUT, value: env[ENV_DEFAULT_TIMEOUT] },
		],
		BUILTIN_DEFAULT_TIMEOUT_S,
		warnings,
	);
	if (defaultTimeoutS > maxTimeoutS) {
		warnings.push(
			`Default timeout ${defaultTimeoutS}s is above the maximum ${maxTimeoutS}s; using ${maxTimeoutS}s.`,
		);
		defaultTimeoutS = maxTimeoutS;
	}
	return { defaultTimeoutS, maxTimeoutS, warnings };
}

/**
 * Foreground timeout for one call. Validates like Pi's bash tool, then applies the default and
 * the cap.
 */
export function resolveCallTimeout(requested: unknown, config: SmartTimeoutsConfig): number {
	if (requested === undefined) return config.defaultTimeoutS;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	return Math.min(requested, config.maxTimeoutS);
}
