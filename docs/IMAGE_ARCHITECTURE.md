# D1-first image display

Image IDs identify immutable R2 objects. Originals and HD cutouts stay in R2. Migration 0007 adds separate binary WebP tables (`garment_thumbnails`, `outfit_thumbnails`), durable jobs, usage counters and a 64 MiB derivative storage cap. It does not modify existing R2 data. Foreign keys and triggers follow image ownership during merge/split, remove deleted derivatives, invalidate replaced SHA values and queue new images. A late encoder uses an INSERT…SELECT with the expected source SHA and current owner, so it cannot publish over a newer source.

## Encoding and work limits

Fit inside 240×300 without upscaling, WebP quality 82→68→50, then reduce dimensions to 80/64/50%. Preserve alpha. Hard maximum 30 KiB; simple images may be smaller than 15 KiB and are not padded. Browser uploads generate derivatives from pixels already in memory. Failure leaves the original upload successful and a job pending. Existing compatible small WebP uploads populate D1 immediately, including their exact `derived_from` source.

Missing derivatives from API/AI imports are durably queued. By default, the signed-in visible PWA claims one job after 15 seconds, downloads one source, encodes locally, writes the derivative, then yields 15 seconds. It pauses offline/hidden/at budget and stops on logout. Leases expire after 5 minutes; three failed attempts require inspection. Background app suspension delays completion until the app reopens. This avoids forcing an upgrade to Workers Paid just for decoding. No image generation services are used.

Optional server WASM processing is disabled by default. `THUMBNAIL_SERVER_ENCODING=enabled` should only be enabled after checking the Workers CPU plan and runtime telemetry. It processes four sequential images per existing cron invocation, with PNG/JPEG/WebP support, 6MP/12MiB decode guards and source-checksum validation. Free Workers CPU limits make this unsuitable as a default. Local administrative backfill can use `scripts/encode-thumbnail-backfill.mjs` with reserved reads, at most two simultaneous downloads, 16-image batches and per-image SQL checkpoints. Original R2 files are read only and downloaded scratch copies are removed after encoding.

## Display, APIs and caching

- `WardrobeImage`: D1-only preview by default, intersection-based visibility, decoded-before-display, shared requests, manual retry and an accessible placeholder rather than broken-image icons.
- All lists, detail cards, home/review/search/filter results and outfit previews use it. Detail requests HD only on edit or “載入高清細節”. Studio canvas loads HD in edit mode; the garment picker remains D1-only. HD failure retains the already displayed D1 preview.
- Export calls a separate HD-only loader and aborts if any item is unavailable or not transparent. It never substitutes previews or silently omits failed items.
- `GET /api/thumbnails?ids=…&data=1`: up to 16 unique image IDs, base64 transport only in this dedicated API (D1 stores BLOBs). No image payload in garment queries. Without `data=1`, returns metadata and versioned URLs. Cursor pagination uses image ID and a maximum of 16.
- `GET /api/thumbnails/:image_id?v=<content-version>`: authenticated binary WebP, ETag/304, private immutable one-year cache for a matching version. Unversioned reads cache one hour. Missing thumbnail: 404 `thumbnail_pending`, Retry-After 60; never automatic R2 fallback.
- Browser combines requests into batches of 16, max two in flight. Memory holds 64 compressed thumbnails; CacheStorage holds at most 256 (~7.5 MiB plus headers). Individual object URLs are released on unmount. Refresh clears image caches. Version comes from thumbnail content SHA; new/replacement source images use new IDs. Merge/split retain IDs and invalidate no unrelated cache.
- Service worker stores at most 96 authenticated display JSON responses for offline reopening. Auth status can be reused offline only after a successful online login on this device. It never caches tokens, MCP, signed URLs or HD images. Logout/401 clears private caches; this is local offline availability, not a bypass of server authorization. iOS can evict stored data; only previously viewed cached images/pages can reopen offline.

## Cost accounting

Feature-local daily caps (HK day): 600 reserved R2 reads, 12,000 thumbnail read requests, 192 MiB of thumbnail responses. Reserve conservatively before fetching data, including base64 expansion/metadata. Actual response sizes and D1-reported query rows_read are recorded; request counters and reservations themselves require D1 reads/writes, as do authentication, jobs and index triggers. Counters are not a complete account-wide billing meter. D1 free allowances are shared with other database queries, and R2 operations elsewhere in the app/account are additional. These caps do **not** guarantee a zero Cloudflare bill. The 64 MiB derivative storage cap does not include original garment records or other databases. No automatic paid-plan upgrades.

## Diagnosis and validation

Before implementation, 438 live garment image records had matching R2 objects and byte lengths; recent inspected image requests returned HTTP 200, and the filtered telemetry query returned no matching HTTP errors. This does not prove historical failures did not occur. Existing UI loaded HD images in grids, had no bounded loading queue and did not cache private image bytes for offline reopening. Those are verified design weaknesses, not a proven root cause of every reported failure. Image API now distinguishes missing metadata (404), missing R2 object (404) and R2 read failure (503); 4xx error codes are logged without query credentials. Full-response stream interruptions and client decode failures still need client/device reproduction.

Tests cover real WebP encoding/alpha/size, source byte preservation, ownership and replacement races, read budgets, batches, pagination, conditional caching, rapid consumers, offline reopening and private-cache logout. Browser/physical iPhone results must be stated separately; mocked browser tests are not an iOS certification.
