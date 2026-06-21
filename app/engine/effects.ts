// 九墨墨效 plugins：INK-01 墨流（流體攪動）/ INK-02 墨滴（六模板噴濺）
// 每個 effect 帶 paramSchema，studio 右欄屬性面板由 schema 自動生成

import { FluidCore } from "./fluid-core";
import type { AudioFrame } from "./audio";
import type { Palette, PaperMode, RGB } from "./palette";
import { pickInk, hexToRgb } from "./palette";

export type ParamDef =
  | { key: string; label: string; type: "range"; min: number; max: number; step: number; default: number; suffix?: string }
  | { key: string; label: string; type: "toggle"; default: boolean };

export type ParamValues = Record<string, number | boolean>;

export interface InkEffect {
  id: string;
  name: string;
  paramSchema: ParamDef[];
  // 每幀：依音訊驅動滴墨/攪動，回傳 step 所需的物理參數
  update(ctx: EffectContext): { curl: number; velDissipation: number; dyeDissipation: number; diffusion: number };
}

export type EffectContext = {
  core: FluidCore;
  audio: AudioFrame;
  palette: Palette;
  paperMode: PaperMode;
  params: ParamValues;
  dt: number;
  now: number;
  lyricChanged: boolean;
};

export function defaultsOf(e: InkEffect): ParamValues {
  const out: ParamValues = {};
  for (const p of e.paramSchema) out[p.key] = p.default;
  return out;
}

// 墨色出沒區：置中偏一點點左（中心 ~0.47），右側留一線給直書歌詞；不再擠在左半邊。
const INK_ZONE = { x0: 0.12, x1: 0.82, y0: 0.12, y1: 0.88 };
const randPos = () => [
  INK_ZONE.x0 + Math.random() * (INK_ZONE.x1 - INK_ZONE.x0),
  INK_ZONE.y0 + Math.random() * (INK_ZONE.y1 - INK_ZONE.y0),
] as const;
const scale = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];
// 指定 hex 先混白(white)再轉墨 → 不死黑、露得出色相。white 0=原色 1=全白。
// xuan(宣紙)取吸收度(1-色)、night(夜紙)直接用色。
const mixWhiteHexInk = (hex: string, mode: PaperMode, white: number): RGB => {
  const c = hexToRgb(hex).map((v) => v + (1 - v) * white) as RGB; // 往白混
  return (mode === "xuan" ? c.map((v) => 1 - v) : c) as RGB;
};
const inkMixWhite = (palette: Palette, kind: "normal" | "accent", mode: PaperMode, white: number): RGB =>
  mixWhiteHexInk(kind === "accent" ? palette.accent : Math.random() < 0.5 ? palette.primary : palette.secondary, mode, white);

/* ───────────────────────── INK-02 墨滴：六模板噴濺 ───────────────────────── */

type ActiveDrop = { x: number; y: number; r: number; s: number; born: number };
const SPLAT_TYPES = ["burst", "blob", "spray", "directional", "dry", "classic"] as const;

function inkSpike(core: FluidCore, x: number, y: number, angle: number, len: number, width: number, col: RGB) {
  const aspect = core.aspect;
  for (let k = 0; k < 3; k++) {
    const t = k / 2;
    const d = len * (0.2 + t * 0.8);
    const r = width * (1 - t * 0.72) + width * 0.02;
    core.splatDye(x + (Math.cos(angle) * d) / aspect, y + Math.sin(angle) * d, scale(col, 1 - t * 0.3), r, 2.0);
  }
}

