// IG Saved Reels - content script (Phase 2: scraper)
// Injected on all instagram.com pages, but only ACTIVATES on the saved page.
// Instagram is an SPA, so we poll for URL changes instead of relying on
// manifest match patterns.

(() => {
  "use strict";

  const TAG = "[IG Saved Reels]";
  const BTN_ID = "igsr-sync-btn";

  // Reels/posts already scraped this session, keyed by shortcode.
  const seen = new Set();

  let syncing = false;
  let observer = null;
  let lastUrl = "";

  //  URL gating 

  // Saved content lives at instagram.com/<username>/saved/...
  // (e.g. /you/saved/all-posts/ or a named collection).
  function isSavedPage() {
    return /\/saved(\/|$)/.test(location.pathname);
  }

  // Poll for SPA navigations (pushState from the page can't be intercepted
  // reliably from a content script's isolated world).
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onUrlChange();
  }, 1000);

  function onUrlChange() {
    if (isSavedPage()) {
      console.log(TAG, "saved page detected, activating scraper");
      injectSyncButton();
      startObserver();
      scrapeVisible(); // pick up whatever is already rendered
    } else {
      removeSyncButton();
      stopObserver();
    }
  }

  //  Extraction 

  // Pull the shortcode out of /reel/<code>/ or /p/<code>/
  const SHORTCODE_RE = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/;

  function extractReelFromAnchor(a) {
    const href = a.getAttribute("href") || "";
    const m = href.match(SHORTCODE_RE);
    if (!m) return null;
    const shortcode = m[1];

    // Thumbnail: an <img> inside the anchor. Instagram thumbnails are
    // <img> with a CDN src; alt text usually contains the caption.
    const img = a.querySelector("img");
    const thumbnail = img ? img.currentSrc || img.src || null : null;

    // Caption fallbacks, most to least reliable:
    // 1. img alt text ("Photo by X on ... . May be an image of ...")
    // 2. anchor aria-label
    let caption = null;
    if (img && img.alt && img.alt.trim()) caption = img.alt.trim();
    else if (a.getAttribute("aria-label")) caption = a.getAttribute("aria-label").trim();

    return {
      post_id: shortcode,
      reel_url: new URL(href, location.origin).href,
      thumbnail_url: thumbnail,
      caption,
      scraped_at: new Date().toISOString(),
    };
  }

  // Scrape everything currently in the DOM. Returns count of NEW reels found.
  function scrapeVisible() {
    if (!isSavedPage()) return 0;

    // Defensive selector strategy: target anchors by href pattern (stable,
    // part of Instagram's public URL scheme) scoped to <main> (stable
    // landmark element), NOT by class names (obfuscated, change often).
    const root = document.querySelector("main") || document.body;
    const anchors = root.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]');

    const fresh = [];
    for (const a of anchors) {
      const reel = extractReelFromAnchor(a);
      if (!reel || seen.has(reel.post_id)) continue;
      seen.add(reel.post_id);
      fresh.push(reel);
    }

    if (fresh.length) {
      console.log(TAG, `scraped ${fresh.length} new reels (${seen.size} total this session)`);
      sendReels(fresh);
    }
    return fresh.length;
  }

  // Last upsert error reported by the background worker during this sync
  // (e.g. "Not signed in") — used so the Sync button doesn't lie with a ✓.
  let lastSendError = null;

  function sendReels(reels) {
    try {
      chrome.runtime.sendMessage({ type: "SCRAPED_REELS", reels }, (res) => {
        if (chrome.runtime.lastError) {
          lastSendError = chrome.runtime.lastError.message;
          console.warn(TAG, "sendMessage failed:", lastSendError);
        } else if (res && res.ok === false) {
          lastSendError = res.error || "upsert failed";
          console.warn(TAG, "background reported:", lastSendError);
        } else {
          console.log(TAG, "background ack:", res);
        }
      });
    } catch (e) {
      lastSendError = String(e);
      console.warn(TAG, "sendMessage threw (extension reloaded?):", e);
    }
  }

  //  Lazy-load handling 

  function startObserver() {
    if (observer) return;
    const root = document.querySelector("main") || document.body;
    // Debounced scrape whenever Instagram appends lazy-loaded grid items.
    let t = null;
    observer = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(scrapeVisible, 400);
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  //  Sync tuning 
  // stepDelayMs: wait per scroll step so IG's lazy-loader can fetch the
  //   next batch. Floor ≈ 400ms — below that, items don't render in time,
  //   sync ends early, and you spike request rate (risk of a temp block).
  //   800 is fast+safe. Raise to 1500–2000 on slow connections.
  // maxSteps: safety cap; each step scrolls ~0.9 viewports. Raise for
  //   very large saved libraries.
  const SYNC_TUNING = { stepDelayMs: 800, maxSteps: 50 };

  // Full sync: repeatedly scroll to force lazy-loading, scraping as we go.
  // Stops when 2 consecutive scroll steps yield no new reels, or after
  // maxSteps (safety cap to avoid hammering Instagram).
  async function fullSync({
    maxSteps = SYNC_TUNING.maxSteps,
    stepDelayMs = SYNC_TUNING.stepDelayMs,
  } = {}) {
    if (syncing) return;
    syncing = true;
    setButtonState("syncing");

    let emptySteps = 0;
    lastSendError = null;
    try {
      scrapeVisible();
      for (let i = 0; i < maxSteps && emptySteps < 2; i++) {
        window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
        await sleep(stepDelayMs);
        const found = scrapeVisible();
        emptySteps = found === 0 ? emptySteps + 1 : 0;
      }
      // Give in-flight upsert acks a moment to land before judging success.
      await sleep(1500);
      chrome.runtime.sendMessage({ type: "SYNC_COMPLETE", total: seen.size });
      if (lastSendError) {
        console.warn(TAG, `sync finished with errors: ${lastSendError}`);
        setButtonState("error");
      } else {
        console.log(TAG, `sync complete: ${seen.size} reels this session`);
        setButtonState("done");
      }
    } catch (e) {
      console.error(TAG, "sync failed:", e);
      setButtonState("error");
    } finally {
      syncing = false;
      setTimeout(() => setButtonState("idle"), 2500);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  //  Sync Now button 

  function injectSyncButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = "Sync Now";
    Object.assign(btn.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "999999",
      padding: "10px 18px",
      borderRadius: "999px",
      border: "none",
      background: "#ffb454",
      color: "#0c1014",
      fontFamily: "system-ui, sans-serif",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
    });
    btn.addEventListener("click", () => fullSync());
    document.body.appendChild(btn);
  }

  function setButtonState(state) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const map = {
      idle: ["Sync Now", "#ffb454", "#0c1014"],
      syncing: ["Syncing…", "#1b232c", "#e9eef4"],
      done: ["Synced ✓", "#1f6f4a", "#e9eef4"],
      error: ["Sync failed", "#8a2f2f", "#e9eef4"],
    };
    const [label, bg, fg] = map[state] || map.idle;
    btn.textContent = label;
    btn.style.background = bg;
    btn.style.color = fg;
    btn.disabled = state === "syncing";
  }

  function removeSyncButton() {
    document.getElementById(BTN_ID)?.remove();
  }

  // Side panel can also request a sync (used in Phase 5).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TRIGGER_SYNC") {
      fullSync();
      sendResponse({ started: true });
    }
    return false;
  });

  //  Boot 
  console.log(TAG, "content script loaded:", location.href);
  lastUrl = location.href;
  onUrlChange();
})();
