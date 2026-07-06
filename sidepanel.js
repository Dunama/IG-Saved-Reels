// IG Saved Reels - side panel (Phase 4: feed UI)

const $ = (id) => document.getElementById(id);

const send = (msg) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    })
  );

//  State 

let allReels = [];        // full fetched set
let query = "";           // caption search
let newestFirst = true;   // sort direction

//  Auth 

async function refreshAuthUI() {
  const state = await send({ type: "GET_AUTH_STATE" });
  const signedIn = !!state?.signedIn;
  $("auth").hidden = signedIn;
  $("toolbar").hidden = !signedIn;
  $("feed").hidden = !signedIn;
  $("signout-btn").hidden = !signedIn;
  $("refresh-btn").hidden = !signedIn;
  if (signedIn) loadReels();
}

// Sign in <-> sign up toggle
let authMode = "signin";

$("auth-toggle").addEventListener("click", () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  const signin = authMode === "signin";
  $("auth-hint").textContent = signin
    ? "Sign in to Saved Reels to see your synced reels."
    : "Create your Saved Reels account.";
  $("auth-submit").textContent = signin ? "Sign in" : "Create account";
  $("auth-toggle").textContent = signin
    ? "New here? Create an account"
    : "Already have an account? Sign in";
  $("auth-error").hidden = true;
  $("auth-msg").hidden = true;
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("auth-error");
  const msgEl = $("auth-msg");
  errEl.hidden = true;
  msgEl.hidden = true;
  const submit = $("auth-submit");
  submit.disabled = true;

  const payload = {
    type: authMode === "signin" ? "SIGN_IN" : "SIGN_UP",
    email: $("auth-email").value.trim(),
    password: $("auth-password").value,
  };
  const res = await send(payload);
  submit.disabled = false;

  if (res?.ok && authMode === "signup" && !res.confirmed) {
    // Email confirmation enabled in Supabase — no session yet.
    msgEl.textContent = "Check your email to confirm your account, then sign in.";
    msgEl.hidden = false;
    return;
  }
  if (res?.ok) {
    $("auth-password").value = "";
    refreshAuthUI();
  } else {
    errEl.textContent = res?.error || (authMode === "signin" ? "Sign-in failed" : "Sign-up failed");
    errEl.hidden = false;
  }
});

$("signout-btn").addEventListener("click", async () => {
  await send({ type: "SIGN_OUT" });
  allReels = [];
  refreshAuthUI();
});

//  Data 

async function loadReels() {
  setStatus("Loading…");
  const res = await send({ type: "FETCH_REELS", ascending: !newestFirst });
  if (res?.ok) {
    allReels = res.reels || [];
    setStatus(null);
    render();
  } else {
    setStatus(`Couldn't load reels: ${res?.error || "unknown error"}`, true);
  }
}

$("refresh-btn").addEventListener("click", loadReels);

//  Search + sort 

$("search-input").addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase();
  render();
});

$("sort-btn").addEventListener("click", () => {
  newestFirst = !newestFirst;
  $("sort-btn").textContent = newestFirst ? "Newest ↓" : "Oldest ↑";
  allReels.reverse(); // server already ordered; flip locally
  render();
});

//  Rendering 

function render() {
  const feed = $("feed");
  activeEmbed = null; // feed is rebuilt; stale player refs would leak
  feed.replaceChildren();

  const visible = query
    ? allReels.filter((r) => (r.caption || "").toLowerCase().includes(query))
    : allReels;

  if (!visible.length) {
    setStatus(
      allReels.length
        ? "No reels match that search."
        : "No reels synced yet — open your saved reels on Instagram and hit Sync Now."
    );
    return;
  }
  setStatus(null);

  for (const reel of visible) {
    feed.appendChild(buildCard(reel));
  }
}

function buildCard(reel) {
  const card = document.createElement("article");
  card.className = "card";

  // Media area: thumbnail is a play button that swaps in an inline embed.
  const media = document.createElement("div");
  media.className = "card-media";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "card-thumb-link";
  play.setAttribute(
    "aria-label",
    reel.caption ? `Play reel: ${reel.caption.slice(0, 60)}` : "Play reel"
  );

  const img = document.createElement("img");
  img.className = "card-thumb";
  img.loading = "lazy";
  img.alt = reel.caption ? `Reel: ${reel.caption.slice(0, 80)}` : "Saved reel";
  img.src = reel.thumbnail_url || "";
  img.addEventListener("error", () => {
    // Instagram CDN thumbnails expire — degrade gracefully.
    img.replaceWith(makeThumbFallback());
  });
  play.appendChild(img);
  play.addEventListener("click", () => playInline(media, reel));
  media.appendChild(play);
  card.appendChild(media);

  const body = document.createElement("div");
  body.className = "card-body";

  if (reel.caption) {
    const cap = document.createElement("p");
    cap.className = "card-caption";
    cap.textContent = reel.caption;
    body.appendChild(cap);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";

  const date = document.createElement("span");
  date.className = "card-date";
  date.textContent = formatDate(reel.scraped_at);
  meta.appendChild(date);

  const open = document.createElement("a");
  open.href = reel.reel_url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.className = "card-open";
  open.textContent = "Open ↗";
  meta.appendChild(open);

  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

//  Inline playback 

// instagram.com/reel/<code>/ (or /p/<code>/) → its /embed/ player URL.
function embedUrl(reelUrl) {
  try {
    const u = new URL(reelUrl);
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
    const path = u.pathname.replace(/\/+$/, "");
    if (!/^\/(reel|reels|p|tv)\/[\w-]+$/.test(path)) return null;
    return `https://www.instagram.com${path}/embed/`;
  } catch {
    return null;
  }
}

// Only one embed at a time — otherwise multiple reels play audio at once.
let activeEmbed = null; // { wrap, thumb }

function closeActiveEmbed() {
  if (!activeEmbed) return;
  activeEmbed.wrap.replaceWith(activeEmbed.thumb);
  activeEmbed = null;
}

function playInline(media, reel) {
  const src = embedUrl(reel.reel_url);
  if (!src) {
    // Can't build an embed URL — fall back to a new tab.
    window.open(reel.reel_url, "_blank", "noopener");
    return;
  }

  closeActiveEmbed();

  const wrap = document.createElement("div");
  wrap.className = "embed-wrap";

  const iframe = document.createElement("iframe");
  iframe.className = "embed-frame";
  iframe.src = src;
  iframe.title = "Instagram reel player";
  iframe.allow = "autoplay; encrypted-media; picture-in-picture";
  iframe.allowFullscreen = true;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "embed-close";
  close.setAttribute("aria-label", "Close player");
  close.textContent = "✕";

  const thumb = media.firstElementChild;
  close.addEventListener("click", () => {
    closeActiveEmbed();
    thumb.focus(); // return focus for keyboard users
  });

  wrap.append(iframe, close);
  thumb.replaceWith(wrap);
  activeEmbed = { wrap, thumb };
  close.focus();
}

function makeThumbFallback() {
  const div = document.createElement("div");
  div.className = "card-thumb thumb-fallback";
  div.textContent = "▶";
  return div;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

//  Status strip 

function setStatus(text, isError = false) {
  const el = $("status");
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.classList.toggle("status-error", isError);
  el.hidden = false;
}

//  Boot 

refreshAuthUI();