export function dropSplatter(
  core: FluidCore, strength: number, col: RGB, drops: ActiveDrop[], now: number,
  px?: number, py?: number, forceType?: (typeof SPLAT_TYPES)[number],
) {
  const [rx, ry] = randPos();
  const x = px ?? rx, y = py ?? ry;
  const aspect = core.aspect;
  const sizeJitter = 0.5 + Math.random() * 1.1;
  const bloomJitter = 0.4 + Math.random() * 0.9;
  const rCore = FluidCore.SPLAT_RADIUS * (0.55 + strength * 1.4) * sizeJitter;
  const R = Math.sqrt(rCore);
  const c = scale(col, 0.9 + strength * 0.9);
  const type = forceType || SPLAT_TYPES[Math.floor(Math.random() * SPLAT_TYPES.length)];
  const dir0 = Math.random() * Math.PI * 2;
  const ang = (spread: number) => dir0 + (Math.random() - 0.5) * spread;

  if (type === "burst") {
    core.splatDye(x, y, scale(c, 1.05), rCore * 0.6, 2.3);
    const n = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++)
      inkSpike(core, x, y, ang(Math.PI * 2), R * (0.7 + Math.random() * 1.5), rCore * (0.04 + Math.random() * 0.1), scale(c, 0.7 + Math.random() * 0.3));
    for (let i = 0; i < 5; i++) {
      const a = ang(Math.PI * 2), d = R * (1.3 + Math.random() * 1.4);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.5 + Math.random() * 0.4), rCore * (0.008 + Math.random() * 0.03), 2.0);
    }
  } else if (type === "blob") {
    const nB = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < nB; i++) {
      const a = ang(Math.PI * 1.2), d = i === 0 ? 0 : R * (0.35 + Math.random() * 0.4);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.85 + Math.random() * 0.3), rCore * (0.35 + Math.random() * 0.4), 2.5);
    }
    const nP = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nP; i++)
      inkSpike(core, x, y, ang(Math.PI * 2), R * (0.5 + Math.random() * 0.6), rCore * (0.08 + Math.random() * 0.08), scale(c, 0.75));
    for (let i = 0; i < 3; i++) {
      const a = ang(Math.PI * 2), d = R * (1.2 + Math.random() * 0.9);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.6), rCore * (0.03 + Math.random() * 0.09), 2.2);
    }
  } else if (type === "spray") {
    core.splatDye(x, y, scale(c, 1.1), rCore * 0.65, 2.5);
    const spread = Math.PI * (0.5 + Math.random() * 0.6);
    const n = 16 + Math.floor(Math.random() * 12);
    for (let i = 0; i < n; i++) {
      const a = ang(spread), d = R * (0.8 + Math.pow(Math.random(), 1.6) * 2.2);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.45 + Math.random() * 0.45), rCore * (0.006 + Math.random() * 0.025), 2.0);
    }
    inkSpike(core, x, y, ang(spread * 0.5), R * 0.9, rCore * 0.07, scale(c, 0.7));
  } else if (type === "directional") {
    const curve = (Math.random() - 0.5) * 0.9;
    const n = 5 + Math.floor(Math.random() * 4);
    const growBig = Math.random() < 0.5;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const a = dir0 + curve * t;
      const d = R * (0.3 + t * 2.4);
      const szT = growBig ? t : 1 - t;
      const sz = rCore * (0.04 + szT * 0.3) * (0.7 + Math.random() * 0.6);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.75 + Math.random() * 0.3), sz, 2.3);
      if (Math.random() < 0.5) {
        const ja = a + (Math.random() - 0.5) * 0.8;
        core.splatDye(x + (Math.cos(ja) * (d + R * 0.25)) / aspect, y + Math.sin(ja) * (d + R * 0.25), scale(c, 0.5), rCore * (0.005 + Math.random() * 0.02), 2.0);
      }
    }
  } else if (type === "dry") {
    core.splatDye(x, y, scale(c, 0.9), rCore * 0.7, 1.6);
    const n = 9 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const a = ang(Math.PI * 2), d = R * (0.5 + Math.random() * 0.6);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.4 + Math.random() * 0.5), rCore * (0.03 + Math.random() * 0.1), 2.0);
    }
  } else {
    core.splatDye(x, y, scale(c, 1.05), rCore * 0.75, 2.4);
    const nP = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < nP; i++)
      inkSpike(core, x, y, ang(Math.PI * 2), R * (0.5 + Math.random() * 0.5), rCore * (0.09 + Math.random() * 0.07), scale(c, 0.8));
    for (let i = 0; i < 3; i++) {
      const a = ang(Math.PI * 2), d = R * (1.1 + Math.random() * 1.0);
      core.splatDye(x + (Math.cos(a) * d) / aspect, y + Math.sin(a) * d, scale(c, 0.55), rCore * (0.01 + Math.random() * 0.04), 2.0);
    }
  }

  core.splatDye(x, y, scale(c, 0.06), rCore * 1.6, 1.0);
  core.radialPush(x, y, (25 + strength * 80) * bloomJitter, rCore * 1.1);
  drops.push({ x, y, r: rCore, s: strength * bloomJitter, born: now });
}

function seep(core: FluidCore, drops: ActiveDrop[], now: number, life: number) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    const age = (now - d.born) / 1000;
    if (age > Math.min(10, life * 0.7)) { drops.splice(i, 1); continue; }
    const fade = Math.exp(-age * 0.45);
    core.radialPush(d.x, d.y, (3 + d.s * 9) * fade, d.r * (1.1 + age * 0.18));
  }
}

const dropDrops: ActiveDrop[] = [];

// 滴墨強度保底：跟「試滴一墨」同範圍 0.4~0.9、每滴都是完整墨漬，音量只調大小
const baseStrength = (v: number) => 0.4 + Math.min(0.5, v * 0.6);

// 軟滴（2026-06-12 Leo 欽定）：墨流試滴同款 — 軟 gaussian 大滴 + 隨機初速拖出羽化暈染
function softDrop(core: FluidCore, strength: number, col: RGB, drops: ActiveDrop[], now: number) {
  const [x, y] = randPos();
  const r = FluidCore.SPLAT_RADIUS * (2 + strength * 5);
  core.splatDye(x, y, scale(col, 0.8), r, 1.0);
  core.splatVel(x, y, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 300, r);
  drops.push({ x, y, r, s: strength * 0.6, born: now });
}

// 連續能量驅動噴墨：依即時音量（bass/mid/treble）累積「噴墨預算」，過 1 噴一滴。
//   ⚠️ 不靠鼓點/突發偵測 → EDM 那種穩定密集能量也會持續噴墨；安靜時自然變少。
//   （原本只在 beat/spike 噴：EDM 穩定鼓點會被自身 EMA 追上 → 突發很少觸發 → 墨點稀疏）
//   base = 保底速率、peak = 上限（避免太糊）。回傳這幀要噴幾滴。
let emitAccum = 0;
function energyDrips(audio: AudioFrame, density: number, sens: number, dt: number, base: number, peak: number): number {
  const energy = audio.bass * 0.7 + audio.mid * 0.55 + audio.treble * 0.25; // ~0–1.5
  const rate = Math.min(peak, density * (base + energy * energy * 8) * (0.7 + sens * 0.4)); // 滴/秒
  emitAccum += dt * rate;
  let n = 0;
  while (emitAccum >= 1 && n < 5) { emitAccum -= 1; n++; } // 每幀最多 5 滴，防爆量
  return n;
}

