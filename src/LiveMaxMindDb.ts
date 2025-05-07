import { initMaxMindFetcher } from "./MaxMindFetcher.ts";
import { Maxmind } from "jsr:@josh-hemphill/maxminddb-wasm@2.1.1";
import type { MaxMindFetcherOptions } from "./MaxMindFetcher.ts";
import type { CityResponse, PrefixResponse } from "jsr:@josh-hemphill/maxminddb-wasm@2.1.1";

export class LiveMaxMindDb {
	#db: Maxmind | null = null;

	#initialPromiseResolved = false;
	#resolveInitialDbPromise: (maxMind: Maxmind) => void = () => {};
	#dbPromise = new Promise<Maxmind>((resolve) => {
		this.#resolveInitialDbPromise = resolve;
	});

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
	 * // maxMind.db
	 * await maxMind.lookupCity("<ip>");
	 * ```
	 */
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
			this.#db.free();
		}

		this.#db = new Maxmind(dbBuffer);
		if (!this.#initialPromiseResolved) {
			this.#resolveInitialDbPromise(this.#db);
			this.#initialPromiseResolved = true;
		} else {
			this.#dbPromise = Promise.resolve(this.#db);
		}
	}

	async lookupCity(ipAddress: string): Promise<CityResponse> {
		return (await this.#dbPromise).lookup_city(ipAddress);
	}

	async lookupPrefix(ipAddress: string): Promise<PrefixResponse> {
		return (await this.#dbPromise).lookup_prefix(ipAddress);
	}
}
