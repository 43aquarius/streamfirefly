import type { MediaCandidate } from "./types";

/** Files found only in page data (never requested by the browser) have no Content-Length yet. */
export function needsSizeProbe(item: MediaCandidate): boolean {
  return (item.type === "video" || item.type === "audio") && !(Number(item.size) > 0) && /^https?:/i.test(item.url);
}

/** A probe only fills a size that is still missing; it never replaces fields the view refreshed meanwhile. */
export function withProbedSize(current: MediaCandidate, probed: MediaCandidate): MediaCandidate | null {
  if (Number(current.size) > 0 || !(Number(probed.size) > 0)) return null;
  return { ...current, size: probed.size, sizeSource: probed.sizeSource };
}

/**
 * Asks the background for missing file sizes, a few at a time and each candidate at most once per page.
 * While sniffing is paused nothing is attempted, so the budget is still there when it resumes.
 */
export function createSizeProbeQueue(options: { probe: (candidate: MediaCandidate) => Promise<void>; concurrency?: number; limit?: number }) {
  const attempted = new Set<string>();
  let running = 0, page = "", latest: MediaCandidate[] = [], enabled = true;
  const concurrency = options.concurrency ?? 2, limit = options.limit ?? 40;
  function schedule(pageKey: string, candidates: MediaCandidate[], active = true) {
    if (pageKey !== page) { page = pageKey; attempted.clear(); }
    latest = candidates;
    enabled = active;
    if (!enabled) return;
    for (const item of candidates) {
      if (running >= concurrency || attempted.size >= limit) return;
      if (!needsSizeProbe(item) || attempted.has(item.id)) continue;
      attempted.add(item.id); running++;
      const owner = page;
      void options.probe(item)
        .catch(() => {})
        .finally(() => { running--; if (owner === page) schedule(page, latest, enabled); });
    }
  }
  /** Stops starting new probes; requests already sent finish on their own. */
  function stop() { page = ""; latest = []; attempted.clear(); }
  return { schedule, stop };
}
