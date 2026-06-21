// 九墨自訂 preset（vizzy 的 💾）— 把調好的效果參數快照存進 localStorage，
// 在右欄縮圖牆「我的 preset」一格一格列出，點即套用。presets 很小、用 localStorage 即可（同步、簡單）。

import type { ParamValues } from "./effects";
import type { Palette, PaperMode } from "./palette";

export type EffectPreset = {
  id: string;
  name: string;
  kind: "ink" | "visual"; // 墨韻 or 貓神視效
  effectId: string; //       ink effectId 或 visual id
  params: ParamValues; //    當前感應/墨效參數快照
  palette: Palette; //       三槽墨色快照
  paperMode: PaperMode; //   紙色快照
};

const KEY = "jiumo:effect-presets";

export function listPresets(): EffectPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as EffectPreset[]) : [];
  } catch {
    return [];
  }
}

function persist(all: EffectPreset[]) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota / private mode */ }
}

export function addPreset(p: EffectPreset): EffectPreset[] {
  const all = [p, ...listPresets()];
  persist(all);
  return all;
}

export function deletePreset(id: string): EffectPreset[] {
  const all = listPresets().filter((x) => x.id !== id);
  persist(all);
  return all;
}

export function genPresetId(): string {
  return `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}
