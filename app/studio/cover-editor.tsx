"use client";

// 封面製作 overlay：上傳底圖 → 比例(16:9/9:16/1:1) → 畫質(最高 4K，8K 桌機) → 文字(打字/縮放/位移/描邊/陰影) →
// 美化特效(交叉液態玻璃可拖曳聚焦 + 暗角/色像差等) → 匯出 PNG。文字與特效以目標解析度重繪＝無損銳利。

import { useEffect, useRef, useState, useCallback } from "react";
import { X, Upload, Plus, Download, ChevronUp, ChevronDown, Trash2, Image as ImageIcon } from "lucide-react";
import { LYRIC_FONTS } from "../engine/lyrics";
import { BgFx, type BgFilterCall } from "../engine/bg-fx";
import {
  COVER_RATIOS, COVER_RES, COVER_FX_MENU, COVER_BLENDS, coverDims, coverPreviewDims,
  defaultCoverText, genCoverTextId, defaultCoverFx, genCoverFxId, coverFxName,
  defaultCoverCrop, genCoverImageId, defaultCoverImage, renderCover, detectMaxTexture,
  type CoverRatio, type CoverResTier, type CoverText, type CoverFx, type CoverCrop, type CoverImage,
} from "../engine/cover";

type Sel = { kind: "text" | "fx" | "img"; id: string } | null;
type EditorOverlay = CoverImage & { img: HTMLImageElement; name: string; url: string };

const BTN = "px-2.5 py-1 rounded-lg text-[12px] border border-white/15 bg-black/40 text-white/70 hover:text-white hover:border-white/40 transition cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed";

function Slider({ label, value, min, max, step, onChange, fmt }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  return (
    <div>
      <label className="text-[10px] text-white/45 flex justify-between"><span>{label}</span><span className="text-white/60">{fmt ? fmt(value) : value}</span></label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full accent-red-400" />
    </div>
  );
}
const Swatch = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
  <label className="flex items-center gap-1.5 text-[11px] text-white/50">{label}
    <input type="color" value={value.startsWith("#") ? value : "#000000"} onChange={(e) => onChange(e.target.value)} className="w-7 h-6 rounded border border-white/15 bg-transparent cursor-pointer" />
  </label>
);

