"use client";

import { useEffect, useMemo, useRef } from "react";
import { Save, X } from "lucide-react";
import { GPU_EFFECTS, GPU_CATEGORIES, renderGpuThumb, type GpuEffect } from "../engine/gpu-visuals";
import type { InkEffect } from "../engine/effects";
import type { Palette } from "../engine/palette";
import type { EffectPreset } from "../engine/preset-store";

/* 九墨右欄效果縮圖牆（vizzy 風）：墨韻家族 + 貓神視效分類（基礎/進階/實驗/特殊/控制卡）。
   點選即套用，選中高亮。劃分清楚再各自做細部調整。 */

type Props = {
  inkEffects: readonly InkEffect[];
  inkSelectedId: string;
  visualSelectedId: string | null; // 非 null = 載入的舊專案帶 2D 視效（2D 已退役，只影響墨韻高亮）
  gpuSelectedId: string | null; // null = 沒選 GPU 光效
  palette: Palette;
  onSelectInk: (id: string) => void;
  onSelectGpu: (id: string) => void;
  presets: EffectPreset[];
  onSavePreset: () => void;
  onApplyPreset: (p: EffectPreset) => void;
  onDeletePreset: (id: string) => void;
};

// GPU 光效縮圖：用共用離屏 WebGL2 引擎渲染單幀（合成頻譜）
function GpuThumb({ effect, palette }: { effect: GpuEffect; palette: Palette }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    renderGpuThumb(effect.id, c, palette);
  }, [effect, palette]);
  return <canvas ref={ref} width={132} height={56} className="w-full block bg-[#0a0809]" />;
}

function GpuTile({ effect, palette, active, onClick }: { effect: GpuEffect; palette: Palette; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-lg border overflow-hidden transition cursor-pointer ${active ? "border-amber-200/70 ring-1 ring-amber-200/40" : "border-white/12 hover:border-white/35"}`}>
      <GpuThumb effect={effect} palette={palette} />
      <div className={`text-[10px] py-1 text-center truncate ${active ? "text-amber-100 bg-amber-200/[0.08]" : "text-white/55"}`}>{effect.name}</div>
    </button>
  );
}

function Tile({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`rounded-lg border px-1.5 py-2 text-[11px] leading-tight text-center transition cursor-pointer truncate
        ${active ? "border-white/55 bg-white/[0.08] text-white" : "border-white/12 bg-white/[0.02] text-white/60 hover:border-white/35 hover:text-white/90"}`}
    >
      {label}
    </button>
  );
}

export function EffectPicker({ inkEffects, inkSelectedId, visualSelectedId, gpuSelectedId, palette, onSelectInk, onSelectGpu, presets, onSavePreset, onApplyPreset, onDeletePreset }: Props) {
  const gpuById = useMemo(() => {
    const m = new Map<string, GpuEffect>();
    for (const g of GPU_EFFECTS) m.set(g.id, g);
    return m;
  }, []);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-white/40 tracking-wider">我的 preset</p>
          <button type="button" onClick={onSavePreset} title="把目前效果與參數存成一格"
            className="flex items-center gap-1 text-[10px] text-amber-100/90 border border-amber-200/30 rounded-full px-2 py-0.5 hover:border-amber-200/60 transition">
            <Save size={11} /> 存目前
          </button>
        </div>
        {presets.length === 0 ? (
          <p className="text-[10px] text-white/25 leading-relaxed">調好參數按「存目前」，會存成一格放這裡（含墨色/紙色）</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {presets.map((p) => (
              <div key={p.id} className="relative group">
                <button type="button" onClick={() => onApplyPreset(p)}
                  className="w-full rounded-lg border border-white/12 bg-white/[0.02] text-white/65 hover:border-white/35 hover:text-white/90 px-1.5 py-2 text-[11px] truncate transition cursor-pointer">
                  {p.name}
                </button>
                <button type="button" onClick={() => onDeletePreset(p.id)} title="刪除"
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#15110f] border border-white/20 text-white/40 hover:text-red-300 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] text-white/40 tracking-wider">墨韻（自研流體）</p>
        <div className="grid grid-cols-3 gap-1.5">
          {inkEffects.map((e) => (
            <Tile key={e.id} label={e.name} active={visualSelectedId === null && gpuSelectedId === null && inkSelectedId === e.id} onClick={() => onSelectInk(e.id)} />
          ))}
        </div>
      </div>

      <p className="text-[11px] tracking-wider text-amber-200/70 pt-0.5">✦ 光效 · 泛光</p>
      {GPU_CATEGORIES.map((cat) => (
        <div key={cat.name} className="space-y-1.5">
          <p className="text-[10px] text-white/35 tracking-wider pl-0.5">{cat.name}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {cat.ids.filter((id) => gpuById.has(id)).map((id) => (
              <GpuTile key={id} effect={gpuById.get(id)!} palette={palette} active={gpuSelectedId === id} onClick={() => onSelectGpu(id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
