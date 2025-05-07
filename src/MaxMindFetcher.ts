import * as fs from "jsr:@std/fs@1.0.17";
import * as stdPath from "jsr:@std/path@1.0.9";
import { UntarStream } from "jsr:@std/tar@0.1.6";
import { getSha256FromBuffer } from "./util.ts";

type MaxMindEditionId =
	| "GeoLite2-ASN"
	| "GeoLite2-ASN-CSV"
	| "GeoLite2-City"
	| "GeoLite2-City-CSV"
	| "GeoLite2-Country"
	| "GeoLite2-Country-CSV";

export type MaxMindFetcherOptions = {
	/**
	 * Path to a directory where downloaded database files will be placed.
	 */
	dbStorageDir: string;
	maxMindLicenseKey: string;
	/**
	 * The edition of the database you wish to download.
	 * MaxMind has multiple editions available, for instance `GeoLite2-Country` is a very light database,
	 * but it can only map IP addresses to a country. `GeoLite2-City` on the other hand gives you more precise locations,
	 * but at the cost of more memory usage.
	 */
	editionId: MaxMindEditionId | (string & {});
	/**
	 * Defaults to false, set to true to prevent your application from crashing.
	 * This is useful in local development, as you may not always be connected to the internet.
	 * If this is set to true, errors are silently ignored.
	 */
	ignoreNetworkErrors?: boolean;
	verbose?: boolean;
};

type DbChangeData = {
	sha256: string;
	buffer: Uint8Array;
};
type OnDbChangeCallback = (data: DbChangeData) => void;

const TIME_CHECK_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // every ten minutes
const HASH_CHECK_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // every hour

class MaxMindFetcher {
	#lastCheckedFilePath;
	#dbPath;
	#dbTempPath;
	#licenceKey;
	#editionId;
	#ignoreNetworkErrors;
	#verbose;

	/**
	 * We temporarily create this promise while we are replacing the file on disk with a new one.
	 * This is used in `getDbBuffer` to make sure we don't read the database while it is being replaced.
	 */
	#rewritePromise: Promise<void> | null = null;

	constructor({
		dbStorageDir,
		maxMindLicenseKey,
		editionId,
		ignoreNetworkErrors = false,
		verbose = false,
	}: MaxMindFetcherOptions) {
		if (!maxMindLicenseKey) {
			throw new Error("Failed to initialize maxmind fetcher, no license key set");
		}
		this.#licenceKey = maxMindLicenseKey;
		this.#editionId = editionId;
		this.#ignoreNetworkErrors = ignoreNetworkErrors;
		this.#verbose = verbose;

		this.#lastCheckedFilePath = stdPath.resolve(dbStorageDir, "lastChecked.txt");
		this.#dbPath = stdPath.resolve(dbStorageDir, "db.mmdb");
		this.#dbTempPath = stdPath.resolve(dbStorageDir, "tempDb.mmdb");

		this.#updateDbIfNotRunning();
		setInterval(() => {
			this.#updateDbIfNotRunning();
		}, TIME_CHECK_UPDATE_INTERVAL_MS); // every ten minutes
	}