export function CoverEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
  const [bgName, setBgName] = useState("");
  const [ratio, setRatio] = useState<CoverRatio>("16:9");
  const [resTier, setResTier] = useState<CoverResTier>("4k");
  const [texts, setTexts] = useState<CoverText[]>([]);
  const [overlays, setOverlays] = useState<EditorOverlay[]>([]);
  const [fx, setFx] = useState<CoverFx[]>([]);
  const [crop, setCrop] = useState<CoverCrop>(defaultCoverCrop());
  const [sel, setSel] = useState<Sel>(null);
  const [msg, setMsg] = useState("上傳一張底圖開始，或直接放文字做純色封面");
  const [exporting, setExporting] = useState(false);
  const [maxTex, setMaxTex] = useState(16384);
  const [showFxMenu, setShowFxMenu] = useState(false);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const overlayFileRef = useRef<HTMLInputElement>(null);
  const overlaysRef = useRef<EditorOverlay[]>([]);
  useEffect(() => { overlaysRef.current = overlays; }, [overlays]);
  const previewFxRef = useRef<BgFx | null>(null);
  const bgUrlRef = useRef<string>("");
  const dragRef = useRef(false);
  const selRef = useRef<Sel>(null);
  useEffect(() => { selRef.current = sel; }, [sel]);
  const bgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => { bgRef.current = bgImg; }, [bgImg]);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number }>({ x: 0, y: 0, ox: 0.5, oy: 0.5 });

  useEffect(() => { setMaxTex(detectMaxTexture()); }, []);
  // 卸載清理（GL context + objectURL）
  useEffect(() => () => { previewFxRef.current?.destroy(); if (bgUrlRef.current) URL.revokeObjectURL(bgUrlRef.current); overlaysRef.current.forEach((o) => URL.revokeObjectURL(o.url)); }, []);

  const fxCalls = useCallback((): BgFilterCall[] =>
    fx.map((f) => ({ fx: f.fx, amount: f.amount, posX: f.posX, posY: f.posY, scale: f.scale, angle: f.angle, angle2: f.angle2, density: f.density, speed: f.speed, colorA: f.colorA, colorB: f.colorB })), [fx]);

  const renderPreview = useCallback(() => {
    const cv = previewRef.current; if (!cv) return;
    if (!previewFxRef.current) previewFxRef.current = new BgFx(document.createElement("canvas"));
    const { w, h } = coverPreviewDims(ratio);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext("2d"); if (!ctx) return;
    renderCover(ctx, { W: w, H: h, bgImg, bgColor: "#0a0809", texts, fx: fxCalls(), fxEngine: previewFxRef.current, crop, overlays: overlays.map((o) => ({ ci: o, img: o.img })) });
  }, [ratio, bgImg, texts, fxCalls, crop, overlays]);

  useEffect(() => { if (open) renderPreview(); }, [open, renderPreview]);
  useEffect(() => {
    if (open && typeof document !== "undefined" && "fonts" in document) {
      (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready.then(() => renderPreview());
    }
  }, [open, renderPreview]);

  const onUpload = (file: File) => {
    if (bgUrlRef.current) URL.revokeObjectURL(bgUrlRef.current);
    const url = URL.createObjectURL(file);
    bgUrlRef.current = url;
    const img = new Image();
    img.onload = () => { setBgImg(img); setBgName(file.name); setCrop(defaultCoverCrop()); setMsg(`已載入 ${img.naturalWidth}×${img.naturalHeight}px`); };
    img.onerror = () => setMsg("圖片載入失敗，換一張試試");
    img.src = url;
  };

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  // 預覽拖曳：選中文字/特效 → 移動它；什麼都沒選 → 平移底圖裁切
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, ox: crop.x, oy: crop.y };
    onPointerMove(e);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const cv = previewRef.current; if (!cv) return;
    const r = cv.getBoundingClientRect();
    const s = selRef.current;
    if (s) {
      const x = clamp01((e.clientX - r.left) / r.width), y = clamp01((e.clientY - r.top) / r.height);
      if (s.kind === "text") setTexts((ts) => ts.map((t) => (t.id === s.id ? { ...t, x, y } : t)));
      else if (s.kind === "img") setOverlays((os) => os.map((o) => (o.id === s.id ? { ...o, x, y } : o)));
      else setFx((fs) => fs.map((f) => (f.uid === s.id ? { ...f, posX: x, posY: y } : f)));
    } else if (bgRef.current) {
      const p = panRef.current; // grab 式：拖右→看左側（ox 減）
      setCrop((c) => ({ ...c, x: clamp01(p.ox - (e.clientX - p.x) / r.width), y: clamp01(p.oy - (e.clientY - p.y) / r.height) }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => { dragRef.current = false; try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {} };

  const addText = () => { const t = defaultCoverText(genCoverTextId()); setTexts((ts) => [...ts, t]); setSel({ kind: "text", id: t.id }); };
  const patchText = (id: string, p: Partial<CoverText>) => setTexts((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const removeText = (id: string) => { setTexts((ts) => ts.filter((t) => t.id !== id)); setSel((s) => (s?.kind === "text" && s.id === id ? null : s)); };

  // 疊圖：上傳其他圖疊上去（logo/裝飾/黑底特效素材），可拖曳移位、混合模式去背
  const onUploadOverlay = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ov: EditorOverlay = { ...defaultCoverImage(genCoverImageId()), img, name: file.name, url };
      setOverlays((os) => [...os, ov]);
      setSel({ kind: "img", id: ov.id });
    };
    img.onerror = () => { URL.revokeObjectURL(url); setMsg("疊圖載入失敗，換一張試試"); };
    img.src = url;
  };
  const patchOverlay = (id: string, p: Partial<CoverImage>) => setOverlays((os) => os.map((o) => (o.id === id ? { ...o, ...p } : o)));
  const removeOverlay = (id: string) => {
    setOverlays((os) => { const o = os.find((x) => x.id === id); if (o) URL.revokeObjectURL(o.url); return os.filter((x) => x.id !== id); });
    setSel((s) => (s?.kind === "img" && s.id === id ? null : s));
  };
  const moveOverlay = (i: number, d: -1 | 1) => setOverlays((os) => { const j = i + d; if (j < 0 || j >= os.length) return os; const n = [...os]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const addFx = (fxId: string) => { const f = defaultCoverFx(genCoverFxId(), fxId); setFx((fs) => [...fs, f]); setSel({ kind: "fx", id: f.uid }); setShowFxMenu(false); };
  const patchFx = (uid: string, p: Partial<CoverFx>) => setFx((fs) => fs.map((f) => (f.uid === uid ? { ...f, ...p } : f)));
  const removeFx = (uid: string) => { setFx((fs) => fs.filter((f) => f.uid !== uid)); setSel((s) => (s?.kind === "fx" && s.id === uid ? null : s)); };
  const moveFx = (i: number, d: -1 | 1) => setFx((fs) => { const j = i + d; if (j < 0 || j >= fs.length) return fs; const n = [...fs]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const doExport = async () => {
    setExporting(true); setMsg("渲染中…");
    try {
      if (typeof document !== "undefined" && "fonts" in document) await (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready;
      let { w, h } = coverDims(ratio, resTier);
      if (Math.max(w, h) > maxTex) {
        const k = maxTex / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k);
        setMsg(`此裝置紋理上限 ${maxTex}px，已自動降到 ${w}×${h}`);
      }
      const out = document.createElement("canvas"); out.width = w; out.height = h;
      const ctx = out.getContext("2d"); if (!ctx) throw new Error("無法建立畫布");
      const calls = fxCalls();
      let tmp: BgFx | null = null;
      if (bgImg && calls.length) tmp = new BgFx(document.createElement("canvas"));
      renderCover(ctx, { W: w, H: h, bgImg, bgColor: "#0a0809", texts, fx: calls, fxEngine: tmp, crop, overlays: overlays.map((o) => ({ ci: o, img: o.img })) });
      tmp?.destroy();
      await new Promise<void>((res) => out.toBlob((blob) => {
        if (!blob) { setMsg("匯出失敗（圖太大或記憶體不足，降低畫質再試）"); res(); return; }
        const u = URL.createObjectURL(blob); const a = document.createElement("a");
        a.href = u; a.download = `cover_${ratio.replace(":", "x")}_${w}x${h}.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 5000);
        setMsg(`已輸出 ${w}×${h} PNG`); res();
      }, "image/png"));
    } catch (err) { setMsg("匯出錯誤：" + (err as Error).message); }
    setExporting(false);
  };

  if (!open) return null;

  const selText = sel?.kind === "text" ? texts.find((t) => t.id === sel.id) : null;
  const selFx = sel?.kind === "fx" ? fx.find((f) => f.uid === sel.id) : null;
  const dims = coverDims(ratio, resTier);

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-[1180px] max-h-[92vh] bg-[#0d0b0c] border border-white/12 rounded-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10">
          <ImageIcon size={15} className="text-white/60" />
          <span className="text-[13px] tracking-[0.2em] text-white/85">封面製作</span>
          <span className="text-[10px] text-white/30 border border-white/12 rounded-full px-2 py-0.5">最高 {COVER_RES.find((r) => r.id === resTier)?.label} · {dims.w}×{dims.h}</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="text-white/45 hover:text-white p-1"><X size={16} /></button>
        </div>

        <div className="flex flex-col lg:flex-row gap-3 p-3 min-h-0 flex-1 overflow-hidden">
          {/* 左：控制 */}
          <div className="w-full lg:w-[360px] shrink-0 space-y-3 overflow-y-auto pr-1">
            {/* 底圖 */}
            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <p className="text-[11px] text-white/45 tracking-wider">底圖</p>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
              {!bgImg ? (
                <div className="rounded-lg border border-dashed border-white/15 hover:border-white/35 p-5 text-center cursor-pointer transition"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onUpload(f); }}>
                  <Upload size={18} className="mx-auto text-white/35 mb-1" />
                  <p className="text-white/45 text-[12px]">拖一張圖進來，或點此上傳</p>
                </div>
              ) : (<>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/55 truncate flex-1">{bgName}</span>
                  <button type="button" className={BTN} onClick={() => fileRef.current?.click()}>換圖</button>
                  <button type="button" className="text-white/35 hover:text-red-300 p-1" onClick={() => { setBgImg(null); setBgName(""); }}><Trash2 size={14} /></button>
                </div>
                {/* 裁切：縮放＋平移聚焦（什麼都沒選時也可直接在預覽上拖曳底圖） */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[10px] text-white/35">裁切（取消選取後可在預覽拖曳）</span>
                  <button type="button" className="text-[10px] text-white/45 hover:text-white" onClick={() => setCrop(defaultCoverCrop())}>重置</button>
                </div>
                <Slider label="縮放" value={crop.zoom} min={1} max={4} step={0.02} onChange={(v) => setCrop((c) => ({ ...c, zoom: v }))} fmt={(v) => `${Math.round(v * 100)}%`} />
                <div className="grid grid-cols-2 gap-2">
                  <Slider label="水平" value={crop.x} min={0} max={1} step={0.005} onChange={(v) => setCrop((c) => ({ ...c, x: v }))} fmt={(v) => `${Math.round(v * 100)}%`} />
                  <Slider label="垂直" value={crop.y} min={0} max={1} step={0.005} onChange={(v) => setCrop((c) => ({ ...c, y: v }))} fmt={(v) => `${Math.round(v * 100)}%`} />
                </div>
              </>)}
            </div>

            {/* 比例 + 畫質 */}
            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <p className="text-[11px] text-white/45 tracking-wider">比例</p>
              <div className="flex gap-1.5">
                {COVER_RATIOS.map((r) => (
                  <button key={r.id} type="button" className={`${BTN} flex-1 ${ratio === r.id ? "border-white/50 text-white" : ""}`} onClick={() => setRatio(r.id)}>{r.label}</button>
                ))}
              </div>
              <p className="text-[11px] text-white/45 tracking-wider pt-1">畫質</p>
              <div className="flex gap-1.5 flex-wrap">
                {COVER_RES.map((r) => {
                  const gated = r.min > 0 && maxTex < r.min;
                  return (
                    <button key={r.id} type="button" disabled={gated} title={gated ? `此裝置紋理上限 ${maxTex}px，不支援 8K` : ""}
                      className={`${BTN} ${resTier === r.id ? "border-white/50 text-white" : ""}`} onClick={() => setResTier(r.id)}>{r.label}</button>
                  );
                })}
              </div>
              <p className="text-[10px] text-white/30 leading-relaxed">文字與特效以目標解析度重繪＝邊緣銳利無損。4K 全平台安全；8K 限桌機（已偵測上限 {maxTex}px）。</p>
            </div>

            {/* 文字 */}
            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-white/45 tracking-wider">文字</p>
                <button type="button" className="text-[11px] text-white/60 hover:text-white border border-white/15 hover:border-white/40 rounded-full px-2 py-0.5 transition inline-flex items-center gap-1" onClick={addText}><Plus size={11} /> 加文字</button>
              </div>
              {texts.length === 0 && <p className="text-[10px] text-white/25">還沒有文字。加一個後在預覽上拖曳即可換位置。</p>}
              <div className="space-y-1">
                {texts.map((t) => (
                  <button key={t.id} type="button" onClick={() => setSel({ kind: "text", id: t.id })}
                    className={`w-full text-left px-2 py-1 rounded-md text-[12px] border transition ${sel?.kind === "text" && sel.id === t.id ? "border-white/40 bg-white/[0.06] text-white" : "border-white/10 text-white/55 hover:border-white/25"}`}>
                    <span className="truncate block">{t.content.split("\n")[0] || "（空白）"}</span>
                  </button>
                ))}
              </div>
              {selText && (
                <div className="space-y-2 pt-1 border-t border-white/10">
                  <textarea value={selText.content} onChange={(e) => patchText(selText.id, { content: e.target.value })} rows={2}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[13px] outline-none focus:border-white/30 resize-none" placeholder="打字…（可換行）" />
                  <div className="flex gap-2 items-center">
                    <select value={selText.fontId} onChange={(e) => patchText(selText.id, { fontId: e.target.value })}
                      className="flex-1 bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-[12px] outline-none focus:border-white/30">
                      {LYRIC_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <Swatch label="" value={selText.color} onChange={(v) => patchText(selText.id, { color: v })} />
                  </div>
                  <Slider label="字級" value={selText.sizePct} min={3} max={40} step={0.5} onChange={(v) => patchText(selText.id, { sizePct: v })} fmt={(v) => `${v}%`} />
                  <div className="grid grid-cols-2 gap-2">
                    <Slider label="水平" value={selText.x} min={0} max={1} step={0.005} onChange={(v) => patchText(selText.id, { x: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                    <Slider label="垂直" value={selText.y} min={0} max={1} step={0.005} onChange={(v) => patchText(selText.id, { y: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                  </div>
                  <Slider label="旋轉" value={selText.rot} min={-180} max={180} step={1} onChange={(v) => patchText(selText.id, { rot: v })} fmt={(v) => `${v}°`} />
                  <div className="flex gap-1.5">
                    {(["left", "center", "right"] as const).map((a) => (
                      <button key={a} type="button" className={`${BTN} flex-1 ${selText.align === a ? "border-white/50 text-white" : ""}`} onClick={() => patchText(selText.id, { align: a })}>{a === "left" ? "靠左" : a === "center" ? "置中" : "靠右"}</button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-white/60 cursor-pointer select-none">
                    <input type="checkbox" checked={selText.strokeOn} onChange={(e) => patchText(selText.id, { strokeOn: e.target.checked })} className="accent-red-400" /> 描邊
                    {selText.strokeOn && <Swatch label="" value={selText.strokeColor} onChange={(v) => patchText(selText.id, { strokeColor: v })} />}
                  </label>
                  {selText.strokeOn && <Slider label="描邊粗細" value={selText.strokePct} min={1} max={25} step={0.5} onChange={(v) => patchText(selText.id, { strokePct: v })} fmt={(v) => `${v}%`} />}
                  <label className="flex items-center gap-2 text-[11px] text-white/60 cursor-pointer select-none">
                    <input type="checkbox" checked={selText.shadowOn} onChange={(e) => patchText(selText.id, { shadowOn: e.target.checked })} className="accent-red-400" /> 陰影
                    {selText.shadowOn && <Swatch label="" value={selText.shadowColor.startsWith("#") ? selText.shadowColor : "#000000"} onChange={(v) => patchText(selText.id, { shadowColor: v })} />}
                  </label>
                  {selText.shadowOn && <Slider label="陰影柔邊" value={selText.shadowPct} min={0} max={60} step={1} onChange={(v) => patchText(selText.id, { shadowPct: v })} fmt={(v) => `${v}%`} />}
                  <button type="button" className="text-[11px] text-white/40 hover:text-red-300 inline-flex items-center gap-1" onClick={() => removeText(selText.id)}><Trash2 size={12} /> 刪除這段文字</button>
                </div>
              )}
            </div>

            {/* 疊圖 */}
            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-white/45 tracking-wider">疊圖</p>
                <button type="button" className="text-[11px] text-white/60 hover:text-white border border-white/15 hover:border-white/40 rounded-full px-2 py-0.5 transition inline-flex items-center gap-1" onClick={() => overlayFileRef.current?.click()}><Plus size={11} /> 疊圖</button>
              </div>
              <input ref={overlayFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadOverlay(f); e.target.value = ""; }} />
              {overlays.length === 0 && <p className="text-[10px] text-white/25">把 logo／裝飾／素材疊上去。加一張後在預覽上拖曳換位置；黑底素材選「濾色」去背、白底黑稿選「色彩增值」。</p>}
              <div className="space-y-1">
                {overlays.map((o, i) => (
                  <div key={o.id} className={`rounded-md border px-2 py-1 transition ${sel?.kind === "img" && sel.id === o.id ? "border-white/40 bg-white/[0.06]" : "border-white/10"}`}>
                    <div className="flex items-center gap-1">
                      <button type="button" className="flex-1 text-left text-[12px] text-white/70 truncate" onClick={() => setSel({ kind: "img", id: o.id })}>{o.name}</button>
                      <button type="button" className="text-white/35 hover:text-white p-0.5 disabled:opacity-25" disabled={i === 0} onClick={() => moveOverlay(i, -1)}><ChevronUp size={12} /></button>
                      <button type="button" className="text-white/35 hover:text-white p-0.5 disabled:opacity-25" disabled={i === overlays.length - 1} onClick={() => moveOverlay(i, 1)}><ChevronDown size={12} /></button>
                      <button type="button" className="text-white/35 hover:text-red-300 p-0.5" onClick={() => removeOverlay(o.id)}><Trash2 size={12} /></button>
                    </div>
                    {sel?.kind === "img" && sel.id === o.id && (
                      <div className="space-y-1.5 pt-1">
                        <div>
                          <label className="text-[10px] text-white/45 block mb-0.5">混合模式（去背）</label>
                          <div className="flex gap-1">
                            {COVER_BLENDS.map((b) => (
                              <button key={b.id} type="button" className={`${BTN} flex-1 ${o.blend === b.id ? "border-white/50 text-white" : ""}`} onClick={() => patchOverlay(o.id, { blend: b.id })}>{b.label.split("（")[0]}</button>
                            ))}
                          </div>
                          {o.blend !== "normal" && <p className="text-[10px] text-white/30 pt-0.5">{COVER_BLENDS.find((b) => b.id === o.blend)?.label}</p>}
                        </div>
                        <Slider label="大小" value={o.scalePct} min={5} max={140} step={1} onChange={(v) => patchOverlay(o.id, { scalePct: v })} fmt={(v) => `${v}%`} />
                        <div className="grid grid-cols-2 gap-2">
                          <Slider label="水平" value={o.x} min={0} max={1} step={0.005} onChange={(v) => patchOverlay(o.id, { x: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                          <Slider label="垂直" value={o.y} min={0} max={1} step={0.005} onChange={(v) => patchOverlay(o.id, { y: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                        </div>
                        <Slider label="旋轉" value={o.rot} min={-180} max={180} step={1} onChange={(v) => patchOverlay(o.id, { rot: v })} fmt={(v) => `${v}°`} />
                        <Slider label="不透明度" value={o.opacity} min={0} max={1} step={0.01} onChange={(v) => patchOverlay(o.id, { opacity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 美化特效 */}
            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-white/45 tracking-wider">美化特效</p>
                <button type="button" className="text-[11px] text-white/60 hover:text-white border border-white/15 hover:border-white/40 rounded-full px-2 py-0.5 transition inline-flex items-center gap-1" onClick={() => setShowFxMenu((v) => !v)} disabled={!bgImg}><Plus size={11} /> 加特效</button>
              </div>
              {!bgImg && <p className="text-[10px] text-white/25">先上傳底圖才能套特效。</p>}
              {showFxMenu && bgImg && (
                <div className="grid grid-cols-2 gap-1.5 bg-black/30 rounded-lg p-2">
                  {COVER_FX_MENU.map((m) => (
                    <button key={m.id} type="button" className="text-left text-[11px] text-white/65 hover:text-white border border-white/10 hover:border-red-400/50 rounded-md px-2 py-1.5 transition" onClick={() => addFx(m.id)}>
                      {m.name}{m.hasFocus && <span className="text-white/30"> ·可拖曳聚焦</span>}
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-1">
                {fx.map((f, i) => (
                  <div key={f.uid} className={`rounded-md border px-2 py-1 transition ${sel?.kind === "fx" && sel.id === f.uid ? "border-white/40 bg-white/[0.06]" : "border-white/10"}`}>
                    <div className="flex items-center gap-1">
                      <button type="button" className="flex-1 text-left text-[12px] text-white/70" onClick={() => setSel({ kind: "fx", id: f.uid })}>{coverFxName(f.fx)}</button>
                      <button type="button" className="text-white/35 hover:text-white p-0.5 disabled:opacity-25" disabled={i === 0} onClick={() => moveFx(i, -1)}><ChevronUp size={12} /></button>
                      <button type="button" className="text-white/35 hover:text-white p-0.5 disabled:opacity-25" disabled={i === fx.length - 1} onClick={() => moveFx(i, 1)}><ChevronDown size={12} /></button>
                      <button type="button" className="text-white/35 hover:text-red-300 p-0.5" onClick={() => removeFx(f.uid)}><Trash2 size={12} /></button>
                    </div>
                    {sel?.kind === "fx" && sel.id === f.uid && (
                      <div className="space-y-1.5 pt-1">
                        <Slider label="強度" value={f.amount} min={0} max={1} step={0.01} onChange={(v) => patchFx(f.uid, { amount: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                        {f.fx === "crossglass" && (<>
                          <p className="text-[10px] text-white/30">玻璃帶內＝清晰聚焦、帶外＝模糊/黑白。在右邊預覽上直接拖曳即可移動交叉中心。</p>
                          <div className="grid grid-cols-2 gap-2">
                            <Slider label="水平" value={f.posX ?? 0.5} min={0} max={1} step={0.005} onChange={(v) => patchFx(f.uid, { posX: v })} fmt={(v) => `${Math.round((v ?? 0.5) * 100)}%`} />
                            <Slider label="垂直" value={f.posY ?? 0.5} min={0} max={1} step={0.005} onChange={(v) => patchFx(f.uid, { posY: v })} fmt={(v) => `${Math.round((v ?? 0.5) * 100)}%`} />
                          </div>
                          <Slider label="大小" value={f.scale ?? 1} min={0.3} max={3} step={0.05} onChange={(v) => patchFx(f.uid, { scale: v })} fmt={(v) => `${Math.round((v ?? 1) * 100)}%`} />
                          <div className="grid grid-cols-2 gap-2">
                            <Slider label="線一角度" value={f.angle ?? 45} min={0} max={180} step={1} onChange={(v) => patchFx(f.uid, { angle: v })} fmt={(v) => `${v ?? 45}°`} />
                            <Slider label="線二角度" value={f.angle2 ?? 135} min={0} max={180} step={1} onChange={(v) => patchFx(f.uid, { angle2: v })} fmt={(v) => `${v ?? 135}°`} />
                          </div>
                          <Slider label="外圈模糊" value={f.speed ?? 0.55} min={0} max={1} step={0.01} onChange={(v) => patchFx(f.uid, { speed: v })} fmt={(v) => `${Math.round((v ?? 0.55) * 100)}%`} />
                          <Slider label="外圈黑白" value={f.density ?? 0.35} min={0} max={1} step={0.01} onChange={(v) => patchFx(f.uid, { density: v })} fmt={(v) => `${Math.round((v ?? 0.35) * 100)}%`} />
                          <Swatch label="外框色" value={f.colorA ?? "#ffffff"} onChange={(v) => patchFx(f.uid, { colorA: v })} />
                        </>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 右：預覽 + 匯出 */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40 rounded-xl overflow-hidden p-2">
              <canvas ref={previewRef}
                className="max-w-full max-h-full rounded-lg touch-none cursor-move"
                style={{ aspectRatio: ratio === "16:9" ? "16/9" : ratio === "9:16" ? "9/16" : "1/1" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </div>
            <div className="flex items-center gap-2">
              <p className="text-[10px] text-white/35 flex-1 truncate">{msg}</p>
              <button type="button" disabled={exporting} className={`${BTN} border-amber-200/45 text-amber-100 inline-flex items-center gap-1`} onClick={doExport}>
                <Download size={13} /> {exporting ? "渲染中…" : `輸出 PNG（${dims.w}×${dims.h}）`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
