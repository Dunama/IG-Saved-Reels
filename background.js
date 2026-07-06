// IG Saved Reels - background service worker (Manifest V3)
// Phase 3: Supabase-backed storage.
//
// Design notes:
// - MV3 forbids remote code and supabase-js needs a bundler, so this talks
//   to Supabase's REST APIs (GoTrue auth, PostgREST data) with plain fetch.
// - Credentials come ONLY from .env in the extension folder, fetched at
//   runtime via chrome.runtime.getURL(). Single source of truth, nothing
//   hardcoded, .env is gitignored. content.js never sees the keys.

const TAG = "[IG Saved Reels]";

//  Config (.env) 

let _cfg = null;

async function getConfig() {
  if (_cfg) return _cfg;
  let text;
  try {
    const res = await fetch(chrome.runtime.getURL(".env"));
    if (!res.ok) throw new Error(res.statusText);
    text = await res.text();
  } catch (e) {
    throw new Error(".env not readable — is it in the extension folder?");
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing in .env");
  }
  _cfg = { url: env.SUPABASE_URL, key: env.SUPABASE_ANON_KEY };
  console.log(TAG, "config loaded from .env");
  return _cfg;
}

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(TAG, "setPanelBehavior failed:", err));

//  Toolbar icon 
// Chrome's manifest icons want PNG; we only ship logo.svg. So the logo
// (bookmark + play on an amber tile) is redrawn here on an OffscreenCanvas
// and set at runtime — crisp at every size, no PNG files needed.

function paintIcon(size) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.scale(size / 128, size / 128); // author in 128-space, render at any size

  ctx.beginPath();
  ctx.roundRect(4, 4, 120, 120, 30);
  ctx.fillStyle = "#0c1014";
  ctx.fill();

  const g = ctx.createLinearGradient(10, 10, 118, 118);
  g.addColorStop(0, "#ffc46e");
  g.addColorStop(1, "#ff9840");
  ctx.beginPath();
  ctx.roundRect(10, 10, 108, 108, 25);
  ctx.fillStyle = g;
  ctx.fill();

  // bookmark + play triangle (same paths as logo.svg)
  ctx.fillStyle = "#0c1014";
  ctx.fill(
    new Path2D(
      "M42 30h44a8 8 0 0 1 8 8v62a4 4 0 0 1-6.3 3.2L64 86.5 40.3 103.2A4 4 0 0 1 34 100V38a8 8 0 0 1 8-8z"
    )
  );
  ctx.fillStyle = "#ffb454";
  ctx.fill(new Path2D("M56 48 L78 61 L56 74 Z"));

  return ctx.getImageData(0, 0, size, size);
}

function setToolbarIcon() {
  try {
    const imageData = {};
    for (const size of [16, 32, 48, 128]) imageData[size] = paintIcon(size);
    chrome.action.setIcon({ imageData });
  } catch (err) {
    console.warn(TAG, "icon paint failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(setToolbarIcon);
setToolbarIcon(); // also on every service-worker start

//  Auth (GoTrue REST) 

async function signIn(email, password) {
  const { url, key } = await getConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Sign-in failed");
  await saveSession(data);
  return { email: data.user?.email };
}

// Create a Saved Reels account (GoTrue signup). If email confirmation is
// enabled in Supabase, no session is returned — the user must confirm
// via the emailed link, then sign in.
async function signUp(email, password) {
  const { url, key } = await getConfig();
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Sign-up failed");
  if (data.access_token) {
    await saveSession(data);
    return { email: data.user?.email, confirmed: true };
  }
  return { email: data.email ?? email, confirmed: false };
}

async function saveSession(data) {
  await chrome.storage.local.set({
    session: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      email: data.user?.email ?? null,
      user_id: data.user?.id ?? null,
    },
  });
}

async function signOut() {
  await chrome.storage.local.remove("session");
}

// Returns a valid access token, refreshing if within 60s of expiry.
// Refreshes are serialized via _refreshing: Supabase rotates refresh
// tokens, so two parallel refreshes would invalidate each other and
// force a spurious sign-out mid-sync.
let _refreshing = null;

async function getAccessToken() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) throw new Error("Not signed in");
  if (Date.now() < session.expires_at - 60_000) return session.access_token;

  if (!_refreshing) {
    _refreshing = doRefresh(session).finally(() => (_refreshing = null));
  }
  return _refreshing;
}

async function doRefresh(session) {
  const { url, key } = await getConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const data = await res.json();
  if (!res.ok) {
    await signOut(); // stale refresh token — force re-login
    throw new Error("Session expired, please sign in again");
  }
  await saveSession(data);
  return data.access_token;
}

async function getAuthState() {
  const { session } = await chrome.storage.local.get("session");
  return session ? { signedIn: true, email: session.email } : { signedIn: false };
}

//  Data (PostgREST) 

// Upsert scraped reels, deduped by reel_url. user_id is NOT sent — the
// column defaults to auth.uid() server-side, so it can't be spoofed.
async function upsertReels(reels) {
  const { url, key } = await getConfig();
  const token = await getAccessToken();
  const rows = reels
    .filter((r) => r?.reel_url)
    .map((r) => ({
      reel_url: r.reel_url,
      thumbnail_url: r.thumbnail_url ?? null,
      caption: r.caption ?? null,
      scraped_at: r.scraped_at ?? new Date().toISOString(),
    }));
  if (!rows.length) return 0;

  const res = await fetch(`${url}/rest/v1/saved_reels?on_conflict=reel_url`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Upsert failed (${res.status}): ${err}`);
  }
  console.log(TAG, `upserted ${rows.length} reels to Supabase`);
  return rows.length;
}

// Read-only fetch for the side panel feed. RLS limits rows to the
// signed-in user; order applied server-side.
async function fetchReels({ ascending = false } = {}) {
  const { url, key } = await getConfig();
  const token = await getAccessToken();
  const order = ascending ? "scraped_at.asc" : "scraped_at.desc";
  const res = await fetch(
    `${url}/rest/v1/saved_reels?select=reel_url,thumbnail_url,caption,scraped_at&order=${order}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
      },
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Fetch failed (${res.status}): ${err}`);
  }
  return res.json();
}

//  Message hub 

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (p) => sendResponse(p);

  switch (message?.type) {
    case "SCRAPED_REELS":
      upsertReels(message.reels)
        .then((n) => respond({ ok: true, upserted: n }))
        .catch((err) => {
          console.error(TAG, "upsert failed:", err);
          respond({ ok: false, error: String(err.message || err) });
        });
      return true;

    case "SYNC_COMPLETE":
      console.log(TAG, "sync complete, session total:", message.total);
      respond({ ok: true });
      return false;

    case "SIGN_IN":
      signIn(message.email, message.password)
        .then((u) => respond({ ok: true, ...u }))
        .catch((err) => respond({ ok: false, error: String(err.message || err) }));
      return true;

    case "SIGN_UP":
      signUp(message.email, message.password)
        .then((u) => respond({ ok: true, ...u }))
        .catch((err) => respond({ ok: false, error: String(err.message || err) }));
      return true;

    case "SIGN_OUT":
      signOut().then(() => respond({ ok: true }));
      return true;

    case "GET_AUTH_STATE":
      getAuthState().then(respond);
      return true;

    case "FETCH_REELS":
      fetchReels({ ascending: message.ascending })
        .then((reels) => respond({ ok: true, reels }))
        .catch((err) => respond({ ok: false, error: String(err.message || err) }));
      return true;

    default:
      return false;
  }
});

console.log(TAG, "service worker started");
