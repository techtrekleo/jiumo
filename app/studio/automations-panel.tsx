"use client";

import { Plus, X, Diamond, Music2 } from "lucide-react";
import type {
  Layer, Automation, AudioBinding, AudioSource, Easing, EffectParams, BackgroundParams, BgFilter,
} from "../engine/composition";
import { genAutomationId } from "../engine/composition";
import { BG_EFFECTS } from "../engine/bg-fx";

const BG_FX_NAME: Record<string, string> = Object.fromEntries(BG_EFFECTS.map((e) => [e.id, e.name]));
const EASE_OPTS: { id: Easing; label: string }[] = [
  { id: "linear", label: "等速" }, { id: "in", label: "漸快" }, { id: "out", label: "漸慢" }, { id: "inout", label: "平滑" },
];
const SOURCE_OPTS: { id: AudioSource; label: string }[] = [
  { id: "bass", label: "低音" }, { id: "mid", label: "中音" }, { id: "treble", label: "高音" }, { id: "beat", label: "節拍" }, { id: "level", label: "音量" },
];
const SRC_NAME: Record<AudioSource, string> = Object.fromEntries(SOURCE_OPTS.map((o) => [o.id, o.label])) as Record<AudioSource, string>;

type Target = { target: string; label: string; min: number; max: number; step: number; value: number };

// 一個圖層「可以做動畫」的參數清單（含目前 base 值、滑桿範圍）
function targetsOf(layer: Layer): Target[] {
  const out: Target[] = [];
  const tf = layer.transform;
  if (tf) {
    out.push({ target: "x", label: "水平", min: 0, max: 1, step: 0.01, value: tf.x });
    out.push({ target: "y", label: "垂直", min: 0, max: 1, step: 0.01, value: tf.y });
    out.push({ target: "scale", label: "大小", min: 0.02, max: 2, step: 0.01, value: tf.scale });
  }
  if (layer.type === "effect") {
    const ep = layer.params as EffectParams;
    out.push({ target: "value:sens", label: "敏感度", min: 0, max: 3, step: 0.01, value: (ep.values.sens as number) ?? 1 });
    if (ep.gpuId != null) {
      out.push({ target: "value:bloom", label: "泛光", min: 0, max: 3, step: 0.01, value: (ep.values.bloom as number) ?? 1.35 });
      out.push({ target: "value:gain", label: "亮度", min: 0, max: 3, step: 0.01, value: (ep.values.gain as number) ?? 1 });
    }
  }
  if (layer.type === "background") {
    for (const f of (layer.params as BackgroundParams).filters ?? []) {
      out.push({ target: `filter:${f.id}`, label: `濾鏡：${BG_FX_NAME[f.fx] ?? f.fx}`, min: 0, max: 1, step: 0.01, value: f.amount });
    }
  }
  if (layer.type === "image" || layer.type === "seal") {
    out.push({ target: "opacity", label: "不透明度", min: 0, max: 1, step: 0.01, value: (layer.params as { opacity: number }).opacity });
  }
  return out;
}

// 「跟音樂」綁定的合理預設（安靜值→最大聲值、來源、靈敏度），依參數型別給
function defaultBinding(tg: Target): { source: AudioSource; min: number; max: number; gain: number } {
  if (tg.target === "opacity") return { source: "level", min: 0.35, max: 1, gain: 1.2 };
  if (tg.target === "scale") return { source: "beat", min: tg.value, max: Math.min(tg.max, tg.value + 0.3), gain: 1 };
  if (tg.target === "x" || tg.target === "y") return { source: "beat", min: tg.value, max: tg.value + 0.05, gain: 1 };
  if (tg.target.startsWith("filter:")) return { source: "level", min: 0, max: 1, gain: 1.2 };
  return { source: "level", min: tg.value, max: Math.min(tg.max, tg.value + 1), gain: 1.2 }; // value:sens/bloom/gain
}

const fmtT = (t: number) => `${t.toFixed(1)}s`;

