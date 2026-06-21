"use client";

import { X, Film, Circle, Download, FileText } from "lucide-react";

/* 九墨輸出視窗（vizzy Export 獨立頁）：解析度 / FPS / 預估大小 / 渲染 MP4 或錄製。 */

type Props = {
  orientation: "landscape" | "portrait" | "wide" | "square";
  resolution: "720" | "1080";
  onResolution: (r: "720" | "1080") => void;
  fps: 30 | 60;
  onFps: (f: 30 | 60) => void;
  duration: number;
  recording: boolean;
  renderPct: number;
  downloadUrl: string;
  chaptersText: string;
  title: string;
  onRecord: () => void;
  onRenderMp4: () => void;
  onCancelRender: () => void;
  onDownloadChapters: () => void;
  onClose: () => void;
};

const BTN = "px-3 py-1.5 rounded-lg text-[12px] border transition cursor-pointer";

export function ExportPanel(p: Props) {
  const short = p.resolution === "720" ? 720 : 1080;
  const long = Math.round((short * 16) / 9);
  const W = p.orientation === "square" ? short : p.orientation === "wide" ? short * 2 : p.orientation === "landscape" ? long : short;
  const H = p.orientation === "square" || p.orientation === "wide" ? short : p.orientation === "landscape" ? short : long;
  // 粗估：1080p≈10Mbps、720p≈5Mbps，×fps/30
  const bitrate = (p.resolution === "720" ? 5e6 : 10e6) * (p.fps / 30);
  const sizeMB = p.duration > 0 ? Math.round((bitrate * p.duration) / 8 / 1e6) : 0;
  const rendering = p.renderPct >= 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={p.onClose}>
      <div className="bg-[#15110f] border border-white/15 rounded-2xl w-full max-w-[440px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <p className="text-[13px] text-white/80 tracking-wider">輸出影片</p>
          <button type="button" onClick={p.onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <p className="text-[11px] text-white/40 tracking-wider mb-1.5">解析度</p>
            <div className="flex gap-2">
              {(["720", "1080"] as const).map((r) => (
                <button key={r} type="button" onClick={() => p.onResolution(r)}
                  className={`${BTN} flex-1 ${p.resolution === r ? "border-white/50 text-white bg-white/[0.06]" : "border-white/15 text-white/55 hover:border-white/35"}`}>
                  {r === "720" ? "720p" : "1080p"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-white/40 tracking-wider mb-1.5">FPS</p>
            <div className="flex gap-2">
              {([30, 60] as const).map((f) => (
                <button key={f} type="button" onClick={() => p.onFps(f)}
                  className={`${BTN} flex-1 ${p.fps === f ? "border-white/50 text-white bg-white/[0.06]" : "border-white/15 text-white/55 hover:border-white/35"}`}>
                  {f} fps
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between text-[11px] text-white/45 pt-1 border-t border-white/10">
            <span>{W} × {H}　·　{p.duration > 0 ? `${Math.floor(p.duration / 60)}:${String(Math.floor(p.duration % 60)).padStart(2, "0")}` : "—"}</span>
            <span className="text-white/60">預估 {sizeMB > 0 ? `~${sizeMB} MB` : "—"}</span>
          </div>

          <div className="space-y-2 pt-1">
            {rendering ? (
              <button type="button" onClick={p.onCancelRender}
                className={`${BTN} w-full border-amber-200/50 text-amber-100`}>渲染中 {p.renderPct}%（點此取消）</button>
            ) : (
              <button type="button" onClick={p.onRenderMp4}
                className={`${BTN} w-full border-amber-200/45 text-amber-100 hover:border-amber-200/70 flex items-center justify-center gap-1.5`}>
                <Film size={14} /> 渲染影片（幀準確、比實時快 · 含所有圖層）
              </button>
            )}
            <button type="button" onClick={p.onRecord}
              className={`${BTN} w-full flex items-center justify-center gap-1.5 ${p.recording ? "border-red-400/70 text-red-300" : "border-white/15 text-white/65 hover:border-white/40"}`}>
              <Circle size={12} className={p.recording ? "fill-red-400" : ""} /> {p.recording ? "停止錄製" : "錄製（即時、含所有圖層與視效）"}
            </button>
            <p className="text-[10px] text-white/25 leading-relaxed">渲染影片＝WebCodecs 離線出片（快、幀準，含背景濾鏡/音訊圖/字幕/落款/影片）；自動挑格式：有 H.264 出 MP4，沒有就出 WebM（VP9），任何 Chromium 系瀏覽器都能用。錄製＝即時擷取畫面，解析度＝預覽。</p>
          </div>

          {(p.downloadUrl || p.chaptersText) && (
            <div className="flex gap-2 pt-2 border-t border-white/10">
              {p.downloadUrl && (
                <a className={`${BTN} flex-1 text-center border-amber-200/50 text-amber-100 flex items-center justify-center gap-1.5`} href={p.downloadUrl} download={`九墨-${p.title || "作品"}.webm`}>
                  <Download size={13} /> 下載影片
                </a>
              )}
              {p.chaptersText && (
                <button type="button" onClick={p.onDownloadChapters} className={`${BTN} flex-1 border-amber-200/50 text-amber-100 flex items-center justify-center gap-1.5`}>
                  <FileText size={13} /> YouTube 章節
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
