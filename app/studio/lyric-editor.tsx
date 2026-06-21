"use client";

import { useState } from "react";
import { X, Crosshair, Play, Download } from "lucide-react";
import { serializeLRC, serializeSRT, type LyricLine } from "../engine/lyrics";

/* 九墨 #5 — 歌詞秒數快速編輯器。
   每句改秒數 / 標記為當前播放時間 / 整體位移 / 匯出 LRC 或 SRT。對 LRC 與 SRT 來源都通用
   （內部統一成 LyricLine[]，匯出時可選格式）。 */

const fmt = (t: number) => {
  const m = Math.floor(t / 60), s = (t % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
};

type Props = {
  title: string;
  lines: LyricLine[];
  getCurrentTime: () => number;
  onChange: (lines: LyricLine[]) => void;
  onSeek: (t: number) => void;
  onClose: () => void;
};

export function LyricEditor({ title, lines, getCurrentTime, onChange, onSeek, onClose }: Props) {
  const [rows, setRows] = useState<LyricLine[]>(lines);

  const commit = (next: LyricLine[]) => { setRows(next); onChange(next); };
  const patch = (i: number, p: Partial<LyricLine>) => commit(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const shiftAll = (d: number) => commit(rows.map((r) => ({ ...r, t: Math.max(0, +(r.t + d).toFixed(2)) })));
  const markNow = (i: number) => patch(i, { t: +getCurrentTime().toFixed(2) });

  const download = (text: string, ext: string) => {
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title || "歌詞"}.${ext}`;
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#15110f] border border-white/15 rounded-2xl w-full max-w-[560px] max-h-[82vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <p className="text-[13px] text-white/80 tracking-wider">歌詞秒數編輯 · {title || "未命名"}</p>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
        </div>

        <div className="px-4 py-2 border-b border-white/10 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-white/40">整體位移</span>
          {[-1, -0.1, 0.1, 1].map((d) => (
            <button key={d} type="button" onClick={() => shiftAll(d)}
              className="text-[11px] text-white/65 hover:text-white border border-white/15 hover:border-white/40 rounded px-2 py-0.5 transition">
              {d > 0 ? `+${d}` : d}s
            </button>
          ))}
          <span className="text-[10px] text-white/25">（歌詞整體早/晚了就用這個對齊）</span>
        </div>

        <div className="overflow-y-auto flex-1 px-2 py-2 space-y-1">
          {rows.length === 0 && <p className="text-[12px] text-white/35 text-center py-6">這首還沒綁歌詞，先在「歌單」綁 LRC / SRT</p>}
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/[0.04]">
              <input type="number" step={0.1} min={0} value={r.t}
                onChange={(e) => patch(i, { t: Math.max(0, parseFloat(e.target.value) || 0) })}
                className="w-16 bg-black/40 border border-white/10 rounded px-1.5 py-1 text-[11px] tabular-nums outline-none focus:border-white/30" />
              <span className="text-[9px] text-white/30 w-12 tabular-nums">{fmt(r.t)}</span>
              <button type="button" onClick={() => markNow(i)} title="設為目前播放時間"
                className="text-white/40 hover:text-amber-300 shrink-0"><Crosshair size={13} /></button>
              <button type="button" onClick={() => onSeek(r.t)} title="跳到這句"
                className="text-white/40 hover:text-white shrink-0"><Play size={12} /></button>
              <span className="text-[9px] text-white/25 shrink-0">→</span>
              <input type="number" step={0.1} min={0}
                value={r.end ?? +(rows[i + 1]?.t ?? r.t + 3).toFixed(2)}
                onChange={(e) => patch(i, { end: Math.max(r.t, parseFloat(e.target.value) || 0) })}
                title="結束時間（這句何時消失）"
                className="w-14 bg-black/40 border border-white/10 rounded px-1.5 py-1 text-[11px] tabular-nums outline-none focus:border-white/30 shrink-0" />
              <input type="text" value={r.text}
                onChange={(e) => patch(i, { text: e.target.value })}
                className="flex-1 min-w-0 bg-transparent text-[12px] text-white/80 outline-none border-b border-transparent focus:border-white/20" />
            </div>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex items-center gap-2">
          <span className="text-[10px] text-white/35 flex-1">標記 = 邊播邊把每句設到正確秒數</span>
          <button type="button" onClick={() => download(serializeLRC(rows), "lrc")}
            className="flex items-center gap-1 text-[11px] text-amber-100 border border-amber-200/40 rounded-lg px-2.5 py-1.5 hover:border-amber-200/70 transition">
            <Download size={12} /> LRC
          </button>
          <button type="button" onClick={() => download(serializeSRT(rows), "srt")}
            className="flex items-center gap-1 text-[11px] text-amber-100 border border-amber-200/40 rounded-lg px-2.5 py-1.5 hover:border-amber-200/70 transition">
            <Download size={12} /> SRT
          </button>
        </div>
      </div>
    </div>
  );
}