export const inkDrop: InkEffect = {
  id: "ink-drop",
  name: "墨滴",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "density", label: "滴墨密度", type: "range", min: 0.4, max: 2, step: 0.1, default: 1 },
    { key: "life", label: "墨壽命", type: "range", min: 3, max: 20, step: 1, default: 8, suffix: "秒" },
    { key: "speed", label: "流速", type: "range", min: 0.2, max: 2.5, step: 0.1, default: 1, suffix: "x" },
    { key: "stir", label: "墨流攪動", type: "toggle", default: false },
  ],
  update({ core, audio, palette, paperMode, params, now, dt, lyricChanged }) {
    const stir = params.stir as boolean;
    const life = params.life as number;
    const density = (params.density as number) || 1;
    const sens = (params.sens as number) || 1;
    // 連續能量驅動：主噴墨來源（EDM 穩定能量也持續噴）
    const n = energyDrips(audio, density, sens, dt, 0.3, 9);
    for (let i = 0; i < n; i++) softDrop(core, baseStrength(audio.bass * 0.7 + 0.2), pickInk(palette, "normal", paperMode), dropDrops, now);
    // 重音：突發 → accent 插色大滴
    if (audio.bassSpike) softDrop(core, baseStrength(audio.bass * 1.5), pickInk(palette, "accent", paperMode), dropDrops, now);
    else if (audio.trebleSpike) softDrop(core, baseStrength(audio.treble), pickInk(palette, "accent", paperMode), dropDrops, now);
    if (lyricChanged) softDrop(core, 0.5, pickInk(palette, "normal", paperMode), dropDrops, now);
    seep(core, dropDrops, now, life);
    if (stir && audio.mid > 0.05) {
      stirT += 0.016 * (0.2 + audio.mid * 1.3);
      const sx = 0.3 + 0.22 * Math.sin(stirT * 0.9 + 1.7);
      const sy = 0.5 + 0.3 * Math.cos(stirT * 0.7);
      core.splatVel(sx, sy, Math.cos(stirT * 1.1) * (40 + audio.mid * 600), Math.sin(stirT * 0.8) * (40 + audio.mid * 600), FluidCore.SPLAT_RADIUS * 3.0);
    }
    return {
      curl: stir ? 18 : 12,
      velDissipation: stir ? 0.5 : 0.9,
      dyeDissipation: 6.9 / life,
      diffusion: stir ? 0.03 : 0.04,
    };
  },
};

/* ───────────────────────── INK-01 墨流：流體攪動 ───────────────────────── */

let stirT = Math.random() * 100;
const flowDrops: ActiveDrop[] = [];

export const inkFlow: InkEffect = {
  id: "ink-flow",
  name: "墨流",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "amount", label: "墨量", type: "range", min: 0.4, max: 2, step: 0.1, default: 1 },
    { key: "life", label: "墨壽命", type: "range", min: 5, max: 40, step: 1, default: 20, suffix: "秒" },
    { key: "speed", label: "流速", type: "range", min: 0.2, max: 2.5, step: 0.1, default: 1, suffix: "x" },
    { key: "swirl", label: "攪動強度", type: "range", min: 0.2, max: 2, step: 0.1, default: 1 },
  ],
  update({ core, audio, palette, paperMode, params, dt, lyricChanged }) {
    const amount = params.amount as number;
    const swirl = params.swirl as number;
    const life = params.life as number;
    const sens = (params.sens as number) || 1;
    const energy = audio.mid * 1.2;
    stirT += 0.016 * (0.25 + energy * 1.3) * swirl;
    const sx = 0.5 + 0.34 * Math.sin(stirT * 0.9 + 1.7) * Math.sin(stirT * 0.13);
    const sy = 0.5 + 0.3 * Math.cos(stirT * 0.7) * Math.sin(stirT * 0.21 + 0.5);
    if (audio.bass + audio.mid + audio.treble > 0.02) {
      core.splatVel(sx, sy, Math.cos(stirT * 1.1) * (60 + energy * 700) * swirl, Math.sin(stirT * 0.8) * (60 + energy * 700) * swirl, FluidCore.SPLAT_RADIUS * 3.2);
    }
    const drip = (strength: number, kind: "normal" | "accent") => {
      const [x, y] = randPos();
      const col = pickInk(palette, kind, paperMode);
      const r = FluidCore.SPLAT_RADIUS * (1.5 + strength * 6.0) * amount;
      core.splatDye(x, y, scale(col, 0.5 + strength * 0.8), r, 1.0);
      core.splatVel(x, y, (Math.random() - 0.5) * 280, (Math.random() - 0.5) * 280, r);
    };
    // 連續能量驅動：主噴墨來源（amount 當密度）
    const n = energyDrips(audio, amount, sens, dt, 0.3, 7);
    for (let i = 0; i < n; i++) drip(baseStrength(audio.bass * 0.6 + 0.2), "normal");
    // 重音
    if (audio.bassSpike) drip(baseStrength(audio.bass * 1.5), "accent");
    else if (audio.trebleSpike) drip(baseStrength(audio.treble), "accent");
    if (lyricChanged) drip(0.5, "normal");
    return {
      curl: 22,
      velDissipation: 0.4,
      dyeDissipation: 6.9 / life,
      diffusion: 0.03,
    };
  },
};

/* ───────────────────────── INK-03 墨暈：墨滴入水 ───────────────────────── */
// 上方滴入、向下沉降、高渦度把墨捲成翻騰細絲（參考：墨入清水的瀰漫）

// 墨暈滴墨的橫向位置：黃金比例低差異序列 → 一路鋪滿整個墨色寬度、均勻不群聚也不左右掃描。
let bloomSeq = 0;
const GOLDEN = 0.6180339887498949;
const bloomX = () => {
  bloomSeq = (bloomSeq + GOLDEN) % 1;
  return INK_ZONE.x0 + bloomSeq * (INK_ZONE.x1 - INK_ZONE.x0) + (Math.random() - 0.5) * 0.02; // 序列均勻鋪開 + 微抖避免規律感
};

