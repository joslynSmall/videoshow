# videoshow Domain Context

Core video playback and upstream stream resolution service converting content references into playable media.

## Language

**Video Title Search**:
The discovery and indexing of multimedia media assets through human-readable titles and metadata rather than raw resource links.
_Avoid_: URL Parsing, Direct Resolution

**Episode Collection**:
An ordered sequence of playback entries that belong to a single serialized drama or media title.
_Avoid_: Episode List, Video Matrix

**Playback Progress**:
The chronological viewing position preserved for a specific title episode to allow seamless playback resumption.
_Avoid_: Playback Bookmark, Timestamp Resume

**Hero Viewport**:
The streamlined top navigation and search entry area designed to maximize screen real estate for video playback across mobile and tablet devices.
_Avoid_: Splash Area, Top Banner, Giant Hero

**Stream Validation**:
Content-based protocol and payload verification ensuring media streams are playable prior to client handoff.
_Avoid_: Link Ping, Reachability Check

**Platform Page Search**:
Discovery of an official watch page on a domestic video site when a title is absent from the catalog.
_Avoid_: Site scrape, Web fallback, Direct resolution

**Ordered Line Switch**:
Sequential client-side switching through the lines the client holds, including Late Lines, upon playback stall or startup failure; healthy playback is never interrupted to move to a better line.
_Avoid_: Dynamic Race, Background Benchmark, Multi-hop Retry

**Late Line** (后台线路):
A line that reaches the client after playback has already started on an earlier line, delivered through the Parse Session's event stream.
_Avoid_: Background candidate, Appended line

**Short-lived Line** (短时效线路):
A line whose playlist address expires within seconds of being resolved but can be read repeatedly until then.
_Avoid_: Single-use link, 单次签名链接, singleUse

**Playlist Snapshot** (清单快照):
A stored copy of a Short-lived Line's playlist, taken within its lifetime, which keeps the line playable after the original playlist address expires.
_Avoid_: 固化清单, Cached link

**Parse Session** (解析会话):
The shared, time-bounded resolution of one video page, during which its lines appear one by one; every viewer of that page joins the same session, and it may run further resolution rounds when viewers run out of lines.
_Avoid_: Parse request, Parse cache entry

**Channel Console**:
The password-protected administrative interface allowing developers to inspect real-time playback logs, audit source health/culling ledgers, and dynamically add or remove parsing channels.
_Avoid_: Dev Drawer, Admin Panel, Debug Popup
