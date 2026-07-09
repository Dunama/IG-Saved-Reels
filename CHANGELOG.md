# Changelog

All notable changes to **Saved Reels** (Chrome extension) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/) · versioning follows [SemVer](https://semver.org/).

## [Unreleased]
### Planned
- Chrome Web Store submission (branded icons, listing copy, edge-case test pass)
- Mobile companion (separate PWA) — intentionally deferred until extension + backend are stable

## [0.5.0] — 2026-07-08
### Added
- **In-panel video playback**: clicking a reel card opens a lightbox inside the side panel — no more bouncing to Instagram
- Just-in-time video URL fetch: background worker opens the reel in a hidden tab, grabs a fresh (non-expired) video src, closes the tab
- Fallback chain: direct playback → official Instagram embed → error only if both fail
- `blob:` URL detection with fast-fail to embed (MSE object URLs are unusable outside Instagram's page)
- Prev/next navigation through the filtered reel list without closing the modal
- Keyboard controls: Escape, arrows, space
### Changed
- New permission: `scripting` (reads video src inside the hidden tab)
- Timeouts: 15s page load, 8s src polling; hidden tab always cleaned up in `finally`

## [0.4.0] — 2026-07-07
### Added
- Manual sync flow: "Sync Now" on the Instagram page is the only trigger (no automatic scraping — stays polite)
- "Last synced" indicator in the panel, from most recent `scraped_at`
- Loading/progress state during sync, auto-refresh of feed on completion
- Rate limit: no new sync within 5 minutes of the last (configurable)

## [0.3.0] — 2026-07-06
### Added
- Side panel feed UI: scrollable reel cards (thumbnail, caption preview, link to original)
- Search by caption keyword; sort by most recently saved
- Refresh button (re-fetch from Supabase, not a re-scrape)
- Deep indigo theme, Space Mono metadata, card layout

## [0.2.0] — 2026-07-05
### Added
- Supabase storage: `saved_reels` table (unique `reel_url`, `user_id` FK) with row-level security scoped per user
- Upsert with dedup by `reel_url` in the background service worker
- Keys live only in the service worker — never in content scripts
### Fixed
- RLS setup avoids the `42501` FORCE ROW LEVEL SECURITY trap hit on a previous project

## [0.1.1] — 2026-07-04
### Added
- Saved-reels scraper: defensive selectors (data attributes + aria-labels, fallbacks over brittle class names)
- MutationObserver + scroll stepping to catch lazy-loaded reels
- Session-level dedup before sending to the worker
- Floating "Sync Now" button injected on the saved reels page

## [0.1.0] — 2026-07-03
### Added
- Manifest V3 skeleton: side panel, storage + host permissions, background service worker
- `content.js` placeholder — logged `"content script loaded"` and nothing else. Where it all began.