export const inkBloom: InkEffect = {
  id: "ink-bloom",
  name: "墨暈",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "density", label: "滴墨密度", type: "range", min: 0.4, max: 2, step: 0.1, default: 1 },
    { key: "life", label: "墨壽命", type: "range", min: 8, max: 60, step: 1, default: 30, suffix: "秒" },
    { key: "speed", label: "流速", type: "range", min: 0.2, max: 2.5, step: 0.1, default: 1, suffix: "x" },
    { key: "sink", label: "下沉力", type: "range", min: 0.3, max: 2, step: 0.1, default: 1 },
  ],
  update({ core, audio, palette, paperMode, params, dt, lyricChanged }) {
    const life = params.life as number;
    const sink = (params.sink as number) || 1;
    const density = (params.density as number) || 1;
    const sens = (params.sens as number) || 1;
    const drip = (strength: number, kind: "normal" | "accent") => {
      const x = bloomX(); // 橫向均勻鋪滿（黃金序列）
      const y = 0.78 + Math.random() * 0.12; // 自畫面上方落下、gravity 帶它下沉暈開
      const col = pickInk(palette, kind, paperMode);
      const r = FluidCore.SPLAT_RADIUS * (0.9 + strength * 1.6);
      core.splatDye(x, y, scale(col, 0.4 + strength * 0.3), r, 1.4);
      core.splatVel(x, y, (Math.random() - 0.5) * 50, -(160 + strength * 240), r * 2.0);
    };
    const swirlPoke = () => {
      // 小渦擾動：讓既有墨絲摺疊出層次、不增加墨量
      const x = INK_ZONE.x0 + Math.random() * (INK_ZONE.x1 - INK_ZONE.x0);
      const y = 0.25 + Math.random() * 0.5;
      const a = Math.random() * Math.PI * 2;
      core.splatVel(x, y, Math.cos(a) * 130, Math.sin(a) * 130, FluidCore.SPLAT_RADIUS * 5.0);
    };
    // 連續能量驅動：主噴墨來源（EDM 穩定能量也持續入水暈染），不再靠冷卻+鼓點
    const n = energyDrips(audio, density, sens, dt, 0.35, 6);
    for (let i = 0; i < n; i++) drip(baseStrength(audio.bass * 0.6 + 0.25), "normal");
    // 重音：重低音突發 → accent 大滴；高音突發 → 小渦讓墨絲摺疊
    if (audio.bassSpike) drip(baseStrength(audio.bass * 1.5), "accent");
    else if (audio.trebleSpike) swirlPoke();
    if (lyricChanged) drip(0.5, "normal");
    return {
      curl: 26,
      velDissipation: 0.12,
      dyeDissipation: 6.9 / life,
      diffusion: 0.005,
      gravity: 85 * sink,
    };
  },
};

/* ───────────────────────── INK-04 旋墨：攪拌壇城 ─────────────────────────
   N 支攪拌臂繞中心旋轉，每段注入「切向速度」把墨拖成漩渦 → 真流體的旋轉墨壇城。
   轉速可調（0=靜止仍攪、負=反轉）。手臂尖端餵墨被甩開暈成螺旋。 */
let spinT = Math.random() * 100;
let spinKick = 0; // 重音瞬間衝刺值，每幀衰減 → 轉速忽快忽慢
const spinDrops: ActiveDrop[] = [];

export const inkSpin: InkEffect = {
  id: "ink-spin",
  name: "墨旋",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "arms", label: "攪拌臂數", type: "range", min: 2, max: 8, step: 1, default: 3 },
    { key: "spin", label: "轉速", type: "range", min: -3, max: 3, step: 0.1, default: 1.2, suffix: "x" },
    { key: "force", label: "攪拌力道", type: "range", min: 0.3, max: 2.5, step: 0.1, default: 0.5 },
    { key: "life", label: "墨壽命", type: "range", min: 5, max: 40, step: 1, default: 11, suffix: "秒" },
  ],
  update({ core, audio, palette, paperMode, params, now, dt, lyricChanged }) {
    const sens = (params.sens as number) || 1;
    const arms = Math.round((params.arms as number) || 4);
    const spinSpeed = params.spin as number;          // 可正可負（含 0=靜止）
    const force = (params.force as number) || 1;
    const life = params.life as number;
    const aspect = core.aspect;
    const energy = audio.bass * 0.6 + audio.mid * 0.6 + audio.treble * 0.3; // 0~1.5
    const cx = 0.5, cy = 0.5;
    // 轉動相位：音樂控轉速 → 安靜很慢、大聲衝很快（energy² 拉大對比）+ 重音瞬間爆衝(衰減) → 加速明顯
    spinKick *= Math.pow(0.88, dt * 60); // 換算 60fps 時間基準 → 轉速衝刺衰減不隨幀率漂移（錄製=預覽）
    if (audio.bassSpike) spinKick = 3.6;
    else if (audio.beat) spinKick = Math.max(spinKick, 2.0);
    const spinDrive = Math.min(5, 0.8 + energy * energy * 2.4 + spinKick); // 安靜~0.8×、大聲+重音爆衝可衝到 5×
    spinT += dt * spinSpeed * spinDrive;
    const sign = spinSpeed >= 0 ? 1 : -1;              // 切向順著轉向
    // 切向速度：刻意溫和（總力＝臂數×段數；太大會離心把墨甩到邊緣、掏空中央）。sens＝對音量反應強度
    const baseMag = (12 + energy * 80 * sens) * force;
    const RINGS = 2;
    // 每支手臂一個顏色：主色/輔色/對比色循環（自動變色時 palette 本身在循環 → 自動跟著換）。混一點白露色相。
    const armHex = [palette.primary, palette.secondary, palette.accent];
    // N 支攪拌臂 × 同心段：注入切向力 → 把墨拖成多臂漩渦；同時跨半徑連續餵墨(中央不餓死)
    for (let a = 0; a < arms; a++) {
      const ang = (a / arms) * Math.PI * 2 + spinT;
      const ct = Math.cos(ang), st = Math.sin(ang);
      const tx = -st * sign, ty = ct * sign;          // 切線方向
      const armCol = mixWhiteHexInk(armHex[a % 3], paperMode, 0.3);
      for (let ri = 0; ri < RINGS; ri++) {
        const rad = 0.09 + ri * 0.08;
        const x = cx + (ct * rad) / aspect, y = cy + st * rad;
        core.splatVel(x, y, tx * baseMag * (1 - ri * 0.2), ty * baseMag * (1 - ri * 0.2), FluidCore.SPLAT_RADIUS * 2.4);
      }
      // 連續餵墨：每臂中段滴自己的顏色 → 被攪成螺旋（量克制，免得塞滿；有音量才餵）
      if (energy > 0.02) {
        const x = cx + (ct * 0.13) / aspect, y = cy + st * 0.13;
        core.splatDye(x, y, scale(armCol, 0.07 + energy * 0.13), FluidCore.SPLAT_RADIUS * (1.4 + energy * 1.8), 1.2);
      }
    }
    // 重音：某手臂尖端甩出該臂顏色大滴；歌詞換行：中央補主色
    if (audio.bassSpike) {
      const ai = Math.floor(Math.random() * arms);
      const ang = (ai / arms) * Math.PI * 2 + spinT;
      const x = cx + (Math.cos(ang) * 0.19) / aspect, y = cy + Math.sin(ang) * 0.19;
      const r = FluidCore.SPLAT_RADIUS * (2.5 + baseStrength(audio.bass) * 4);
      core.splatDye(x, y, scale(mixWhiteHexInk(armHex[ai % 3], paperMode, 0.3), 0.85), r, 1.4);
      spinDrops.push({ x, y, r, s: 0.5, born: now });
    }
    if (lyricChanged) core.splatDye(cx, cy, scale(mixWhiteHexInk(armHex[0], paperMode, 0.3), 0.5), FluidCore.SPLAT_RADIUS * 2.5, 1.2);
    seep(core, spinDrops, now, life);
    return {
      curl: 11,             // 適度渦度：漩渦有細絲、不過度翻騰
      velDissipation: 0.78, // 速度衰減快 → 不會累積成離心噴射把墨甩到邊緣
      dyeDissipation: 6.9 / life,
      diffusion: 0.03,
    };
  },
};

