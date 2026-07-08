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
  if (modalIndex >= 0) closeModal(); // feed is rebuilt; stale indices would misplay
  feed.replaceChildren();

  const visible = query
    ? allReels.filter((r) => (r.caption || "").toLowerCase().includes(query))
    : allReels;
  currentList = visible;

  if (!visible.length) {
    setStatus(
      allReels.length
        ? "No reels match that search."
        : "No reels synced yet — open your saved reels on Instagram and hit Sync Now."
    );
    return;
  }
  setStatus(null);

  visible.forEach((reel, i) => feed.appendChild(buildCard(reel, i)));
}

function buildCard(reel, index) {
  const card = document.createElement("article");
  card.className = "card";

  // Media area: thumbnail is a play button that opens the modal player.
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
  play.addEventListener("click", () => openModal(index));
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

//  Modal player (Phase 4.5)
// Click card -> modal + spinner -> ask background for a fresh video URL
// (JIT hidden-tab scrape) -> <video> with custom controls. If that fails,
// fall back to the Instagram embed iframe. Error state only if both fail.

let currentList = []; // reels currently rendered (post-search/sort)
let modalIndex = -1;  // index into currentList, -1 = closed

function openModal(index) {
  modalIndex = index;
  $("modal").hidden = false;
  loadModalContent();
}

function closeModal() {
  modalIndex = -1;
  $("modal").hidden = true;
  $("modal-stage").replaceChildren(); // stops video/iframe playback
  $("modal-caption").textContent = "";
}

function stepModal(delta) {
  if (modalIndex < 0 || !currentList.length) return;
  modalIndex = (modalIndex + delta + currentList.length) % currentList.length;
  loadModalContent();
}

async function loadModalContent() {
  const reel = currentList[modalIndex];
  if (!reel) return closeModal();

  const stage = $("modal-stage");
  stage.replaceChildren(makeSpinner()); // spinner immediately — JIT takes a moment
  $("modal-caption").textContent = reel.caption || "";
  setPlayGlyph(true);

  const requested = modalIndex;
  const res = await send({ type: "GET_VIDEO_URL", reel_url: reel.reel_url });
  // User navigated or closed while we were fetching — drop stale result.
  if (requested !== modalIndex || $("modal").hidden) return;

  if (res?.ok && res.video_url) {
    const video = document.createElement("video");
    video.className = "modal-video";
    video.src = res.video_url;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.addEventListener("click", toggle_play);
    video.addEventListener("play", () => setPlayGlyph(true));
    video.addEventListener("pause", () => setPlayGlyph(false));
    // Signed URL can still be rejected on playback — fall back then too.
    video.addEventListener("error", () => {
      if (stage.contains(video)) showEmbedFallback(stage, reel);
    });
    stage.replaceChildren(video);
    return;
  }

  showEmbedFallback(stage, reel);
}

function showEmbedFallback(stage, reel) {
  const src = embedUrl(reel.reel_url);
  if (!src) return stage.replaceChildren(makeModalError());

  const iframe = document.createElement("iframe");
  iframe.className = "embed-frame";
  iframe.src = src;
  iframe.title = "Instagram reel player";
  iframe.allow = "autoplay; encrypted-media; picture-in-picture";
  iframe.allowFullscreen = true;

  // iframes don't fire error events for blocked/failed loads — use a timeout.
  const timer = setTimeout(() => {
    if (stage.contains(iframe) && !loaded) {
      stage.replaceChildren(makeModalError());
    }
  }, 8000);
  let loaded = false;
  iframe.addEventListener("load", () => {
    loaded = true;
    clearTimeout(timer);
  });

  stage.replaceChildren(iframe);
}

function toggle_play() {
  const video = $("modal-stage").querySelector("video");
  if (!video) return;
  video.paused ? video.play() : video.pause();
}

function setPlayGlyph(playing) {
  $("modal-play").textContent = playing ? "❚❚" : "▶";
}

function makeSpinner() {
  const div = document.createElement("div");
  div.className = "spinner";
  div.setAttribute("role", "status");
  div.setAttribute("aria-label", "Loading reel");
  return div;
}

function makeModalError() {
  const div = document.createElement("div");
  div.className = "modal-error";
  div.textContent = "Couldn't load this reel — it may have been deleted.";
  return div;
}

// Modal controls
$("modal-close").addEventListener("click", closeModal);
$("modal-backdrop").addEventListener("click", closeModal);
$("modal-prev").addEventListener("click", () => stepModal(-1));
$("modal-next").addEventListener("click", () => stepModal(1));
$("modal-play").addEventListener("click", toggle_play);

document.addEventListener("keydown", (e) => {
  if (modalIndex < 0) return;
  if (e.key === "Escape") closeModal();
  else if (e.key === "ArrowLeft") stepModal(-1);
  else if (e.key === "ArrowRight") stepModal(1);
  else if (e.key === " ") {
    e.preventDefault();
    toggle_play();
  }
});

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