export function AutomationsPanel({ layer, getTime, onChange, onBind }: {
  layer: Layer | null;
  getTime: () => number;
  onChange: (id: string, automations: Automation[]) => void;
  onBind: (id: string, bindings: AudioBinding[]) => void;
}) {
  if (!layer) {
    return <p className="text-[10px] text-white/35 leading-relaxed">點左邊圖層樹選一層，這裡會列出它可以動畫／跟音樂的參數。</p>;
  }
  const targets = targetsOf(layer);
  const autos = layer.automations ?? [];
  const binds = layer.audioBindings ?? [];
  const byTarget = (t: string) => autos.find((a) => a.target === t);
  const bindOf = (t: string) => binds.find((b) => b.target === t);

  const writeAutos = (next: Automation[]) => onChange(layer.id, next);
  const writeBinds = (next: AudioBinding[]) => onBind(layer.id, next);

  // 關鍵影格：在目前時間加一格（捕捉該參數目前的 base 值）
  const addKey = (tg: Target) => {
    const t = Math.round(getTime() * 10) / 10;
    const existing = byTarget(tg.target);
    const key = { t, v: tg.value, ease: "linear" as Easing };
    if (existing) {
      const keys = existing.keys.filter((k) => Math.abs(k.t - t) > 0.05).concat(key).sort((a, b) => a.t - b.t);
      writeAutos(autos.map((a) => (a.target === tg.target ? { ...a, keys } : a)));
    } else {
      writeAutos([...autos, { id: genAutomationId(), target: tg.target, keys: [key] }]);
    }
  };
  const patchKey = (target: string, idx: number, patch: Partial<{ t: number; v: number; ease: Easing }>) => {
    writeAutos(autos.map((a) => {
      if (a.target !== target) return a;
      const keys = a.keys.map((k, i) => (i === idx ? { ...k, ...patch } : k)).sort((x, y) => x.t - y.t);
      return { ...a, keys };
    }));
  };
  const removeKey = (target: string, idx: number) => {
    writeAutos(autos.map((a) => (a.target === target ? { ...a, keys: a.keys.filter((_, i) => i !== idx) } : a)).filter((a) => a.keys.length > 0));
  };

  // 音訊驅動：加一條綁定（已有就不重複）
  const addBind = (tg: Target) => {
    if (bindOf(tg.target)) return;
    writeBinds([...binds, { id: genAutomationId(), target: tg.target, ...defaultBinding(tg) }]);
  };
  const patchBind = (target: string, patch: Partial<AudioBinding>) => {
    writeBinds(binds.map((b) => (b.target === target ? { ...b, ...patch } : b)));
  };
  const removeBind = (target: string) => writeBinds(binds.filter((b) => b.target !== target));

  return (
    <div className="space-y-2.5">
      <p className="text-[10px] text-white/35 leading-relaxed">
        <b className="text-white/55">加格</b>＝照時間軸做動畫（淡入、滑進）。<b className="text-white/55">跟音樂</b>＝參數隨低音/節拍/音量即時脈動（Logo 隨鼓點放大、副歌變亮）。
      </p>
      {targets.length === 0 ? (
        <p className="text-[10px] text-white/30">這層沒有可動畫的參數（背景需先加濾鏡）。</p>
      ) : (
        targets.map((tg) => {
          const a = byTarget(tg.target);
          const bd = bindOf(tg.target);
          return (
            <div key={tg.target} className="bg-black/25 rounded-lg px-2 py-1.5 space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] text-white/70">{tg.label}</span>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-white/35">目前 {tg.value.toFixed(2)}</span>
                  <button type="button" onClick={() => addKey(tg)}
                    className="flex items-center gap-0.5 text-[10px] text-white/65 hover:text-white border border-white/15 hover:border-red-400/60 rounded px-1.5 py-0.5 transition">
                    <Plus size={11} /> 加格
                  </button>
                  <button type="button" onClick={() => addBind(tg)} disabled={!!bd}
                    className="flex items-center gap-0.5 text-[10px] text-white/65 hover:text-white border border-white/15 hover:border-red-400/60 rounded px-1.5 py-0.5 transition disabled:opacity-30 disabled:hover:border-white/15">
                    <Music2 size={11} /> 跟音樂
                  </button>
                </div>
              </div>

              {/* 關鍵影格清單 */}
              {a && a.keys.length > 0 && (
                <div className="space-y-1 pt-0.5">
                  {a.keys.map((k, i) => (
                    <div key={i} className="flex items-center gap-1 text-[10px]">
                      <Diamond size={10} className="text-red-400/70 shrink-0" />
                      <input type="number" step={0.1} value={k.t}
                        onChange={(e) => patchKey(tg.target, i, { t: Math.max(0, parseFloat(e.target.value) || 0) })}
                        className="w-12 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/70 outline-none focus:border-white/30" />
                      <span className="text-white/25">s</span>
                      <input type="number" step={tg.step} value={k.v}
                        onChange={(e) => patchKey(tg.target, i, { v: parseFloat(e.target.value) || 0 })}
                        className="w-14 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/70 outline-none focus:border-white/30" />
                      <select value={k.ease} onChange={(e) => patchKey(tg.target, i, { ease: e.target.value as Easing })}
                        className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/55 outline-none focus:border-white/30">
                        {EASE_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                      <button type="button" onClick={() => removeKey(tg.target, i)} className="text-white/40 hover:text-red-300 shrink-0"><X size={12} /></button>
                    </div>
                  ))}
                  <p className="text-[9px] text-white/25">{a.keys.length} 格 · {fmtT(a.keys[0].t)}→{fmtT(a.keys[a.keys.length - 1].t)}</p>
                </div>
              )}

              {/* 音訊驅動綁定 */}
              {bd && (
                <div className="space-y-1 pt-0.5 border-t border-white/5">
                  <div className="flex items-center gap-1 text-[10px]">
                    <Music2 size={11} className="text-red-400/70 shrink-0" />
                    <select value={bd.source} onChange={(e) => patchBind(tg.target, { source: e.target.value as AudioSource })}
                      className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/70 outline-none focus:border-white/30">
                      {SOURCE_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <span className="flex-1" />
                    <button type="button" onClick={() => removeBind(tg.target)} className="text-white/40 hover:text-red-300 shrink-0"><X size={12} /></button>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-white/40">
                    <span>安靜</span>
                    <input type="number" step={tg.step} value={bd.min}
                      onChange={(e) => patchBind(tg.target, { min: parseFloat(e.target.value) || 0 })}
                      className="w-12 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/70 outline-none focus:border-white/30" />
                    <span>最大聲</span>
                    <input type="number" step={tg.step} value={bd.max}
                      onChange={(e) => patchBind(tg.target, { max: parseFloat(e.target.value) || 0 })}
                      className="w-12 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/70 outline-none focus:border-white/30" />
                    <span>靈敏</span>
                    <input type="number" step={0.1} min={0.1} value={bd.gain}
                      onChange={(e) => patchBind(tg.target, { gain: Math.max(0.1, parseFloat(e.target.value) || 1) })}
                      className="w-12 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white/70 outline-none focus:border-white/30" />
                  </div>
                  <p className="text-[9px] text-white/25">跟著{SRC_NAME[bd.source]}：安靜 {bd.min} → 最大聲 {bd.max}</p>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
