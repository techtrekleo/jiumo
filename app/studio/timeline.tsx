"use client";

import { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Repeat, Volume2 } from "lucide-react";
import { displayOrder, effectiveTiming, type Composition } from "../engine/composition";

/* 九墨時間軸（vizzy 風）：圖層軌道 + 整條波形 + zoom + loop 區段 + 音量。
   拖曳色條＝控制每層出現時段；播放頭即時掃；點波形 seek。 */

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const ZOOMS = [1, 2, 4, 8, 16];
type DragMode = "move" | "l" | "r";

type Props = {
  composition: Composition;
  duration: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChangeTiming: (id: string, t: { start?: number; end?: number }) => void;
  getCurrentTime: () => number;
  onSeek: (t: number) => void;
  peaks: number[] | null;
  volume: number;
  onVolume: (v: number) => void;
  loop: { start: number; end: number } | null;
  onLoopChange: (l: { start: number; end: number } | null) => void;
};

export function Timeline({ composition, duration, selectedId, onSelect, onChangeTiming, getCurrentTime, onSeek, peaks, volume, onVolume, loop, onLoopChange }: Props) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; mode: DragMode; startX: number; s0: number; e0: number } | null>(null);
  const loopDrag = useRef<{ mode: DragMode; startX: number; s0: number; e0: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0);

  const viewDur = duration > 0 ? duration / zoom : 0;
  const viewStart = Math.max(0, Math.min(Math.max(0, duration - viewDur), scroll));
  const t2f = (t: number) => (viewDur > 0 ? (t - viewStart) / viewDur : 0);
  const laneWidth = () => lanesRef.current?.clientWidth || 1;

  // 播放頭：自帶 rAF；zoom 時自動捲動讓播放頭留在畫面內
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ph = playheadRef.current;
      if (!ph || duration <= 0) return;
      const ct = getCurrentTime();
      const f = t2f(ct);
      ph.style.left = `${Math.min(100, Math.max(0, f * 100))}%`;
      ph.style.opacity = f < 0 || f > 1 ? "0" : "1";
      if (zoom > 1 && (f < 0.05 || f > 0.95)) setScroll(Math.max(0, Math.min(duration - viewDur, ct - viewDur / 2)));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration, getCurrentTime, viewStart, viewDur, zoom]);

  // 波形繪製
  useEffect(() => {
    const c = waveRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const W = c.width, H = c.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    if (!peaks || peaks.length === 0 || duration <= 0) return;
    ctx.fillStyle = "rgba(196,60,48,0.5)";
    for (let x = 0; x < W; x++) {
      const t = viewStart + (x / W) * viewDur;
      const pi = Math.floor((t / duration) * peaks.length);
      const p = peaks[Math.max(0, Math.min(peaks.length - 1, pi))] || 0;
      const h = p * mid * 0.95;
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }, [peaks, viewStart, viewDur, duration]);

  // 時段拖曳
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || duration <= 0) return;
      const dsec = ((e.clientX - d.startX) / laneWidth()) * viewDur;
      const tail = d.e0 < 0, end = tail ? duration : d.e0;
      if (d.mode === "move") {
        const len = end - d.s0;
        const ns = Math.max(0, Math.min(tail ? duration : duration - len, d.s0 + dsec));
        onChangeTiming(d.id, tail ? { start: ns } : { start: ns, end: ns + len });
      } else if (d.mode === "l") onChangeTiming(d.id, { start: Math.max(0, Math.min(end - 0.3, d.s0 + dsec)) });
      else onChangeTiming(d.id, { end: Math.max(d.s0 + 0.3, Math.min(duration, end + dsec)) });
    };
    const onUp = () => { drag.current = null; loopDrag.current = null; };
    const onLoopMove = (e: PointerEvent) => {
      const d = loopDrag.current;
      if (!d || duration <= 0 || !loop) return;
      const dsec = ((e.clientX - d.startX) / laneWidth()) * viewDur;
      if (d.mode === "move") { const len = d.e0 - d.s0; const ns = Math.max(0, Math.min(duration - len, d.s0 + dsec)); onLoopChange({ start: ns, end: ns + len }); }
      else if (d.mode === "l") onLoopChange({ start: Math.max(0, Math.min(d.e0 - 0.5, d.s0 + dsec)), end: d.e0 });
      else onLoopChange({ start: d.s0, end: Math.max(d.s0 + 0.5, Math.min(duration, d.e0 + dsec)) });
    };
    const move = (e: PointerEvent) => { if (drag.current) onMove(e); else if (loopDrag.current) onLoopMove(e); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", onUp); };
  }, [duration, viewDur, onChangeTiming, onLoopChange, loop]);

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, s0: number, e0: number) => { e.stopPropagation(); drag.current = { id, mode, startX: e.clientX, s0, e0 }; };
  const startLoopDrag = (e: React.PointerEvent, mode: DragMode) => { e.stopPropagation(); if (loop) loopDrag.current = { mode, startX: e.clientX, s0: loop.start, e0: loop.end }; };
  const seekAt = (e: React.MouseEvent) => {
    if (duration <= 0) return;
    const r = lanesRef.current!.getBoundingClientRect();
    onSeek(viewStart + ((e.clientX - r.left) / r.width) * viewDur);
  };
  const toggleLoop = () => onLoopChange(loop ? null : { start: 0, end: duration || 10 });
  const zoomBy = (dir: number) => {
    const i = ZOOMS.indexOf(zoom), ni = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
    const center = getCurrentTime() || viewStart + viewDur / 2;
    setZoom(ZOOMS[ni]);
    const nd = duration / ZOOMS[ni];
    setScroll(Math.max(0, Math.min(Math.max(0, duration - nd), center - nd / 2)));
  };

  const rows = displayOrder(composition);
  const loopLeft = loop ? t2f(loop.start) * 100 : 0;
  const loopW = loop ? ((loop.end - loop.start) / (viewDur || 1)) * 100 : 0;

  return (
    <div className="bg-white/[0.03] rounded-xl p-3 mt-3">
      <div className="flex items-center gap-3 mb-2">
        <p className="text-[11px] text-white/40 tracking-wider flex-1 truncate">時間軸 · 拖曳色條控制每層時段</p>
        <span className="text-[10px] text-white/30 tabular-nums">{duration > 0 ? `總長 ${fmt(duration)}` : "尚未載入歌曲"}</span>
        <button type="button" onClick={() => zoomBy(-1)} title="縮小" className="text-white/45 hover:text-white"><ZoomOut size={14} /></button>
        <span className="text-[10px] text-white/40 tabular-nums w-6 text-center">{zoom}x</span>
        <button type="button" onClick={() => zoomBy(1)} title="放大" className="text-white/45 hover:text-white"><ZoomIn size={14} /></button>
        <button type="button" onClick={toggleLoop} title="循環區段" className={loop ? "text-amber-300" : "text-white/45 hover:text-white"}><Repeat size={14} /></button>
        <div className="flex items-center gap-1.5">
          <Volume2 size={14} className="text-white/45" />
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => onVolume(parseFloat(e.target.value))} className="w-16 accent-red-400" />
        </div>
      </div>
      <div className="flex">
        <div className="w-[88px] shrink-0">
          <div className="h-6" />
          {rows.map((l) => (
            <div key={l.id} className="h-6 flex items-center">
              <span className={`text-[10px] truncate pr-2 ${l.id === selectedId ? "text-white/85" : "text-white/45"}`}>{l.name}</span>
            </div>
          ))}
        </div>
        <div className="relative flex-1 min-w-0">
          {/* 波形 + 標尺，點此 seek */}
          <div className="h-6 relative cursor-pointer" onClick={seekAt}>
            <canvas ref={waveRef} width={1600} height={40} className="absolute inset-0 w-full h-full" />
            {duration > 0 && [0, 0.5, 1].map((f) => (
              <span key={f} className="absolute top-0 text-[9px] text-white/35 -translate-x-1/2 pointer-events-none" style={{ left: `${f * 100}%` }}>{fmt(viewStart + viewDur * f)}</span>
            ))}
          </div>
          <div ref={lanesRef} className="relative" onClick={seekAt}>
            {rows.map((l) => {
              const et = effectiveTiming(l, duration || 0);
              const left = t2f(et.start) * 100, width = ((et.end - et.start) / (viewDur || 1)) * 100;
              const sel = l.id === selectedId, raw = l.timing ?? { start: 0, end: -1 };
              return (
                <div key={l.id} className="h-6 flex items-center">
                  <div className="relative w-full h-3.5 rounded bg-white/[0.04] overflow-hidden">
                    <div onPointerDown={(e) => { onSelect(l.id); startDrag(e, l.id, "move", raw.start, raw.end); }} onClick={(e) => e.stopPropagation()}
                      className={`absolute top-0 h-3.5 rounded cursor-grab active:cursor-grabbing ${sel ? "bg-[#c43c30]" : "bg-white/25 hover:bg-white/35"} ${!l.visible ? "opacity-40" : ""}`}
                      style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}>
                      <span onPointerDown={(e) => startDrag(e, l.id, "l", raw.start, raw.end)} className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize rounded-l bg-black/30 hover:bg-black/50" />
                      <span onPointerDown={(e) => startDrag(e, l.id, "r", raw.start, raw.end)} className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r bg-black/30 hover:bg-black/50" />
                    </div>
                  </div>
                </div>
              );
            })}
            {/* loop 區段 */}
            {loop && (
              <div className="absolute top-0 bottom-0 bg-amber-300/10 border-x border-amber-300/50 pointer-events-none" style={{ left: `${loopLeft}%`, width: `${loopW}%` }}>
                <span onPointerDown={(e) => startLoopDrag(e, "move")} className="absolute inset-0 cursor-grab pointer-events-auto" />
                <span onPointerDown={(e) => startLoopDrag(e, "l")} className="absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-ew-resize bg-amber-300/60 pointer-events-auto" />
                <span onPointerDown={(e) => startLoopDrag(e, "r")} className="absolute right-0 top-0 bottom-0 w-2 -mr-1 cursor-ew-resize bg-amber-300/60 pointer-events-auto" />
              </div>
            )}
            <div ref={playheadRef} className="absolute top-0 bottom-0 w-px bg-amber-300/80 pointer-events-none" style={{ left: "0%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