/* ───────────────────────── INK-05 墨湧：散開版墨流 ─────────────────────────
   照墨流的物理（curl 22 / velDiss 0.4 / diffusion 0.03 / 長壽命＝填滿捲動），
   但多個攪動點散佈全畫面 + 全畫面餵墨 → 流向四散、鋪滿、有捲動漸層。
   顏色用調色盤主/輔/對比隨機（＝層次漸層；自動變色時隨時間循環）＋偶爾一點點白。 */
let surgeT = Math.random() * 100;
// 墨湧色：多半用調色盤色(主/輔/對比隨機)→ 漸層層次；偶爾(~16%)混一點點白做亮點
const surgeCol = (palette: Palette, mode: PaperMode): RGB => {
  const r = Math.random();
  const hex = r < 0.4 ? palette.primary : r < 0.72 ? palette.secondary : palette.accent;
  return mixWhiteHexInk(hex, mode, Math.random() < 0.16 ? 0.45 : 0.0);
};

export const inkSurge: InkEffect = {
  id: "ink-surge",
  name: "墨湧",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "amount", label: "墨量", type: "range", min: 0.4, max: 2, step: 0.1, default: 1.2 },
    { key: "life", label: "墨壽命", type: "range", min: 5, max: 40, step: 1, default: 18, suffix: "秒" },
    { key: "speed", label: "流速", type: "range", min: 0.2, max: 2.5, step: 0.1, default: 1, suffix: "x" },
    { key: "spread", label: "散開", type: "range", min: 0.3, max: 2, step: 0.1, default: 1.3 },
    { key: "swirl", label: "攪動強度", type: "range", min: 0.2, max: 2, step: 0.1, default: 1 },
  ],
  update({ core, audio, palette, paperMode, params, dt, lyricChanged }) {
    const sens = (params.sens as number) || 1;
    const amount = (params.amount as number) || 1;
    const life = params.life as number;
    const speed = (params.speed as number) || 1;
    const spread = (params.spread as number) || 1.3;
    const swirl = (params.swirl as number) || 1;
    const energy = audio.bass * 0.4 + audio.mid * 1.0 + audio.treble * 0.35;
    surgeT += dt * (0.25 + energy * 1.3) * speed;
    // 多個攪動點散佈全畫面 → 流向四散、捲動鋪滿（spread 控散開範圍）
    const STIRS = 5;
    for (let k = 0; k < STIRS; k++) {
      const ph = surgeT + k * 1.7;
      const sx = 0.5 + 0.46 * spread * Math.sin(ph * 0.9 + k * 2.1) * Math.cos(ph * 0.17 + k);
      const sy = 0.5 + 0.44 * spread * Math.cos(ph * 0.7 + k * 1.3) * Math.sin(ph * 0.23 + k * 0.7);
      const mag = (45 + energy * 600) * swirl;
      core.splatVel(sx, sy, Math.cos(ph * 1.1 + k) * mag, Math.sin(ph * 0.8 + k) * mag, FluidCore.SPLAT_RADIUS * 3.2);
    }
    // 全畫面餵墨（散開）→ 填滿 + 漸層；顏色用 surgeCol
    const drip = (strength: number, x: number, y: number, col: RGB) => {
      const r = FluidCore.SPLAT_RADIUS * (1.5 + strength * 6.0) * amount;
      core.splatDye(x, y, scale(col, 0.5 + strength * 0.8), r, 1.0);
      core.splatVel(x, y, (Math.random() - 0.5) * 280, (Math.random() - 0.5) * 280, r);
    };
    const fullPos = (): [number, number] => [0.04 + Math.random() * 0.92, 0.04 + Math.random() * 0.92];
    const n = energyDrips(audio, amount, sens, dt, 0.35, 8);
    for (let i = 0; i < n; i++) { const [x, y] = fullPos(); drip(baseStrength(audio.bass * 0.6 + 0.2), x, y, surgeCol(palette, paperMode)); }
    // 重音：accent 大滴；高音突發：小滴；歌詞換行：補一滴（皆散落全畫面）
    if (audio.bassSpike) { const [x, y] = fullPos(); drip(baseStrength(audio.bass * 1.5), x, y, mixWhiteHexInk(palette.accent, paperMode, 0.1)); }
    else if (audio.trebleSpike) { const [x, y] = fullPos(); drip(baseStrength(audio.treble), x, y, surgeCol(palette, paperMode)); }
    if (lyricChanged) { const [x, y] = fullPos(); drip(0.5, x, y, surgeCol(palette, paperMode)); }
    return {
      curl: 22,
      velDissipation: 0.4,
      dyeDissipation: 6.9 / life,
      diffusion: 0.03,
    };
  },
};