	async #maxMindRequest(suffix: string) {
		const url = new URL("https://download.maxmind.com/app/geoip_download");
		url.searchParams.set("edition_id", this.#editionId);
		url.searchParams.set("license_key", this.#licenceKey);
		url.searchParams.set("suffix", suffix);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Maxmind request to "${suffix}" failed, status code was ${response.status}`);
		}
		return response;
	}

	#updateIsRunning = false;

	async #updateDbIfNotRunning() {
		if (this.#updateIsRunning) return;
		this.#updateIsRunning = true;
		try {
			await this.#updateDb();
		} finally {
			this.#updateIsRunning = false;
		}
	}

	/**
	 * Checks if the function was recently called (using a timestamp saved on disk) and if not,
	 * verifies the sha256 of the current db on disk against the hash on the maxmind servers.
	 * Downloads a new version if there is a mismatch or if the file doesn't exist.
	 */
	async #updateDb() {
		let lastCheckedStr = "";
		try {
			lastCheckedStr = await Deno.readTextFile(this.#lastCheckedFilePath);
		} catch (e) {
			if (!(e instanceof Deno.errors.NotFound)) {
				throw e;
			}
		}
		lastCheckedStr = lastCheckedStr.trim();
		if (lastCheckedStr.match(/\D/)) {
			// The contents of lastChecked.txt contain non digits, so it's probably corrupt
			// We just reset the last updated string to make sure the function keeps running
			lastCheckedStr = "";
		}

		const lastChecked = parseInt(lastCheckedStr);

		let localSha256: string | null = null;
		let tarFile;
		try {
			tarFile = await Deno.readFile(this.#dbPath);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) {
				// We leave localSha256 as 'null', causing a new db to get downloaded.
			} else {
				throw e;
			}
		}
		if (tarFile) {
			localSha256 = await getSha256FromBuffer(tarFile);
		}

		let serverSha256: string | null = null;
		if (isNaN(lastChecked) || Date.now() - lastChecked > HASH_CHECK_UPDATE_INTERVAL_MS) {
			try {
				const result = await this.#maxMindRequest("tar.gz.sha256");
				const hashText = await result.text();
				serverSha256 = hashText.split(" ")[0] || "";
			} catch (e) {
				if (this.#ignoreNetworkErrors) {
					return;
				} else {
					throw e;
				}
			}
		}

		if (serverSha256 && serverSha256 != localSha256) {
			if (this.#verbose) console.log("Downloading new database from Maxmind servers.");
			const tarResponse = await this.#maxMindRequest("tar.gz");
			const tarBuffer = await tarResponse.arrayBuffer();
			const sha256 = await getSha256FromBuffer(tarBuffer);
			if (sha256 != serverSha256) {
				throw new Error("Failed to download maxmind db, sha256 verification failed.");
			}

			const responseStream = new ReadableStream({
				start(controller) {
					controller.enqueue(tarBuffer);
					controller.close();
				},
			});
			const tarReader = responseStream.pipeThrough(new DecompressionStream("gzip")).pipeThrough(
				new UntarStream(),
			);
			let dbBuffer: Uint8Array | null = null;
			const entryNames = [];
			for await (const entry of tarReader) {
				if (!entry.readable) continue;
				entryNames.push(entry.path);
				if (!entry.path.endsWith(".mmdb")) {
					await entry.readable.cancel();
				} else {
					const [stream1, stream2] = entry.readable.tee();

					// Stream to disk
					const file = await Deno.create(this.#dbTempPath);
					const diskPromise = stream1.pipeTo(file.writable);

					// But also collect in memory so we can pass it on to the #onDbChangeCbs later.
					const chunks: Uint8Array[] = [];
					const memoryPromise = stream2.pipeTo(
						new WritableStream({
							write(chunk) {
								chunks.push(chunk);
							},
						}),
					);

					await Promise.all([diskPromise, memoryPromise]);

					let totalLength = 0;
					for (const chunk of chunks) {
						totalLength += chunk.length;
					}
					dbBuffer = new Uint8Array(totalLength);
					let offset = 0;
					for (const chunk of chunks) {
						dbBuffer.set(chunk, offset);
						offset += chunk.length;
					}
				}
			}

			if (!dbBuffer) {
				throw new Error(
					`Failed to get MaxMind database from the tar response, no .mmdb file found. Only found:\n${
						entryNames.map((e) => " - " + e).join("\n")
					}`,
				);
			}
			let resolveRewritePromise = () => {};
			this.#rewritePromise = new Promise((resolve) => {
				resolveRewritePromise = resolve;
			});
			try {
				try {
					await Deno.remove(this.#dbPath);
				} catch (e) {
					if (e instanceof Deno.errors.NotFound) {
						// This is probably the first run
					} else {
						throw e;
					}
				}
				await Deno.rename(this.#dbTempPath, this.#dbPath);
			} finally {
				resolveRewritePromise();
				this.#rewritePromise = null;
			}

			if (this.#verbose) console.log("Geoip db updated.");

			this.#onDbChangeCbs.forEach((cb) =>
				cb({
					sha256: serverSha256,
					buffer: dbBuffer,
				})
			);
		}

		await Deno.writeTextFile(this.#lastCheckedFilePath, String(Date.now()));
	}

	#onDbChangeCbs = new Set<OnDbChangeCallback>();

	onDbChange(cb: OnDbChangeCallback) {
		this.#onDbChangeCbs.add(cb);
	}

	/**
	 * Reads the latest database buffer from disk.
	 * Returns null if the database hasn't been downloaded yet.
	 */
	async getDbBuffer(): Promise<Uint8Array | null> {
		await this.#rewritePromise;
		try {
			return await Deno.readFile(this.#dbPath);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) {
				return null;
			} else {
				throw e;
			}
		}
	}
}

export async function initMaxMindFetcher(options: MaxMindFetcherOptions): Promise<MaxMindFetcher> {
	await fs.ensureDir(options.dbStorageDir);

	const fetcher = new MaxMindFetcher(options);
	return fetcher;
}
