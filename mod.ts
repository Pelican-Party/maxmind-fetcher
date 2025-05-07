/**
 * @module
 * This module contains the main exports from maxmind-fetcher.
 *
 * @example
 * ```ts
 * const maxMind = new LiveMaxMindDb({
 * 	editionId: "GeoLite2-Country",
 * 	dbStorageDir: "/path/to/maxMind",
 * 	maxMindLicenseKey: "<key>",
 * });
 *
 * await maxMind.lookupCity("<ip>");
 * ```
 */

export { initMaxMindFetcher } from "./src/MaxMindFetcher.ts";
export { LiveMaxMindDb } from "./src/LiveMaxMindDb.ts";
