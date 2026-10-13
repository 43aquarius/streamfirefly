(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const documentToken = crypto.randomUUID();
  const seen = new Set();
  const bound = new WeakSet();
  let active = false;
  let installing = true;
  let revision = 0;
  let pending = [];
  const pagePoster = () => { const value = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content; if (!value) return null; try { return new URL(value, location.href).href; } catch (_) { return value; } };
  const report = (element, force = false) => {
    if (!active) return;
    const url = element.currentSrc || element.src;
    if (!url || (!force && seen.has(url))) return;
    seen.add(url);
    const media = element.tagName === "SOURCE" ? element.parentElement : element;
    const isVideo = media?.tagName === "VIDEO";
    api.runtime.sendMessage({ type: "media.add", candidate: {
      url,
      mime: element.getAttribute("type") || media?.getAttribute("type") || (isVideo ? "video/unknown" : "audio/unknown"),
      title: document.title,
      pageTitle: document.title,
      pageUrl: location.href,
      faviconUrl: document.querySelector('link[rel~="icon"]')?.href || `${location.origin}/favicon.ico`,
      poster: isVideo ? media.poster || pagePoster() : null,
      width: isVideo ? media.videoWidth || null : null,
      height: isVideo ? media.videoHeight || null : null,
      duration: Number.isFinite(media?.duration) ? media.duration : null,
      source: "dom"
    }}).catch?.(() => {});
  };
  // Manifests requested before sniffing started survive only in the page's resource timeline.
  const timedMedia = /\.(?:m3u8?|mpd|mp4|webm|mov|mkv|flv|f4v|m4v|mp3|m4a|aac|wav|flac|ogg|opus|weba)(?:$|[?#&])/i;
  const withoutHash = value => String(value).split("#", 1)[0];
  const reportedTimings = new Set();
  let timingUrl = withoutHash(location.href);
  let timingFloor = 0;
  let navigationStartedAt = null;
  // Same-document navigations keep the old page's entries; only requests after the latest one belong to this page.
  try { globalThis.navigation?.addEventListener?.("navigate", event => { if (!event.hashChange) navigationStartedAt = performance.now(); }); } catch (_) {}
  const reportTimedResources = () => {
    if (withoutHash(location.href) !== timingUrl) {
      timingUrl = withoutHash(location.href);
      timingFloor = navigationStartedAt ?? performance.now();
    }
    let entries = [];
    try { entries = performance.getEntriesByType("resource"); } catch (_) { return; }
    let sent = 0;
    for (const entry of entries) {
      const url = entry.name;
      if (sent >= 200) break;
      if (entry.startTime < timingFloor || !/^https?:/i.test(url) || reportedTimings.has(`${url}|${entry.startTime}`) || !timedMedia.test(url)) continue;
      reportedTimings.add(`${url}|${entry.startTime}`);
      sent += 1;
      api.runtime.sendMessage({ type: "media.add", candidate: { url, mime: "", title: document.title, pageTitle: document.title, pageUrl: location.href, source: "timing" } }).catch?.(() => {});
    }
  };
  const scan = () => document.querySelectorAll("video, audio, source").forEach(element => {
    if (!active) return;
    report(element);
    const media = element.tagName === "SOURCE" ? element.parentElement : element;
    if (media && !bound.has(media) && (media.tagName === "VIDEO" || media.tagName === "AUDIO")) {
      bound.add(media);
      media.addEventListener("loadedmetadata", () => report(media, true), { once: true });
    }
  });
  // The video the user is watching: one that keeps playing for a moment while mostly on screen.
  // Only a settled play changes it, so scrolling past autoplaying previews does not reorder the list.
  let focusTimer = 0;
  let focusedUrl = "";
  const visibleArea = video => {
    const rect = video.getBoundingClientRect();
    const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    const mostlyVisible = rect.width >= 160 && rect.height >= 90 && width > 0 && height > 0 && width * height >= rect.width * rect.height * 0.5;
    return mostlyVisible ? width * height : 0;
  };
  const focusable = video => video?.tagName === "VIDEO" && !video.paused && !video.ended && Boolean(video.currentSrc || video.src) && visibleArea(video) > 0;
  const reportFocus = video => {
    const url = video.currentSrc || video.src;
    if (!active || url === focusedUrl) return;
    const send = () => {
      if (!active || url === focusedUrl) return;
      focusedUrl = url;
      api.runtime.sendMessage({ type: "media.focus", focus: { url, poster: video.poster || null, duration: Number.isFinite(video.duration) ? video.duration : null } }).catch?.(() => {});
    };
    if (window === window.top) { send(); return; }
    // A frame only knows its own viewport; the observer's default root is the top-level page, so an
    // off-screen embed (often an autoplaying ad) cannot take the focus from the video the user watches.
    const observer = new IntersectionObserver(entries => {
      observer.disconnect();
      if ((entries[0]?.intersectionRatio || 0) >= 0.5) send();
    });
    observer.observe(video);
  };
  // StreamFirefly is often opened while a video is already playing; that video is the focus right away.
  const focusPlayingVideo = () => {
    const playing = [...document.querySelectorAll("video")].filter(focusable).sort((a, b) => visibleArea(b) - visibleArea(a))[0];
    if (playing) reportFocus(playing);
  };
  document.addEventListener("playing", event => {
    const video = event.target;
    // An off-screen player starting must not cancel a visible one that is still settling.
    if (!active || !focusable(video)) return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (active && focusable(video)) reportFocus(video); }, 1500);
  }, true);
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "streamfirefly") return;
    const message = event.data.type === "key" ? { type: "deep.key.add", payload: { hex: event.data.hex, source: event.data.foundBy, documentToken } } : event.data.type === "media" ? { type: "media.add", candidate: event.data.candidate } : null;
    if (!message) return;
    if (active) api.runtime.sendMessage(message).catch?.(() => {});
    else if (installing && pending.length < 1000) pending.push(message);
  });
  api.runtime.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type === "probe.identity") { respond({ documentToken }); return false; }
    if (message?.type === "media.sniffing.control") { void setActive(Boolean(message.active)); respond({ ok: true }); return false; }
    if (message?.type === "media.rescan") { if (active) { seen.clear(); focusedUrl = ""; scan(); focusPlayingVideo(); } return { ok: true }; }
    if (window !== window.top) return false;
    if (message?.type === "workspace.unmount") {
      window.dispatchEvent(new CustomEvent("streamfirefly-workspace-unmount"));
      return { ok: true };
    }
    if (message?.type === "workspace.navigate") {
      window.dispatchEvent(new CustomEvent("streamfirefly-workspace-navigate", { detail: { view: message.view, candidateId: message.candidateId || "", displayMode: message.displayMode || "workspace", attemptId: message.attemptId } }));
      return { ok: true };
    }
    return false;
  });
  const observer = new MutationObserver(scan);
  function activate() {
    active = true;
    installing = false;
    const buffered = pending;
    pending = [];
    for (const message of buffered) api.runtime.sendMessage(message).catch?.(() => {});
    seen.clear();
    focusedUrl = "";
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
    focusPlayingVideo();
    reportTimedResources();
  }
  async function setActive(next) {
    const current = ++revision;
    if (!next) { active = false; installing = false; pending = []; observer.disconnect(); return; }
    installing = true;
    // Concurrent installation requests share this document's buffered discoveries.
    const result = await api.runtime.sendMessage({ type: "probe.install", documentToken }).catch(() => null);
    if (current !== revision) return;
    if (!result?.ok || !result.active) { installing = false; pending = []; return; }
    activate();
  }
  api.runtime.sendMessage({ type: "probe.install", documentToken }).then(result => { if (revision !== 0) return; if (result?.ok && result.active) activate(); else { installing = false; pending = []; } }).catch(() => { installing = false; pending = []; });
})();
