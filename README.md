# maxmind-fetcher

This package allows you to easily fetch a [MaxMind](https://www.maxmind.com/en/home) database from within your application
as well as load an instance into memory which always stays up to date.

## Usage

```ts
import { LiveMaxMindDb } from "jsr:@pelicanparty/maxmind-fetcher";
import { resolve } from "jsr:@std/path";

const maxMind = new LiveMaxMindDb({
	editionId: "GeoLite2-Country",
	dbStorageDir: resolve("./path/to/maxmind"),
	maxMindLicenseKey: MAXMIND_LICENSE_KEY,
});

const result = await maxMind.lookupCity(ipAddress);
```
