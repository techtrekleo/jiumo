"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Clock, Plus, X, ChevronUp, ChevronDown, Wand2 } from "lucide-react";
import type { Layer, BgFilter, TextAnim, Easing } from "../engine/composition";
import { genFilterId } from "../engine/composition";
import { LYRIC_FONTS } from "../engine/lyrics";
import { BG_EFFECTS, BG_CATEGORIES, setBgThumbSource, renderBgThumb } from "../engine/bg-fx";
import { Collapsible } from "./collapsible";

const TEXT_FX: { id: "none" | "outline" | "shadow" | "neon" | "lines"; label: string }[] = [
  { id: "none", label: "無" }, { id: "outline", label: "描邊" }, { id: "shadow", label: "陰影" }, { id: "neon", label: "霓虹" }, { id: "lines", label: "白線夾" },
];
// 文字特效複選：取目前清單（舊專案的單一 textEffect 也相容）、切換單一特效
function fxListOf(p: Record<string, unknown>): string[] {
  const arr = p.textEffects as string[] | undefined;
  if (arr) return arr;
  const old = p.textEffect as string | undefined;
  return old && old !== "none" ? [old] : [];
}
function toggleFx(id: string, cur: string[]): string[] {
  if (id === "none") return []; // 「無」＝清空
  return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

/* 九墨 Phase 2-4（素材層）— 選中圖層的屬性 + 上傳面板。
   背景圖 / Logo 圖 / 影片 / 文字的上傳與調整；位置·大小走 transform；起訖秒數走 timing。
   墨效 / 墨體 / 歌詞 仍由既有面板（右欄墨效、左欄墨體、歌單綁 LRC）控制，此處只提示。 */

type Props = {
  layer: Layer | null;
  duration: number;
  onPatchParams: (id: string, params: Record<string, unknown>) => void;
  onPatchTransform: (id: string, t: { x?: number; y?: number; scale?: number; w?: number; h?: number; rot?: number }) => void;
  onPatchTiming: (id: string, t: { start?: number; end?: number }) => void;
  onUpload: (id: string, file: File, target: "image" | "video" | "bg" | "lrc") => void;
  onEditLyrics?: () => void;
};

function Slider({ label, value, min, max, step, onChange, fmt }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  return (
    <div>
      <label className="text-[10px] text-white/40 flex justify-between">
        <span>{label}</span><span className="text-white/55">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full accent-red-400" />
    </div>
  );
}

function UploadButton({ label, accept, onFile }: { label: string; accept: string; onFile: (f: File) => void }) {
  return (
    <label className="flex items-center justify-center gap-1.5 text-[12px] text-white/70 hover:text-white border border-white/15 hover:border-white/40 rounded-lg px-3 py-2 transition cursor-pointer">
      <Upload size={13} /> {label}
      <input type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </label>
  );
}

const BG_FX_NAME: Record<string, string> = Object.fromEntries(BG_EFFECTS.map((e) => [e.id, e.name]));

// 濾鏡選單縮圖：把使用者的背景圖套上該效果、即時（會動的效果也動）預覽
function FilterThumb({ fx, url }: { fx: string; url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    setBgThumbSource(url);
    let raf = 0, stop = false;
    const tick = () => { if (stop) return; if (ref.current) renderBgThumb(fx, ref.current, 0.7); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [fx, url]);
  return <canvas ref={ref} width={120} height={68} className="w-full rounded-md bg-black/40 block" />;
}

// 背景濾鏡編輯器：加效果（縮圖選單）＋ 堆疊清單（每個強度滑桿、排序、移除）
function BgFilterEditor({ filters, imageUrl, onChange }: {
  filters: BgFilter[]; imageUrl: string | null; onChange: (f: BgFilter[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const add = (fx: string) => {
    let f: BgFilter = { id: genFilterId(), fx, amount: 0.7 };
    if (fx === "snow") f = { ...f, amount: 0.5, density: 0.5 };                                    // 緩緩往下、固定速度、只調疏密度
    else if (fx === "lightdots") f = { ...f, amount: 0.5, density: 0.5 };                           // 原地閃爍、只調疏密度
    else if (fx === "glint") f = { ...f, amount: 0.5, posX: 0.5, posY: 0.5, scale: 1, angle: 0, colorA: "#ffffff", colorB: "#bfe0ff" }; // 水平、置中
    else if (fx === "crossglass") f = { ...f, amount: 0.9, posX: 0.5, posY: 0.5, scale: 1, angle: 45, angle2: 135, density: 0.35, speed: 0.55, colorA: "#ffffff" }; // 交叉聚焦框、線一45/線二135
    else if (fx === "lightsweep") f = { ...f, amount: 0.85, speed: 0.4, posX: 0.45, density: 0.7, scale: 1, colorA: "#ffffff" }; // 玻璃滑光：頻率＋滑動速度＋去色底
    onChange([...filters, f]); setPicking(false);
  };
  const patch = (id: string, amount: number) => onChange(filters.map((f) => (f.id === id ? { ...f, amount } : f)));
  const patchF = (id: string, p: Partial<BgFilter>) => onChange(filters.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const remove = (id: string) => onChange(filters.filter((f) => f.id !== id));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= filters.length) return;
    const next = [...filters]; [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  };

  return (
    <div className="space-y-2 pt-1 border-t border-white/10">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/50 flex items-center gap-1"><Wand2 size={12} /> 濾鏡 · 特效</span>
        <button type="button" onClick={() => setPicking((v) => !v)} disabled={!imageUrl}
          className="flex items-center gap-1 text-[11px] text-white/65 hover:text-white border border-white/15 hover:border-white/40 rounded-md px-2 py-1 transition disabled:opacity-35 disabled:hover:border-white/15">
          <Plus size={12} /> 加濾鏡
        </button>
      </div>

      {!imageUrl && <p className="text-[10px] text-white/30">先上傳背景圖才能套濾鏡（純色紙套濾鏡沒效果）</p>}

      {picking && imageUrl && (
        <div className="space-y-2 bg-black/30 rounded-lg p-2 max-h-72 overflow-y-auto">
          {BG_CATEGORIES.map((cat) => (
            <div key={cat.name} className="space-y-1">
              <p className="text-[10px] text-white/35">{cat.name}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {cat.ids.map((fx) => (
                  <button key={fx} type="button" onClick={() => add(fx)}
                    className="group text-left rounded-md overflow-hidden border border-white/10 hover:border-red-400/60 transition">
                    <FilterThumb fx={fx} url={imageUrl} />
                    <span className="block text-[10px] text-white/60 group-hover:text-white px-1.5 py-1">{BG_FX_NAME[fx]}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {filters.length === 0 ? (
        <p className="text-[10px] text-white/25">尚未套用任何濾鏡</p>
      ) : (
        <div className="space-y-2">
          {filters.map((f, i) => (
            <div key={f.id} className="bg-black/25 rounded-lg px-2 py-1.5 space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] text-white/70">{BG_FX_NAME[f.fx] ?? f.fx}</span>
                <div className="flex items-center gap-0.5 text-white/40">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                    className="hover:text-white disabled:opacity-25 p-0.5"><ChevronUp size={13} /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === filters.length - 1}
                    className="hover:text-white disabled:opacity-25 p-0.5"><ChevronDown size={13} /></button>
                  <button type="button" onClick={() => remove(f.id)} className="hover:text-red-300 p-0.5"><X size={13} /></button>
                </div>
              </div>
              <Slider label="強度" value={f.amount} min={0} max={1} step={0.01}
                onChange={(v) => patch(f.id, v)} fmt={(v) => `${Math.round(v * 100)}%`} />
              {(f.fx === "snow" || f.fx === "lightdots") && (
                <Slider label="疏密度" value={f.density ?? 0.5} min={0} max={1} step={0.01}
                  onChange={(v) => patchF(f.id, { density: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              )}
              {f.fx === "lightsweep" && (<>
                <Slider label="頻率" value={f.speed ?? 0.4} min={0} max={1} step={0.01}
                  onChange={(v) => patchF(f.id, { speed: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="滑動速度" value={f.posX ?? 0.45} min={0} max={1} step={0.01}
                  onChange={(v) => patchF(f.id, { posX: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="去色程度" value={f.density ?? 0.7} min={0} max={1} step={0.01}
                  onChange={(v) => patchF(f.id, { density: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="光帶寬" value={f.scale ?? 1} min={0.3} max={3} step={0.05}
                  onChange={(v) => patchF(f.id, { scale: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                <label className="flex items-center gap-1.5 text-[11px] text-white/50 pt-0.5">光色
                  <input type="color" value={f.colorA ?? "#ffffff"} onChange={(e) => patchF(f.id, { colorA: e.target.value })}
                    className="w-8 h-6 rounded border border-white/15 bg-transparent cursor-pointer" /></label>
              </>)}
              {(f.fx === "glint" || f.fx === "crossglass") && (
                <>
                  <Slider label="水平位置" value={f.posX ?? 0.5} min={0} max={1} step={0.01}
                    onChange={(v) => patchF(f.id, { posX: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                  <Slider label="垂直位置" value={f.posY ?? 0.5} min={0} max={1} step={0.01}
                    onChange={(v) => patchF(f.id, { posY: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                  <Slider label="大小" value={f.scale ?? 1} min={0.2} max={3} step={0.05}
                    onChange={(v) => patchF(f.id, { scale: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                  {f.fx === "glint" && (
                    <Slider label="角度" value={f.angle ?? 0} min={-90} max={90} step={1}
                      onChange={(v) => patchF(f.id, { angle: v })} fmt={(v) => `${Math.round(v)}°`} />
                  )}
                  {f.fx === "crossglass" && (<>
                    <Slider label="線一角度" value={f.angle ?? 45} min={0} max={180} step={1}
                      onChange={(v) => patchF(f.id, { angle: v })} fmt={(v) => `${Math.round(v)}°`} />
                    <Slider label="線二角度" value={f.angle2 ?? 135} min={0} max={180} step={1}
                      onChange={(v) => patchF(f.id, { angle2: v })} fmt={(v) => `${Math.round(v)}°`} />
                    <Slider label="外圈模糊" value={f.speed ?? 0.55} min={0} max={1} step={0.01}
                      onChange={(v) => patchF(f.id, { speed: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                    <Slider label="外圈黑白" value={f.density ?? 0.35} min={0} max={1} step={0.01}
                      onChange={(v) => patchF(f.id, { density: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                  </>)}
                  {f.fx === "glint" ? (
                    <div className="flex items-center gap-3 pt-0.5">
                      <label className="flex items-center gap-1.5 text-[11px] text-white/50">漸層起
                        <input type="color" value={f.colorA ?? "#ffffff"} onChange={(e) => patchF(f.id, { colorA: e.target.value })}
                          className="w-8 h-6 rounded border border-white/15 bg-transparent cursor-pointer" /></label>
                      <label className="flex items-center gap-1.5 text-[11px] text-white/50">漸層終
                        <input type="color" value={f.colorB ?? "#bfe0ff"} onChange={(e) => patchF(f.id, { colorB: e.target.value })}
                          className="w-8 h-6 rounded border border-white/15 bg-transparent cursor-pointer" /></label>
                    </div>
                  ) : (
                    <label className="flex items-center gap-1.5 text-[11px] text-white/50 pt-0.5">外框色
                      <input type="color" value={f.colorA ?? "#ffffff"} onChange={(e) => patchF(f.id, { colorA: e.target.value })}
                        className="w-8 h-6 rounded border border-white/15 bg-transparent cursor-pointer" /></label>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ANIM_TOGGLES: { key: keyof TextAnim; label: string }[] = [
  { key: "alpha", label: "淡入" }, { key: "blur", label: "模糊入" }, { key: "scale", label: "縮放入" }, { key: "horiz", label: "水平滑入" },
  { key: "vert", label: "垂直滑入" }, { key: "liquid", label: "液化" }, { key: "distort", label: "扭曲" }, { key: "shake", label: "晃動" },
];
const ANIM_EASE: { id: Easing; label: string }[] = [
  { id: "out", label: "漸慢" }, { id: "in", label: "漸快" }, { id: "inout", label: "平滑" }, { id: "linear", label: "等速" },
];

// 文字/字幕進場動畫編輯器（toggle ＋ 進場時長/緩動 ＋ 晃動細項）
function TextAnimEditor({ anim, onChange }: { anim: TextAnim | undefined; onChange: (a: TextAnim) => void }) {
  const a = anim ?? {};
  const set = (patch: Partial<TextAnim>) => onChange({ ...a, ...patch });
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {ANIM_TOGGLES.map((tg) => (
          <label key={tg.key} className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
            <input type="checkbox" checked={!!a[tg.key]} className="accent-red-400"
              onChange={(e) => set({ [tg.key]: e.target.checked } as Partial<TextAnim>)} />
            {tg.label}
          </label>
        ))}
      </div>
      <Slider label="進場時長" value={a.inDur ?? 0.5} min={0.1} max={2} step={0.05} onChange={(v) => set({ inDur: v })} fmt={(v) => `${v.toFixed(2)}s`} />
      <label className="text-[10px] text-white/40 block">進場緩動
        <select value={a.easing ?? "out"} onChange={(e) => set({ easing: e.target.value as Easing })}
          className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] text-white/70 outline-none focus:border-white/30">
          {ANIM_EASE.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      {a.shake && (
        <div className="space-y-1.5 pt-0.5 border-t border-white/5">
          <Slider label="晃動幅度" value={a.shakeAmp ?? 8} min={1} max={40} step={1} onChange={(v) => set({ shakeAmp: v })} fmt={(v) => `${Math.round(v)}px`} />
          <Slider label="晃動頻率" value={a.shakeFreq ?? 14} min={2} max={30} step={1} onChange={(v) => set({ shakeFreq: v })} fmt={(v) => `${Math.round(v)}`} />
          <Slider label="晃動時長" value={a.shakeDur ?? 0.4} min={0.1} max={1.5} step={0.05} onChange={(v) => set({ shakeDur: v })} fmt={(v) => `${v.toFixed(2)}s`} />
        </div>
      )}
      <p className="text-[10px] text-white/25">文字出現時觸發；液化/扭曲為持續效果。需播放才看得到。</p>
    </div>
  );
}

export function LayerInspector({ layer, duration, onPatchParams, onPatchTransform, onPatchTiming, onUpload, onEditLyrics }: Props) {
  if (!layer) {
    return (
      <div className="bg-white/[0.03] rounded-xl p-3">
        <p className="text-[11px] text-white/35 leading-relaxed">點左邊圖層樹選一層，這裡會出現它的上傳與屬性控制</p>
      </div>
    );
  }
  const p = layer.params as unknown as Record<string, unknown>;
  const tf = layer.transform;
  const tm = layer.timing ?? { start: 0, end: -1 };
  const endToTail = tm.end < 0;

  return (
    <div className="space-y-3">
      <div className="bg-white/[0.03] rounded-xl p-3 space-y-3">
      <p className="text-[11px] text-white/40 tracking-wider">{layer.name} <span className="text-white/25">· 屬性</span></p>

      {layer.type === "background" && (
        <div className="space-y-2">
          <UploadButton label="上傳背景圖" accept="image/*" onFile={(f) => onUpload(layer.id, f, "bg")} />
          {typeof p.fileName === "string" && p.fileName && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-white/35 truncate">{p.fileName as string}</span>
              <button type="button" className="text-[10px] text-white/45 hover:text-red-300"
                onClick={() => onPatchParams(layer.id, { imageUrl: null, fileName: "" })}>移除圖</button>
            </div>
          )}
          {p.imageUrl ? (
            <Slider label="背景圖不透明度" value={(p.imageOpacity as number) ?? 1} min={0} max={1} step={0.01}
              onChange={(v) => onPatchParams(layer.id, { imageOpacity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          ) : null}
          <label className="flex items-center justify-between text-[11px] text-white/55">
            <span>背景色</span>
            <span className="flex items-center gap-1.5">
              <input type="color" value={(p.customColor as string) ?? "#1a1414"}
                onChange={(e) => onPatchParams(layer.id, { customColor: e.target.value })}
                className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
              {p.customColor
                ? <button type="button" className="text-[10px] text-white/45 hover:text-red-300" onClick={() => onPatchParams(layer.id, { customColor: null })}>用紙色</button>
                : <span className="text-[10px] text-white/30">（用紙色）</span>}
            </span>
          </label>
          <p className="text-[10px] text-white/25">背景色＝底色（圖半透明時透出）；沒選＝用右欄「紙色」宣紙/夜紙</p>
          <BgFilterEditor
            filters={(p.filters as BgFilter[]) ?? []}
            imageUrl={(p.imageUrl as string | null) ?? null}
            onChange={(f) => onPatchParams(layer.id, { filters: f })}
          />
        </div>
      )}

      {layer.type === "image" && (
        <div className="space-y-2">
          <UploadButton label={p.dataUrl ? "換一張圖" : "上傳圖片 / Logo"} accept="image/*" onFile={(f) => onUpload(layer.id, f, "image")} />
          {typeof p.fileName === "string" && p.fileName && <span className="text-[10px] text-white/35 truncate block">{p.fileName as string}</span>}
          <Slider label="不透明度" value={p.opacity as number} min={0} max={1} step={0.01} onChange={(v) => onPatchParams(layer.id, { opacity: v })} />
        </div>
      )}

      {layer.type === "video" && (
        <div className="space-y-2">
          <UploadButton label={p.src ? "換一支影片" : "上傳影片"} accept="video/*" onFile={(f) => onUpload(layer.id, f, "video")} />
          {typeof p.fileName === "string" && p.fileName && <span className="text-[10px] text-white/35 truncate block">{p.fileName as string}</span>}
          <div className="flex gap-1.5">
            <button type="button" onClick={() => onPatchParams(layer.id, { mode: "intro", loop: false })}
              className={`flex-1 text-[11px] rounded-lg px-2 py-1.5 border transition ${p.mode === "intro" ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>片頭（全螢幕）</button>
            <button type="button" onClick={() => onPatchParams(layer.id, { mode: "cta" })}
              className={`flex-1 text-[11px] rounded-lg px-2 py-1.5 border transition ${p.mode === "cta" ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>角落小窗</button>
          </div>
          <p className="text-[10px] text-white/25">{p.mode === "intro" ? "鋪滿畫面、播完自動露出主視覺（建議搭「播放一次」）" : "小窗依下方「位置·大小」擺放"}</p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => onPatchParams(layer.id, { loop: true })}
              className={`flex-1 text-[11px] rounded-lg px-2 py-1.5 border transition ${p.loop ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>LOOP 循環</button>
            <button type="button" onClick={() => onPatchParams(layer.id, { loop: false })}
              className={`flex-1 text-[11px] rounded-lg px-2 py-1.5 border transition ${!p.loop ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>播放一次</button>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
            <input type="checkbox" checked={p.blend === "screen"} className="accent-red-400"
              onChange={(e) => onPatchParams(layer.id, { blend: e.target.checked ? "screen" : "normal" })} />
            黑底去背（純黑透明、亮部疊在畫面上）
          </label>
          <p className="text-[10px] text-white/25">用下方時間軸控制它第幾秒到第幾秒出現</p>
        </div>
      )}

      {layer.type === "text" && (
        <div className="space-y-2">
          <input type="text" value={p.content as string} placeholder="輸入文字"
            onChange={(e) => onPatchParams(layer.id, { content: e.target.value })}
            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-white/30" />
          <select value={p.fontId as string} onChange={(e) => onPatchParams(layer.id, { fontId: e.target.value })}
            className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-white/30">
            {LYRIC_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div className="flex gap-1.5">
            {(() => { const cur = fxListOf(p); return TEXT_FX.map((fx) => {
              const active = fx.id === "none" ? cur.length === 0 : cur.includes(fx.id);
              return (
                <button key={fx.id} type="button" onClick={() => onPatchParams(layer.id, { textEffects: toggleFx(fx.id, cur) })}
                  className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${active ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{fx.label}</button>
              );
            }); })()}
          </div>
          {fxListOf(p).includes("lines") && (
            <div className="flex gap-1.5">
              {(["top", "bottom", "both"] as const).map((m) => {
                const lbl = m === "top" ? "上線" : m === "bottom" ? "下線" : "雙線";
                const cur = (p as { lineMode?: "top" | "bottom" | "both" }).lineMode ?? "both";
                return (
                  <button key={m} type="button" onClick={() => onPatchParams(layer.id, { lineMode: m })}
                    className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${cur === m ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{lbl}</button>
                );
              })}
            </div>
          )}
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>顏色</span>
            <input type="color" value={p.color as string} onChange={(e) => onPatchParams(layer.id, { color: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
        </div>
      )}

      {layer.type === "seal" && (() => {
        const mode = (p.mode as string) ?? "brand";
        return (
          <div className="space-y-2">
            <div className="flex gap-1.5">
              {[{ id: "brand", label: "品牌章" }, { id: "custom", label: "自訂落款" }].map((m) => (
                <button key={m.id} type="button" onClick={() => onPatchParams(layer.id, { mode: m.id })}
                  className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${mode === m.id ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{m.label}</button>
              ))}
            </div>
            {mode === "brand" ? (
              <>
                <div className="flex gap-1.5">
                  {[{ id: "jiumo", label: "九墨" }, { id: "jiuliyue", label: "九黎月" }].map((b) => {
                    const on = ((p.brandId as string) ?? "jiumo") === b.id;
                    return (
                      <button key={b.id} type="button" onClick={() => onPatchParams(layer.id, { brandId: b.id })}
                        className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${on ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{b.label}</button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-white/45 leading-relaxed">品牌落款，內容固定不可改（劍豪體烤進圖）。場上一旦有自訂落款，這枚會自動隱藏（刪掉自訂落款即恢復）。</p>
              </>
            ) : (
              <>
                <p className="text-[11px] text-white/45 leading-relaxed">刻你自己的章。直書印文（建議姓名／字號 1～4 字），顯示時內建「九墨」落款會自動隱藏。</p>
                <input type="text" value={(p.text as string) ?? ""} maxLength={8} placeholder="印文，如：墨白"
                  onChange={(e) => onPatchParams(layer.id, { text: e.target.value })}
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-white/30" />
                <select value={(p.fontId as string) ?? LYRIC_FONTS[0].id} onChange={(e) => onPatchParams(layer.id, { fontId: e.target.value })}
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-white/30">
                  {LYRIC_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-[11px] text-white/50">
                    <span>印泥</span>
                    <input type="color" value={(p.sealColor as string) ?? "#9e2b25"} onChange={(e) => onPatchParams(layer.id, { sealColor: e.target.value })}
                      className="w-9 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-white/50">
                    <span>印文</span>
                    <input type="color" value={(p.textColor as string) ?? "#f4ede5"} onChange={(e) => onPatchParams(layer.id, { textColor: e.target.value })}
                      className="w-9 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
                  </label>
                </div>
              </>
            )}
            <Slider label="不透明度" value={p.opacity as number} min={0} max={1} step={0.01} onChange={(v) => onPatchParams(layer.id, { opacity: v })} />
          </div>
        );
      })()}

      {layer.type === "cta" && (
        <div className="space-y-2">
          <p className="text-[11px] text-white/45 leading-relaxed">訂閱 CTA：拇指 → 訂閱 → 鈴鐺，游標依序點擊、硃砂墨暈染上墨。預設片頭跑一次就墨隱消失。下方調位置·大小、上方調出現時段（從第幾秒開始）。</p>
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>墨色</span>
            <input type="color" value={(p.color as string) ?? "#9e2b25"} onChange={(e) => onPatchParams(layer.id, { color: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
            <input type="checkbox" checked={p.loop as boolean} onChange={(e) => onPatchParams(layer.id, { loop: e.target.checked })} className="accent-red-400" />
            循環播放（開＝一直在畫面上跑；關＝跑一次墨隱消失）
          </label>
        </div>
      )}

      {layer.type === "player" && (
        <div className="space-y-2">
          <p className="text-[11px] text-white/45 leading-relaxed">控制板：左圓角＋右半圓的液態玻璃面板（背景在卡邊緣折射放大＋色散），中間夾一張會轉的唱片，底部時間軸跟著影片進度跑。下方調位置·大小。玻璃效果需有背景圖才看得出。</p>
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>雨夜罩色</span>
            <input type="color" value={(p.wetColor as string) ?? "#1c2b3a"} onChange={(e) => onPatchParams(layer.id, { wetColor: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>唱片標籤 · 進度色</span>
            <input type="color" value={(p.accent as string) ?? "#9e2b25"} onChange={(e) => onPatchParams(layer.id, { accent: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>霓虹光色</span>
            <input type="color" value={(p.glow as string) ?? "#6fb4d8"} onChange={(e) => onPatchParams(layer.id, { glow: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
          <Slider label="雨夜濕潤度" value={(p.wet as number) ?? 0.5} min={0} max={1} step={0.01}
            onChange={(v) => onPatchParams(layer.id, { wet: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="唱片轉速" value={(p.spin as number) ?? 0.25} min={0} max={1.5} step={0.05}
            onChange={(v) => onPatchParams(layer.id, { spin: v })} fmt={(v) => `${v.toFixed(2)} 圈/秒`} />
          <div className="pt-1 mt-1 border-t border-white/10 space-y-2">
            <p className="text-[10px] text-white/30 tracking-wider">液態玻璃</p>
            <Slider label="背景模糊" value={(p.bgBlur as number) ?? 0.6} min={0} max={1} step={0.01}
              onChange={(v) => onPatchParams(layer.id, { bgBlur: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="播放器模糊（霜面）" value={(p.frostBlur as number) ?? 0.4} min={0} max={1} step={0.01}
              onChange={(v) => onPatchParams(layer.id, { frostBlur: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="邊緣折射" value={(p.refract as number) ?? 0.6} min={0} max={1} step={0.01}
              onChange={(v) => onPatchParams(layer.id, { refract: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="色散（彩色邊）" value={(p.aberration as number) ?? 0.5} min={0} max={1} step={0.01}
              onChange={(v) => onPatchParams(layer.id, { aberration: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          </div>
        </div>
      )}

      {layer.type === "effect" && (
        <p className="text-[10px] text-white/30 leading-relaxed">墨效／紙色／墨色與參數 ↓ 在下方</p>
      )}
      {layer.type === "body" && (
        <p className="text-[10px] text-white/30 leading-relaxed">墨體用下方「墨體」面板調整</p>
      )}
      {layer.type === "lyrics" && (
        <div className="space-y-2">
          <UploadButton label={Array.isArray(p.lines) && (p.lines as unknown[]).length ? "換一組 LRC/SRT" : "綁這層的 LRC / SRT"} accept=".lrc,.srt" onFile={(f) => onUpload(layer.id, f, "lrc")} />
          {Array.isArray(p.lines) && (p.lines as unknown[]).length > 0 ? (
            <span className="text-[10px] text-white/35 block">{(p.lines as unknown[]).length} 句 · 可自由定位字幕</span>
          ) : (
            <p className="text-[10px] text-white/25 leading-relaxed">沒綁＝顯示「歌單」那首歌的歌詞（卷軸）。綁一組就變可自由定位、可多組疊的字幕</p>
          )}
          <select value={p.fontId as string} onChange={(e) => onPatchParams(layer.id, { fontId: e.target.value })}
            className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-white/30">
            {LYRIC_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div className="flex gap-1.5">
            {(() => { const cur = fxListOf(p); return TEXT_FX.map((fx) => {
              const active = fx.id === "none" ? cur.length === 0 : cur.includes(fx.id);
              return (
                <button key={fx.id} type="button" onClick={() => onPatchParams(layer.id, { textEffects: toggleFx(fx.id, cur) })}
                  className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${active ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{fx.label}</button>
              );
            }); })()}
          </div>
          {fxListOf(p).includes("lines") && (
            <div className="flex gap-1.5">
              {(["top", "bottom", "both"] as const).map((m) => {
                const lbl = m === "top" ? "上線" : m === "bottom" ? "下線" : "雙線";
                const cur = (p as { lineMode?: "top" | "bottom" | "both" }).lineMode ?? "both";
                return (
                  <button key={m} type="button" onClick={() => onPatchParams(layer.id, { lineMode: m })}
                    className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${cur === m ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{lbl}</button>
                );
              })}
            </div>
          )}
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>字色</span>
            <input type="color" value={p.color as string} onChange={(e) => onPatchParams(layer.id, { color: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
          {onEditLyrics && (
            <button type="button" onClick={onEditLyrics}
              className="flex items-center justify-center gap-1.5 w-full text-[12px] text-white/70 hover:text-white border border-white/15 hover:border-white/40 rounded-lg px-3 py-2 transition">
              <Clock size={13} /> 編輯歌詞秒數
            </button>
          )}
        </div>
      )}
      </div>

      {(layer.type === "text" || layer.type === "lyrics") && (
        <Collapsible title="文字動畫">
          <TextAnimEditor anim={p.anim as TextAnim | undefined} onChange={(a) => onPatchParams(layer.id, { anim: a })} />
        </Collapsible>
      )}

      {layer.type === "alpha" && (
        <Collapsible title="透明度層">
          <p className="text-[10px] text-white/35 leading-relaxed">在區域（或整張）疊一層色，不透明度跟音樂跳動 → 讓底下的圖閃動。</p>
          <label className="flex items-center justify-between text-[11px] text-white/50">
            <span>疊色</span>
            <input type="color" value={(p.color as string) ?? "#000000"} onChange={(e) => onPatchParams(layer.id, { color: e.target.value })}
              className="w-10 h-7 rounded border border-white/15 bg-transparent cursor-pointer" />
          </label>
          <div className="flex gap-1.5">
            {(["beat", "shimmer"] as const).map((m) => (
              <button key={m} type="button" onClick={() => onPatchParams(layer.id, { mode: m })}
                className={`flex-1 text-[11px] rounded px-1 py-1 border transition ${(((p as { mode?: string }).mode ?? "beat") === m) ? "border-white/45 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>{m === "beat" ? "跟鼓點" : "連續微閃"}</button>
            ))}
          </div>
          <Slider label="閃動幅度" value={(p.intensity as number) ?? 0.6} min={0} max={1} step={0.01} onChange={(v) => onPatchParams(layer.id, { intensity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="常駐壓色" value={(p.base as number) ?? 0} min={0} max={1} step={0.01} onChange={(v) => onPatchParams(layer.id, { base: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          {((p as { mode?: string }).mode ?? "beat") === "shimmer" && (
            <Slider label="微閃頻率" value={(p.speed as number) ?? 6} min={1} max={20} step={0.5} onChange={(v) => onPatchParams(layer.id, { speed: v })} fmt={(v) => `${v}/s`} />
          )}
          {tf && (
            <div className="pt-1.5 mt-1 space-y-2 border-t border-white/10">
              <p className="text-[10px] text-white/35">區域（寬高 100% ＝整張）</p>
              <Slider label="水平" value={tf.x} min={0} max={1} step={0.01} onChange={(v) => onPatchTransform(layer.id, { x: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="垂直" value={tf.y} min={0} max={1} step={0.01} onChange={(v) => onPatchTransform(layer.id, { y: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="寬" value={tf.w ?? 1} min={0.05} max={1} step={0.01} onChange={(v) => onPatchTransform(layer.id, { w: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="高" value={tf.h ?? 1} min={0.05} max={1} step={0.01} onChange={(v) => onPatchTransform(layer.id, { h: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="旋轉" value={tf.rot ?? 0} min={-180} max={180} step={1} onChange={(v) => onPatchTransform(layer.id, { rot: v })} fmt={(v) => `${Math.round(v)}°`} />
              <button type="button" onClick={() => onPatchTransform(layer.id, { x: 0.5, y: 0.5, w: 1, h: 1, rot: 0 })}
                className="text-[10px] text-white/45 border border-white/15 rounded-full px-2.5 py-1 hover:border-white/35 hover:text-white/80 transition">整張</button>
            </div>
          )}
        </Collapsible>
      )}

      {tf && (layer.type === "image" || layer.type === "video" || layer.type === "text" || layer.type === "lyrics" || layer.type === "seal" || layer.type === "cta" || layer.type === "player") && (
        <Collapsible title="位置 · 大小">
          <Slider label="水平" value={tf.x} min={0} max={1} step={0.01} onChange={(v) => onPatchTransform(layer.id, { x: v })} />
          <Slider label="垂直" value={tf.y} min={0} max={1} step={0.01} onChange={(v) => onPatchTransform(layer.id, { y: v })} />
          <Slider label="大小" value={tf.scale} min={0.02} max={2} step={0.01} onChange={(v) => onPatchTransform(layer.id, { scale: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
        </Collapsible>
      )}

      <Collapsible title="出現時段（秒）">
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-white/40 flex-1">
            起<input type="number" min={0} step={0.5} value={tm.start}
              onChange={(e) => onPatchTiming(layer.id, { start: Math.max(0, parseFloat(e.target.value) || 0) })}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] outline-none focus:border-white/30" />
          </label>
          <label className="text-[10px] text-white/40 flex-1">
            訖{endToTail ? <span className="text-white/30"> （到結尾）</span> : null}
            <input type="number" min={0} step={0.5} value={endToTail ? "" : tm.end} disabled={endToTail} placeholder="—"
              onChange={(e) => onPatchTiming(layer.id, { end: parseFloat(e.target.value) || 0 })}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] outline-none focus:border-white/30 disabled:opacity-40" />
          </label>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-white/55 cursor-pointer select-none">
          <input type="checkbox" checked={endToTail} className="accent-red-400"
            onChange={(e) => onPatchTiming(layer.id, { end: e.target.checked ? -1 : Math.max(tm.start + 1, Math.min(duration || tm.start + 5, tm.start + 5)) })} />
          一直到結尾
        </label>
      </Collapsible>
    </div>
  );
}