/* ───────────────────────── INK-06 墨太極：陰陽魚 ─────────────────────────
   毛筆陰陽魚剪影(Canvas2D 畫一次)用 imageSplat 每幀注入 → 形狀利；慢速旋轉(uRot)。
   兩眼在剪影內(白點＝挖洞、黑點＝實心)，跟著一起轉、不會錯位。
   外圈墨暈＝照墨暈引擎(inkBloom)的有機作法：隨機滴墨點＋擾動初速，高 curl/低 velDiss 讓墨自己翻騰。 */
let taijiStamp: HTMLCanvasElement | null = null; // 乾淨陰陽魚剪影（Canvas2D 畫一次）→ imageSplat 注入，形狀才利
let taijiStampCore: FluidCore | null = null;     // 已 setStamp 的 core（guard：別每幀重設、重設很貴）
let taijiRot = 0;                                 // 旋轉相位（每幀累積 → 30 秒一圈）
// 畫「毛筆質感」陰陽魚剪影：黑魚 + 乾筆飛白 + 不規則毛邊 + 提按外框；白魚/白點＝透明＝紙。
// ⚠️ 飛白靠 alpha 濃淡 → imageSplat 注入量要低（見 update），否則每幀累積會把濃淡洗成死黑。
function buildTaijiStamp(): HTMLCanvasElement {
  const S = 384, c = S / 2, R = S * 0.42;
  const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
  const x = cv.getContext("2d"); if (!x) return cv;
  let seed = 20260616; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; // 固定種子→一致
  const wob = (a: number) => 1 + Math.sin(a * 3 + 0.7) * 0.02 + Math.sin(a * 7 + 2.1) * 0.012 + Math.sin(a * 13 + 4.3) * 0.006; // 手繪不圓

  x.fillStyle = "#000"; // 黑魚（標準陰陽路徑：右半 + 上小圓凸 + 下小圓凹）
  x.beginPath();
  x.arc(c, c, R, -Math.PI / 2, Math.PI / 2, false);
  x.arc(c, c + R / 2, R / 2, Math.PI / 2, -Math.PI / 2, true);
  x.arc(c, c - R / 2, R / 2, Math.PI / 2, -Math.PI / 2, false);
  x.closePath(); x.fill();
  x.globalCompositeOperation = "destination-out"; // 白點：上小圓心挖透明洞（黑魚裡的紙白點）
  x.beginPath(); x.arc(c, c - R / 2, R * 0.15, 0, Math.PI * 2); x.fill();
  x.globalCompositeOperation = "source-over"; // 黑點：下小圓心畫黑（白魚裡）
  x.fillStyle = "#000"; x.beginPath(); x.arc(c, c + R / 2, R * 0.15, 0, Math.PI * 2); x.fill();

  // 乾筆飛白：黑墨上挖細絲（沿切向＝書法筆勢），製造乾擦質感
  x.globalCompositeOperation = "destination-out"; x.lineCap = "round"; x.strokeStyle = "#000";
  for (let i = 0; i < 460; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.7) * R * 0.98;
    const px = c + Math.cos(a) * rr, py = c + Math.sin(a) * rr;
    const dir = a + Math.PI / 2 + (rnd() - 0.5) * 1.0, len = R * (0.03 + rnd() * 0.15);
    x.globalAlpha = 0.12 + rnd() * 0.4; x.lineWidth = 0.5 + rnd() * 2.0;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(dir) * len, py + Math.sin(dir) * len); x.stroke();
  }
  // 毛邊：沿周界隨機挖小缺口 → 不規則手繪邊緣
  for (let i = 0; i < 170; i++) {
    const a = rnd() * Math.PI * 2, rw = R * wob(a);
    const px = c + Math.cos(a) * rw, py = c + Math.sin(a) * rw;
    x.globalAlpha = 0.3 + rnd() * 0.5;
    x.beginPath(); x.arc(px, py, 0.8 + rnd() * 2.8, 0, Math.PI * 2); x.fill();
  }
  x.globalAlpha = 1; x.globalCompositeOperation = "source-over";

  // 毛筆外框＝一筆書圓(enso)：黑魚側起筆粗 → 繞行 → 白魚側(左下)漸細到消失、留飛白缺口
  x.fillStyle = "#000";
  const aStart = -Math.PI * 0.55, sweep = Math.PI * 1.8, STEPS = 320;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS, a = aStart + t * sweep;
    const rw = R * wob(a);
    const taper = Math.pow(1 - t, 1.35);                       // 收筆漸細到 0
    const w = R * 0.028 * (0.85 + 0.3 * Math.sin(t * 9)) * (0.22 + taper);
    if (w < 0.5 && t > 0.55) continue;                          // 太細＝筆畫斷掉(飛白)
    if (rnd() < 0.13 * t) continue;                             // 乾筆跳墨
    x.globalAlpha = (0.55 + rnd() * 0.45) * Math.min(1, 0.3 + taper * 1.6);
    x.beginPath(); x.arc(c + Math.cos(a) * rw, c + Math.sin(a) * rw, Math.max(0.5, w), 0, Math.PI * 2); x.fill();
  }
  x.globalAlpha = 1;
  return cv;
}

