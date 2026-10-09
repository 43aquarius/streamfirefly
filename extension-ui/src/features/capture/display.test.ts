import type { CaptureSnapshot } from "../../../../shared/capture";
import { mergePercent, recordingGuidance, savingGuidance } from "./display";
import { sessionError } from "../session-client";

const GB = 1024 ** 3, MB = 1024 ** 2;
const session = (overrides: Partial<CaptureSnapshot>) => ({ id: "s", state: "capturing", bytes: 0, outputs: [], tracks: [], ...overrides }) as CaptureSnapshot;

describe("capture progress guidance", () => {
  it.each([
    ["plenty of space", { bytes: 2 * GB, freeBytes: 100 * GB }, "正在录制，已收到 2.0 GB。", false],
    ["an old helper without free space", { bytes: 2 * GB }, "正在录制，已收到 2.0 GB。", false],
    ["space running low", { bytes: 2 * GB, freeBytes: 3 * GB }, "注意：硬盘只剩 3.0 GB，录完生成视频还需要约 2.0 GB。", true],
    ["too little space to merge", { bytes: 2 * GB, freeBytes: 2 * GB }, "硬盘空间已经不够生成视频了（还差约 256 MB）。", true],
    ["a paused source", { bytes: 512 * MB, paused: true, freeBytes: 100 * GB }, "已收到 512 MB，但来源页的视频暂停了", true],
    ["missing space before a paused source", { bytes: 2 * GB, paused: true, freeBytes: GB }, "硬盘空间已经不够生成视频了", true],
  ])("recording with %s", (_name, overrides, text, warning) => {
    const guidance = recordingGuidance(session(overrides));
    expect(guidance.text).toContain(text);
    expect(guidance.warning).toBe(warning);
  });

  it.each([
    ["stopping", { state: "stopping" }, "正在停止录制，等待最后的数据写入硬盘…", false],
    ["an old helper", { state: "finalizing" }, "正在生成视频文件，请稍等。", false],
    ["one segment", { state: "finalizing", merge: { segment: 1, segments: 1, processedBytes: 1.2 * GB, totalBytes: 4.6 * GB, idleSeconds: 0 } }, "正在生成视频文件：已处理 1.2 GB / 4.6 GB，约 26%。文件越大需要越久，请保持浏览器打开。", false],
    ["two segments", { state: "finalizing", merge: { segment: 2, segments: 2, processedBytes: 0, totalBytes: GB, idleSeconds: 3 } }, "正在生成视频文件（第 2/2 段）：已处理 0 B / 1.0 GB，约 0%。", false],
    ["an idle disk", { state: "finalizing", merge: { segment: 1, segments: 1, processedBytes: GB, totalBytes: 2 * GB, idleSeconds: 20 } }, "硬盘暂时没有响应，已等待 20 秒。超过 60 秒仍无进展会自动停止，原始数据会保留。", true],
  ])("saving with %s", (_name, overrides, text, warning) => {
    const guidance = savingGuidance(session(overrides as Partial<CaptureSnapshot>));
    expect(guidance.text).toContain(text);
    expect(guidance.warning).toBe(warning);
  });

  it("caps the merge percentage until the file is ready", () => {
    expect(mergePercent(session({ merge: { segment: 1, segments: 1, processedBytes: 5 * GB, totalBytes: 4 * GB, idleSeconds: 0 } }))).toBe(99);
    expect(mergePercent(session({ merge: { segment: 1, segments: 1, processedBytes: 0, totalBytes: 0, idleSeconds: 0 } }))).toBe(0);
    expect(mergePercent(session({}))).toBe(0);
  });

  it.each(["capture_merge_stalled", "capture_merge_timeout", "capture_disk_insufficient", "capture_write_failed", "capture_quota_exceeded"])("explains %s with a next step", code => {
    const text = sessionError(code);
    expect(text).not.toBe(code);
    expect(text).toContain("重新生成文件");
  });
});
