/**
 * Hashes a buffer with sha-256 which can be used to quickly see if a file has changed.
 */
export async function getSha256FromBuffer(buffer: BufferSource) {
	const hashBuffer = await crypto.subtle.digest("sha-256", buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
