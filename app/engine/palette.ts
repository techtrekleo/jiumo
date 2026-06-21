// 九墨墨色系統：用戶選 hex、引擎換算成宣紙吸收係數或夜紙發光色
// 三槽制：primary 主色（多數滴墨）/ secondary 輔色 / accent 對比色（高低音突發插色）

export type PaperMode = "xuan" | "night"; // 宣紙（吸收模型）/ 夜紙（加法發光）

export type Palette = {
  name: string;
  primary: string;
  secondary: string;
  accent: string;
};

export const PRESET_PALETTES: Palette[] = [
  { name: "九黎月", primary: "#26221f", secondary: "#c0392b", accent: "#d4a64a" },
  { name: "古風青綠", primary: "#1d3a34", secondary: "#3e6e5c", accent: "#c8a23c" },
  { name: "暗黑緋紅", primary: "#1a1418", secondary: "#8e1f2f", accent: "#d8c8b8" },
  { name: "雪月銀藍", primary: "#27303f", secondary: "#4a6c9b", accent: "#b8c8d8" },
];

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

// 自動變色：沿 PRESET_PALETTES 平滑循環（每個配色停 secsPer 秒、之間線性插值）→ 墨色一直流動換色。
//   用「音檔播放時間」當輸入 → 預覽與匯出在同一秒是同一色。
function lerpHexColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const c2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${c2(ca[0] + (cb[0] - ca[0]) * t)}${c2(ca[1] + (cb[1] - ca[1]) * t)}${c2(ca[2] + (cb[2] - ca[2]) * t)}`;
}
export function autoPalette(tSec: number, secsPer = 5): Palette {
  const n = PRESET_PALETTES.length;
  const f = (((tSec / secsPer) % n) + n) % n;
  const i = Math.floor(f), frac = f - i;
  const a = PRESET_PALETTES[i], b = PRESET_PALETTES[(i + 1) % n];
  return {
    name: "自動變色",
    primary: lerpHexColor(a.primary, b.primary, frac),
    secondary: lerpHexColor(a.secondary, b.secondary, frac),
    accent: lerpHexColor(a.accent, b.accent, frac),
  };
}

// 宣紙模式：墨 = 吸收。absorb = 1 - rgb、加最低可見度保底（太淡的色在紙上看不見）
// 夜紙模式：墨 = 發光。直接用 rgb、加亮度保底
export function toInk(hex: string, mode: PaperMode): RGB {
  const rgb = hexToRgb(hex);
  if (mode === "xuan") {
    const absorb = rgb.map((v) => 1 - v) as RGB;
    const maxA = Math.max(...absorb);
    if (maxA < 0.35) {
      const k = 0.35 / Math.max(maxA, 0.01);
      return absorb.map((v) => Math.min(v * k, 1)) as RGB;
    }
    return absorb;
  }
  const maxV = Math.max(...rgb);
  if (maxV < 0.3) {
    const k = 0.3 / Math.max(maxV, 0.01);
    return rgb.map((v) => Math.min(v * k, 1)) as RGB;
  }
  return rgb;
}

export type InkKind = "normal" | "accent";

let lastSlot = -1;
export function pickInk(palette: Palette, kind: InkKind, mode: PaperMode): RGB {
  if (kind === "accent") return toInk(palette.accent, mode);
  const slot = Math.random() < 0.5 ? 0 : 1;
  const use = slot === lastSlot ? 1 - slot : slot;
  lastSlot = use;
  return toInk(use === 0 ? palette.primary : palette.secondary, mode);
}

export const PAPER_COLORS: Record<PaperMode, RGB> = {
  xuan: [0.952, 0.925, 0.862],
  night: [0.045, 0.036, 0.034],
};