export const inkTaiji: InkEffect = {
  id: "ink-taiji",
  name: "墨太極",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "size", label: "太極大小", type: "range", min: 0.15, max: 0.4, step: 0.01, default: 0.28 },
    { key: "wave", label: "外圈墨量", type: "range", min: 0, max: 2, step: 0.1, default: 1 },
    { key: "ink", label: "墨色濃度", type: "range", min: 0.4, max: 2, step: 0.1, default: 1 },
    { key: "life", label: "墨暈壽命", type: "range", min: 2, max: 8, step: 0.5, default: 5, suffix: "秒" },
  ],
  update({ core, audio, palette, paperMode, params, dt }) {
    const sens = (params.sens as number) || 1;
    const R = (params.size as number) || 0.28;
    const wave = (params.wave as number) || 0;
    const ink = (params.ink as number) || 1;
    const life = (params.life as number) || 5;
    const aspect = core.aspect;
    const sp = FluidCore.SPLAT_RADIUS;
    const cx = 0.5, cy = 0.5;
    const darkCol = mixWhiteHexInk(palette.primary, paperMode, 0.1);

    // ── 太極本體：乾淨剪影 imageSplat 每幀注入，慢速旋轉（兩眼在剪影內、跟著轉，不會錯位）──
    taijiRot += dt * (Math.PI * 2 / 30); // 30 秒一圈
    if (!taijiStamp) taijiStamp = buildTaijiStamp();
    if (taijiStampCore !== core || !core.hasStamp) { core.setStamp(taijiStamp); taijiStampCore = core; }
    core.imageSplat(cx, cy, R * 2.18, darkCol, ink * 0.32, 0, 0, 0, taijiRot); // 注入量低保飛白濃淡；rot＝旋轉
    // 白點防染黑：白點在剪影上是「洞」，旋轉時會掃過黑魚實心黑區、洞底殘留黑墨 → 每幀在白點當前(旋轉後)位置補挖白，維持可見。
    // 白點離中心 0.5R、隨 taijiRot 繞圈；x 位移除以 aspect 對齊 stamp 的旋轉（stamp 在長寬比修正空間旋轉）。
    const wdD = 0.458 * R; // 白點實際距中心：stamp 畫布 0.21×sizeH(=R·2.18) → 0.458R（非 0.5R）
    // 白點拖墨感（像黑點那樣有拖尾）：挖成「彗星」— 頭在當前旋轉位置(實心白)，尾巴往旋轉「後方」一格格淡掉＋半徑收小＋邊緣軟。
    // 旋轉方向用 -sin 對齊 stamp；尾用 taijiRot - s·δ（旋轉後方＝墨來的方向，與黑點殘留拖尾同向）。
    for (let s = 0; s < 6; s++) {
      const a = taijiRot - s * 0.075;
      const str = ink * 0.95 * Math.pow(1 - s / 6, 1.3); // 頭濃尾淡
      core.splatDye(cx - (wdD * Math.sin(a)) / aspect, cy + wdD * Math.cos(a), scale([1, 1, 1] as RGB, -str), sp * (0.8 - s * 0.07), 1.3);
    }

    // ── 外圈墨暈：完全照墨暈引擎(inkBloom)的有機作法 — 隨機滴墨點＋擾動初速，讓「高 curl + 低 velDiss」把墨自己翻騰成墨絲。
    //   差別只有「初始位置」＝灑在太極外圈環帶(隨機角度+半徑)，不是固定圈/固定點 → 不會出現幾何同心環。
    const hexes = [palette.primary, palette.secondary, palette.accent];
    const ringDrip = (strength: number, accent: boolean) => {
      const ang = Math.random() * Math.PI * 2, rb = R * (1.02 + Math.random() * 0.5); // 隨機落在外圈環帶
      const x = cx + (Math.cos(ang) * rb) / aspect, y = cy + Math.sin(ang) * rb;
      const col = mixWhiteHexInk(accent ? palette.accent : hexes[Math.floor(Math.random() * 3)], paperMode, 0.12);
      const r = sp * (1.2 + strength * 4) * ink;
      core.splatDye(x, y, scale(col, 0.14 + strength * 0.3), r, 1.2);
      core.splatVel(x, y, (Math.random() - 0.5) * 130, (Math.random() - 0.5) * 130, r * 1.8); // 擾動初速 → curl churn 成翻騰墨絲
    };
    const n = energyDrips(audio, wave, sens, dt, 0, 7); // base 0：只在有音樂時才滴（靜音＝外圈完全乾淨、無底噴）
    for (let i = 0; i < n; i++) ringDrip(baseStrength(audio.bass * 0.5 + 0.2), false);
    if (audio.bassSpike) ringDrip(baseStrength(audio.bass * 1.4), true); // 重音補一顆 accent 大滴

    // 墨暈物理（同 inkBloom）：curl 24 翻騰、velDiss 0.16 讓墨絲持續 churn、diffusion 0.005 微暈。墨壽命 life 控billow時長＋淡出。
    // 本體乾淨：curl 只在有速度處(外圈)作用、本體內部無速度→不被 churn；每幀重描＋低 diffusion → 魚身利落。
    return { curl: 24, velDissipation: 0.16, dyeDissipation: 6.9 / life, diffusion: 0.0 };
  },
};

// 重置墨韻效果的模組層級狀態（冷卻計時、累積墨滴、攪動相位）。
// ⚠️ 離線渲染前必呼叫：清掉預覽留下的累積墨滴與噴墨預算，讓匯出從乾淨狀態起算。
export function resetInkState() {
  emitAccum = 0;
  stirT = Math.random() * 100;
  spinT = Math.random() * 100;
  spinKick = 0;
  surgeT = Math.random() * 100;
  bloomSeq = 0;
  taijiRot = 0;
  dropDrops.length = 0;
  flowDrops.length = 0;
  spinDrops.length = 0;
  pomoDrops.length = 0;
}

