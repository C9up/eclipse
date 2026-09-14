/**
 * Duration parsing.
 *
 * The unit table is the one every package in the cohort uses; what differs is
 * the base unit a bare `number` means.
 *
 * NAMED DEVIATION from `@c9up/echo`, which is seconds-native because its
 * drivers are. Eclipse is **milliseconds**-native: a lease is measured against
 * wall-clock time, Redis takes `PX` in milliseconds, and the scheduler's
 * existing backend already speaks `ttlMs`. That also matches upstream verrou,
 * whose bare `number` is milliseconds. Locks and caches disagreeing about the
 * base unit is unavoidable — each is native to its own layer — so both say so
 * here rather than converting silently somewhere in the middle.
 */

/**
 * A lock duration:
 * - `number` — milliseconds (eclipse-native; see note above)
 * - `string` — human duration (`'30s'`, `'5m'`, `'2h'`, `'500ms'`, …)
 * - `null`   — never expires
 */
export type Duration = number | string | null;

const UNIT_MS: Record<string, number> = {
	ms: 1,
	msec: 1,
	msecs: 1,
	millisecond: 1,
	milliseconds: 1,
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
	w: 604_800_000,
	week: 604_800_000,
	weeks: 604_800_000,
};

const DURATION_RE = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i;

/**
 * Parse a human duration string (`'30s'`, `'5m'`, `'500ms'`) into milliseconds.
 * A unit-less numeric string is interpreted as milliseconds.
 */
export function parseDuration(value: string): number {
	const match = DURATION_RE.exec(value);
	if (!match) {
		throw new TypeError(`Eclipse: invalid duration string "${value}"`);
	}
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (unit === undefined) return amount;
	const factor = UNIT_MS[unit];
	if (factor === undefined) {
		throw new TypeError(
			`Eclipse: unknown duration unit "${unit}" in "${value}"`,
		);
	}
	return amount * factor;
}

/**
 * Resolve a {@link Duration} to milliseconds.
 *
 * @returns the duration in milliseconds, or `null` for "never expires"
 *   (an explicit `null`).
 */
export function resolveMs(
	value: Duration | undefined,
	fallback: number | null,
): number | null {
	if (value === null) return null;
	if (value === undefined) return fallback;
	return typeof value === "number" ? value : parseDuration(value);
}
