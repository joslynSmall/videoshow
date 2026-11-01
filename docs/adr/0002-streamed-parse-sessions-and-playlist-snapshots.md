# Streamed Parse Sessions and Playlist Snapshots

Resolution becomes a streamed, shared Parse Session keyed by video page, and Short-lived Lines are carried by a Playlist Snapshot taken on the server. Playback failed because qilin/lx playlist addresses expire about 6-8 seconds after resolve while parsing took 9-17 seconds, so those lines reached the client dead; they were modelled as "single-use" and left unread, and late lines were written to a server cache the client never read again.

## Status

accepted

## Decision

- Streaming is the only resolution path. `GET /api/resolve` (SSE) replaces `/api/parse` and `/api/race`; the client plays the first valid line, and Late Lines are held for Ordered Line Switch. A viewer who runs out of lines asks for a further round on the same session (`refresh=1`), rate limited per session.
- A line switches only on Startup failure or stall. There is no quality upgrade while playback is healthy and no manual line picker, so viewers may stay on the 720p line that arrived first. Startup failure is progress-aware: 10s without any download progress, at most 20s while data is still arriving.
- The server reads a Short-lived Line's playlist within its lifetime, then treats the snapshot like any other line: Stream Validation, benchmark, equal ranking. Snapshots are served by `GET /api/snapshot`, only for lines that exist in a live session. A short-lived link that is not a playlist (bingdou mp4) cannot be snapshotted and stays unverified.
- Parse Sessions and snapshots live in process memory for `CACHE_TTL_MS` (5 minutes). After a restart, a further resolution round restores them.
- Duplicate lines are detected by playlist host plus segment list (tokens ignored), session-wide. Identical segments behind a different playlist host are a different line: the production recovery that motivated this ADR was exactly a second playlist host serving the same segments. A failed benchmark releases the key.
- Failures are recorded by evidence, on the client and for the current viewer only. A playlist HTTP error, a startup timeout or a stall excludes that one line; a network-level failure of a playlist or segment host (including 502/503/504 from our relay) counts against the host, which is excluded after two strikes. A snapshot's original host is never blamed for a manifest failure, because we serve the manifest.

## Evidence

Fresh links returned 200 on repeated GETs in 6 of 6 rounds, then 404 once about 6-8 seconds old. This overturns commit `aaaf56d`, whose "any GET consumes the signature" reading came from a link that had simply expired, so reading a playlist early is safe. A locally resolved link was readable through production `/api/media`, so links are not bound to the resolving IP. hls.js played PNG-wrapped segments from a snapshot, with no errors, after the original address returned 404, both in an isolated page and through the real client with a late snapshot line switched to after a dead first line. Tokenised segments stayed readable for at least 5 minutes, which is why the session lifetime is 5 minutes.

## Considered Options

- Keep `/api/parse` as a thin JSON wrapper over the session: rejected by the project owner in favour of a single entry point.
- Server-side reselection through `/api/race`: rejected because a server benchmark does not show what the browser can play, and each switch would cost another benchmark round.
- Short-lived Lines as backups only: rejected because startup would keep waiting 9-17 seconds for jx-browser.
- Dedupe by segment list alone: rejected, it would have dropped the line that actually recovered playback.

## Consequences

Parsing now depends on a long-lived connection, so events carry cursors and replay idempotently on reconnect. The production nginx config is not in this repo, so streaming relies on response headers (`X-Accel-Buffering: no`) and heartbeats rather than proxy changes; whether that is enough has to be confirmed after deployment. Removing `/api/parse` breaks any caller outside this repo.
