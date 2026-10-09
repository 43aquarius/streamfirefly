import type { CaptureSnapshot } from "../../../../shared/capture";
import { formatBytes } from "../../format";

export const CAPTURE_STATE_LABELS: Record<string, string> = { armed: "等待数据", capturing: "录制中", stopping: "正在停止", finalizing: "正在生成文件", complete: "已保存", partial: "未完成", interrupted: "已中断", unavailable: "记录损坏" };
export const isFinishedCapture = (session: CaptureSnapshot) => ["complete", "partial", "interrupted"].includes(session.state);

function hostOf(url?: string) { try { return url ? new URL(url).hostname : ""; } catch { return ""; } }
export function captureTitle(session: CaptureSnapshot) { return session.pageTitle || hostOf(session.pageUrl || session.source?.url) || "未知页面"; }

// Stock Windows players lack AV1 and HEVC decoders, so recordings in these codecs open with sound only.
export function modernCodec(session: CaptureSnapshot) {
  const mimes = session.tracks.map(track => track.mime.toLowerCase());
  return mimes.some(mime => mime.includes("av01")) ? "AV1" : mimes.some(mime => /hvc1|hev1/.test(mime)) ? "HEVC" : "";
}
export function codecHint(session: CaptureSnapshot) {
  const codec = modernCodec(session);
  if (codec === "AV1") return "视频是 AV1 编码。Windows 自带的媒体播放器要先在微软商店安装免费的“AV1 Video Extension”，也可以用 VLC 或 PotPlayer 播放。";
  if (codec === "HEVC") return "视频是 HEVC（H.265）编码。Windows 自带的媒体播放器要先在微软商店安装“HEVC 视频扩展”，也可以用 VLC 或 PotPlayer 播放。";
  return "打不开或只有声音？通常是播放器不支持这个视频的编码格式，换用 VLC 或 PotPlayer 一般就能播放。";
}

// The helper needs room for a merged copy as large as the recording, plus this margin (capture_merge.rs).
const MERGE_MARGIN = 256 * 1024 * 1024;
const SPACE_WARNING = 1024 * 1024 * 1024;
const IDLE_WARNING_SECONDS = 15;
export interface CaptureGuidance { text: string; warning: boolean }

export function recordingGuidance(session?: CaptureSnapshot): CaptureGuidance {
  const bytes = session?.bytes || 0, free = session?.freeBytes, needed = bytes + MERGE_MARGIN;
  if (free !== undefined && free < needed) return { text: `硬盘空间已经不够生成视频了（还差约 ${formatBytes(needed - free)}）。可以先点“停止并保存”，清理硬盘后再点“重新生成文件”，已录到的内容不会丢失。`, warning: true };
  if (session?.paused) return { text: `已收到 ${formatBytes(bytes)}，但来源页的视频暂停了，录不到新内容。请点“去来源页播放”，在来源页继续播放。`, warning: true };
  if (free !== undefined && free < needed + SPACE_WARNING) return { text: `注意：硬盘只剩 ${formatBytes(free)}，录完生成视频还需要约 ${formatBytes(bytes)}。建议现在点“停止并保存”，或先清理硬盘。`, warning: true };
  return { text: `正在录制，已收到 ${formatBytes(bytes)}。让视频播放到结尾会自动保存，也可以随时点“停止并保存”。`, warning: false };
}

export function savingGuidance(session?: CaptureSnapshot): CaptureGuidance {
  if (session?.state === "stopping") return { text: "正在停止录制，等待最后的数据写入硬盘…", warning: false };
  const merge = session?.merge;
  if (!merge) return { text: "正在生成视频文件，请稍等。", warning: false };
  const segment = merge.segments > 1 ? `（第 ${merge.segment}/${merge.segments} 段）` : "";
  const text = `正在生成视频文件${segment}：已处理 ${formatBytes(merge.processedBytes)} / ${formatBytes(merge.totalBytes)}，约 ${mergePercent(session)}%。文件越大需要越久，请保持浏览器打开。`;
  if (merge.idleSeconds < IDLE_WARNING_SECONDS) return { text, warning: false };
  return { text: `${text}硬盘暂时没有响应，已等待 ${merge.idleSeconds} 秒。超过 60 秒仍无进展会自动停止，原始数据会保留。`, warning: true };
}

// The merged file ends up about as large as the recording, so written bytes approximate progress; 100% waits for the result.
export function mergePercent(session?: CaptureSnapshot) {
  const merge = session?.merge;
  return merge && merge.totalBytes > 0 ? Math.min(99, Math.floor(merge.processedBytes * 100 / merge.totalBytes)) : 0;
}
