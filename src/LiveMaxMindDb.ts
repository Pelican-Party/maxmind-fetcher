import { initMaxMindFetcher } from "./MaxMindFetcher.ts";
import { Maxmind } from "jsr:@josh-hemphill/maxminddb-wasm@2.1.1";
import type { MaxMindFetcherOptions } from "./MaxMindFetcher.ts";
import type { CityResponse, PrefixResponse } from "jsr:@josh-hemphill/maxminddb-wasm@2.1.1";

/**
 * A `LiveMaxMindDb` builds on top of the `MaxMindFetcher`. Just like the fetcher, it also keeps a database
 * up to date and writes it to disk. But in addition, it also loads the database into memory
 * using @josh-hemphill/maxminddb-wasm.
 *
 * @example
 * ```js
 * const maxMind = new LiveMaxMindDb({
 * 	editionId: "GeoLite2-Country",
 * 	dbStorageDir: "/path/to/maxMind",
 * 	maxMindLicenseKey: "<key>",
 * });
 *
 * await maxMind.lookupCity("<ip>");
 * ```
 */
export class LiveMaxMindDb {
	#db: Maxmind | null = null;

	#initialPromiseResolved = false;
	#resolveInitialDbPromise: (maxMind: Maxmind) => void = () => {};
	#dbPromise = new Promise<Maxmind>((resolve) => {
		this.#resolveInitialDbPromise = resolve;
	});

	#pendingDbLookups = new WeakMap<Maxmind, number>();
	#discardedDbs = new Set<Maxmind>();

	constructor(options: MaxMindFetcherOptions) {
		this.#init(options);
	}

	async #init(options: MaxMindFetcherOptions) {
		const fetcher = await initMaxMindFetcher(options);
		fetcher.onDbChange((data) => {
			this.#loadDb(data.buffer);
		});
		const buffer = await fetcher.getDbBuffer();
		if (buffer && !this.#db) {
			this.#loadDb(buffer);
		}
	}

	#loadDb(dbBuffer: Uint8Array) {
		if (this.#db) {
			const pending = this.#pendingDbLookups.get(this.#db) || 0;
			if (pending > 0) {
				this.#discardedDbs.add(this.#db);
			} else {
				this.#tryFreeDb(this.#db);
			}
		}

		this.#db = new Maxmind(dbBuffer);
		if (!this.#initialPromiseResolved) {
			this.#resolveInitialDbPromise(this.#db);
			this.#initialPromiseResolved = true;
		} else {
			this.#dbPromise = Promise.resolve(this.#db);
		}
	}

	#tryFreeDb(db: Maxmind) {
		try {
			db.free();
		} catch (error) {
			// This mainly exists to catch https://github.com/josh-hemphill/maxminddb-wasm/issues/10
			console.error(error);
		}
	}

	/**
	 * Runs an async function and keeps track of when it resolves.
	 * This is used to clean up old Maxmind database instances once all uses have resolved.
	 */
	async #useDb<T>(fn: (db: Maxmind) => Promise<T>): Promise<T> {
		const db = await this.#dbPromise;
		const pending = this.#pendingDbLookups.get(db) || 0;
		this.#pendingDbLookups.set(db, pending + 1);
		try {
			return await fn(db);
		} finally {
			const pending = this.#pendingDbLookups.get(db) || 0;
			const newPending = pending - 1;
			this.#pendingDbLookups.set(db, newPending);
			if (newPending <= 0) {
				if (this.#discardedDbs.has(db)) {
					this.#tryFreeDb(db);
					this.#discardedDbs.delete(db);
				}
			}
		}
	}

	/**
	 * See https://jsr.io/@josh-hemphill/maxminddb-wasm@2.1.1/doc/~/Maxmind.prototype.lookup_city
	 */
	async lookupCity(ipAddress: string): Promise<CityResponse> {
		return await this.#useDb(async (db) => {
			return await db.lookup_city(ipAddress);
		});
	}

	/**
	 * See https://jsr.io/@josh-hemphill/maxminddb-wasm@2.1.1/doc/~/Maxmind.prototype.lookup_prefix
	 */
	async lookupPrefix(ipAddress: string): Promise<PrefixResponse> {
		return await this.#useDb(async (db) => {
			return await db.lookup_prefix(ipAddress);
		});
	}
}
