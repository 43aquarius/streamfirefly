import { createSizeProbeQueue, needsSizeProbe, withProbedSize } from "./size-probe";
import type { MediaCandidate } from "./types";

const item = (id: string, extra: Partial<MediaCandidate> = {}): MediaCandidate => ({ id, url: `https://v.example/${id}.mp4`, type: "video", ...extra });

describe("file size probing", () => {
  it("probes only http(s) video and audio files without a known size", () => {
    expect(needsSizeProbe(item("a"))).toBe(true);
    expect(needsSizeProbe(item("b", { type: "audio", size: null }))).toBe(true);
    expect(needsSizeProbe(item("c", { size: 2048 }))).toBe(false);
    expect(needsSizeProbe(item("d", { type: "hls" }))).toBe(false);
    expect(needsSizeProbe(item("e", { type: "image" }))).toBe(false);
    expect(needsSizeProbe(item("f", { url: "blob:https://v.example/x" }))).toBe(false);
  });

  it("probes each candidate once per page, within the limit, and starts over on a new page", async () => {
    const probe = vi.fn(async (_candidate: MediaCandidate) => {});
    const queue = createSizeProbeQueue({ probe, concurrency: 1, limit: 2 });
    const items = [item("one"), item("known", { size: 10 }), item("two"), item("three")];
    queue.schedule("page", items);
    queue.schedule("page", items);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(probe.mock.calls.map(([candidate]) => candidate.id)).toEqual(["one", "two"]);
    queue.schedule("page-2", [item("one")]);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3));
  });

  it("spends nothing while sniffing is paused and continues once it resumes", async () => {
    const probe = vi.fn(async (_candidate: MediaCandidate) => {});
    const queue = createSizeProbeQueue({ probe, limit: 2 });
    const items = [item("one"), item("two")];
    queue.schedule("page", items, false);
    queue.schedule("page", items, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(probe).not.toHaveBeenCalled();
    queue.schedule("page", items, true);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });

  it("only fills a size that is still missing", () => {
    const probed = item("a", { size: 1000, sizeSource: "probe", pageTitle: "stale snapshot" });
    expect(withProbedSize(item("a", { pageTitle: "fresh" }), probed)).toEqual(item("a", { pageTitle: "fresh", size: 1000, sizeSource: "probe" }));
    expect(withProbedSize(item("a", { size: 9000, sizeSource: "content-range" }), probed)).toBeNull();
    expect(withProbedSize(item("a"), item("a"))).toBeNull();
  });

  it("starts nothing new after stop", async () => {
    let release!: () => void;
    const probe = vi.fn((_candidate: MediaCandidate) => new Promise<void>(resolve => { release = resolve; }));
    const queue = createSizeProbeQueue({ probe, concurrency: 1 });
    queue.schedule("page", [item("first"), item("second")]);
    queue.stop();
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps going after a failed probe", async () => {
    const probe = vi.fn(async (candidate: MediaCandidate) => { if (candidate.id === "bad") throw new Error("offline"); });
    createSizeProbeQueue({ probe, concurrency: 1 }).schedule("page", [item("bad"), item("good")]);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });
});
