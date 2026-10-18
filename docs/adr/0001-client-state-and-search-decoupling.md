# Client-Side Playback State and Decoupled Aggregator Search

Playback progress and watch history are persisted in client browser storage while title search is decoupled from core stream resolution via dual-track aggregation. The top layout adopts a permanent compact streamlined header to maximize viewport space for video playback on mobile and tablet devices.

## Status

accepted

## Considered Options

- Play-to-collapse giant hero: rejected by user in favor of an always-compact streamlined header that natively prioritizes video playback.
- Server-side database persistence: rejected because it introduces heavyweight runtime dependencies and user session complexity contrary to the zero-dependency goal.
- Scraping video platforms on demand: rejected because platform search interfaces enforce aggressive rate limiting and unstable anti-scraping mechanisms.
- Dual-track search and client storage: chosen because it supports both title queries and direct media URLs while keeping playback progress persistent on-device.