/* ───────────────────────── INK-07 潑墨爆：重拍炸開 ─────────────────────────
   重低音突發 → 從一點潑出大墨團 + 往外爆推 + 飛濺衛星墨點 + 甩墨拖痕，再靠流體暈染擴散。
   主驅動＝bassSpike/beat（戲劇、跟重拍）；force/amount/splatter 控制力道/墨量/飛濺。 */
const pomoDrops: ActiveDrop[] = [];
function pomoSplash(core: FluidCore, strength: number, col: RGB, force: number, amount: number, splatter: number, now: number) {
  const aspect = core.aspect;
  const [x, y] = randPos();
  const R = FluidCore.SPLAT_RADIUS;
  const rCore = R * (4 + strength * 7) * amount;                   // 大墨團
  core.splatDye(x, y, scale(col, 0.92), rCore, 2.4);
  core.radialPush(x, y, (45 + strength * 150) * force, rCore * 1.3); // 爆開往外推（潑墨擴散）
  const n = Math.round((3 + strength * 7) * splatter);             // 飛濺衛星墨點
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = rCore * (1.0 + Math.random() * 2.4);
    const sx = x + (Math.cos(a) * d) / aspect, sy = y + Math.sin(a) * d;
    const sr = R * (0.4 + Math.random() * 1.8) * amount;
    core.splatDye(sx, sy, scale(col, 0.45 + Math.random() * 0.4), sr, 2.1);
    const v = (180 + strength * 480) * force;                      // 往外甩的初速
    core.splatVel(sx, sy, Math.cos(a) * v, Math.sin(a) * v, sr);
  }
  for (let i = 0; i < 3; i++) {                                    // 甩墨拖痕（從中心射速度拖成飛白條）
    const a = Math.random() * Math.PI * 2;
    const v = (260 + strength * 560) * force;
    core.splatVel(x, y, Math.cos(a) * v, Math.sin(a) * v, rCore * 0.7);
  }
  pomoDrops.push({ x, y, r: rCore, s: strength, born: now });
}

export const inkPomo: InkEffect = {
  id: "ink-pomo",
  name: "潑墨爆",
  paramSchema: [
    { key: "sens", label: "感應靈敏度", type: "range", min: 0.5, max: 3, step: 0.1, default: 1 },
    { key: "force", label: "潑墨力道", type: "range", min: 0.3, max: 2.5, step: 0.1, default: 1 },
    { key: "amount", label: "墨量", type: "range", min: 0.4, max: 2, step: 0.1, default: 1 },
    { key: "splatter", label: "飛濺", type: "range", min: 0, max: 2, step: 0.1, default: 1 },
    { key: "life", label: "墨壽命", type: "range", min: 5, max: 30, step: 1, default: 12, suffix: "秒" },
  ],
  update({ core, audio, palette, paperMode, params, now, lyricChanged }) {
    const force = (params.force as number) || 1;
    const amount = (params.amount as number) || 1;
    const splatter = (params.splatter as number) ?? 1;
    const life = (params.life as number) || 12;
    const sens = (params.sens as number) || 1;
    const sm = 0.6 + sens * 0.4; // 靈敏度微調力道
    // 主驅動＝重低音突發：炸開大潑墨（accent 插色）
    if (audio.bassSpike) pomoSplash(core, baseStrength(audio.bass * 1.6) * sm, pickInk(palette, "accent", paperMode), force, amount, splatter, now);
    else if (audio.beat) pomoSplash(core, baseStrength(audio.bass * 0.9 + 0.2) * sm, pickInk(palette, "normal", paperMode), force * 0.7, amount * 0.8, splatter * 0.7, now);
    if (audio.trebleSpike) pomoSplash(core, 0.4 * sm, pickInk(palette, "accent", paperMode), force * 0.5, amount * 0.5, splatter, now); // 高音小撇飛濺
    if (lyricChanged) pomoSplash(core, 0.6, pickInk(palette, "normal", paperMode), force, amount, splatter, now);
    seep(core, pomoDrops, now, life);                              // 持續暈開擴散
    return {
      curl: 20,
      velDissipation: 0.42,   // 爆衝速度衰減（潑出去再沉澱）
      dyeDissipation: 6.9 / life,
      diffusion: 0.03,
    };
  },
};

export const EFFECTS: InkEffect[] = [inkFlow, inkDrop, inkBloom, inkSpin, inkSurge, inkTaiji, inkPomo];

// 試滴（不靠音訊、studio 的「試滴一墨」按鈕）
export function testDrop(core: FluidCore, effect: InkEffect, palette: Palette, paperMode: PaperMode) {
  const col = pickInk(palette, Math.random() < 0.25 ? "accent" : "normal", paperMode);
  if (effect.id === "ink-pomo") {
    pomoSplash(core, 0.7 + Math.random() * 0.3, col, 1, 1, 1, performance.now());
  } else if (effect.id === "ink-drop") {
    softDrop(core, 0.4 + Math.random() * 0.5, col, dropDrops, performance.now());
  } else if (effect.id === "ink-bloom") {
    const x = bloomX(); // 跟正式滴墨一樣走均勻序列
    const y = 0.8 + Math.random() * 0.1;
    const r = FluidCore.SPLAT_RADIUS * (1.2 + Math.random() * 1.2);
    core.splatDye(x, y, scale(col, 0.55), r, 1.4);
    core.splatVel(x, y, (Math.random() - 0.5) * 50, -(200 + Math.random() * 200), r * 2.0);
  } else {
    const [x, y] = randPos();
    const r = FluidCore.SPLAT_RADIUS * (2 + Math.random() * 5);
    core.splatDye(x, y, scale(col, 0.8), r, 1.0);
    core.splatVel(x, y, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 300, r);
  }
}
