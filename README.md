<img src="savedReelsLogo.png" alt="Saved Reels logo" width="80" align="left" />

# Saved Reels

A Chrome side-panel extension that syncs your saved Instagram reels, so you can search and browse them anytime — even outside Instagram.

<br clear="left" />

Instagram buries your saved reels behind endless scrolling with no search. Saved Reels scrapes your saved page on demand, stores each reel (link, thumbnail, caption) in a database **you own**, and gives you a searchable, sortable feed in Chrome's side panel with inline playback.

## Features

- One-click **Sync Now** button on your Instagram saved page (manual by design — no bot-like background scraping)
- Side-panel feed with caption search, newest/oldest sort, and inline reel playback
- Your data lives in **your own** Supabase project, protected by row-level security
- Sign in / sign up with email and password (Supabase Auth under the hood)
- No build step, no dependencies — plain Manifest V3

## Setup

Requirements: Chrome 114+ (side panel API) and a free [Supabase](https://supabase.com) account.

1. **Clone the repo**:

   ```bash
   git clone https://github.com/Dunama/IG-Saved-Reels.git
   ```

2. **Create a Supabase project**, then in the SQL Editor run the migration in [`supabase/001_saved_reels.sql`](supabase/001_saved_reels.sql). This creates the `saved_reels` table with RLS policies so each user can only touch their own rows.

3. **Configure credentials**: copy `.env.example` to `.env` and fill in your project URL and anon key (Supabase dashboard → Settings → API):

   ```dotenv
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   ```

4. **Load the extension**: open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the cloned folder.

5. **Create your account**: click the extension icon to open the side panel, choose "Create an account", and sign up. (If email confirmation is enabled in your Supabase Auth settings, confirm via the emailed link first.)

6. **Sync**: go to your saved reels on Instagram (`instagram.com/<you>/saved/`) and click the floating **Sync Now** button. Your reels appear in the side panel.

## Architecture

```
Instagram saved page          Chrome extension                 Supabase
┌──────────────────┐   msg   ┌────────────────────┐   REST   ┌──────────────┐
│ content.js       │ ──────▶ │ background.js      │ ───────▶ │ GoTrue auth  │
│ scrape + dedupe  │         │ auth + upsert      │          │ PostgREST    │
│ Sync Now button  │         │ (holds .env keys)  │ ◀─────── │ saved_reels  │
└──────────────────┘         └────────▲───────────┘          └──────────────┘
                                      │ msg
                             ┌────────┴───────────┐
                             │ sidepanel.js       │
                             │ feed, search, sort │
                             └────────────────────┘
```

Design decisions worth knowing:

- **No supabase-js**: MV3 forbids remote code and the SDK needs a bundler, so the service worker calls Supabase's REST APIs directly with `fetch`.
- **Credentials isolation**: only the background service worker reads `.env`. Content scripts and the panel never see keys — they message the worker.
- **Unspoofable ownership**: `user_id` is never sent by the client; the column defaults to `auth.uid()` server-side.
- **Defensive scraping**: selectors target Instagram's URL scheme (`a[href*="/reel/"]`) and landmarks, never obfuscated class names. Instagram DOM changes may still break scraping — see caveats.

## Caveats

- Instagram thumbnail URLs are signed and **expire after a while**; old cards degrade to a placeholder. Re-syncing refreshes them.
- Captions come from image alt text, which is sometimes Instagram's auto-description rather than the real caption.
- Scraping your own saved page for personal use is low-risk but technically against Instagram's terms of service. Use at your own discretion; sync is manual by design and only runs when you click Sync Now.

## Security notes

- `.env` is gitignored and must never be committed. `.env.example` is the safe template.
- The Supabase **anon key** is designed to be client-side public — data is protected by RLS, not key secrecy. Never put your `service_role` key anywhere in this project.
- Auth tokens are stored in `chrome.storage.local`, scoped to this extension.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history — from `"content script loaded"` to in-panel playback.

## License

[MIT](LICENSE)
