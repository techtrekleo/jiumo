// 封面製作：純函式資料模型 + 文字繪製 + 渲染協調。
// 設計重點：文字與特效一律「以目標解析度重繪」→ 4K 邊緣銳利、無損（不靠放大）。底圖特效重用 BgFx 引擎。
// 比例與影片輸出一致（16:9 / 9:16 / 1:1）；畫質最高 4K（跨瀏覽器安全），8K 桌機進階（依 MAX_TEXTURE_SIZE 開放）。

import { LYRIC_FONTS } from "./lyrics";
import { BgFx, BG_EFFECTS, type BgFilterCall } from "./bg-fx";

export type CoverRatio = "16:9" | "9:16" | "1:1";
export type CoverResTier = "1080" | "2k" | "4k" | "8k";

export const COVER_RATIOS: { id: CoverRatio; label: string }[] = [
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
];

// 各畫質檔位（長邊像素，給 16:9 / 9:16 用）。4K = 跨瀏覽器安全上限；8K = 桌機進階。
export const COVER_RES: { id: CoverResTier; label: string; long: number; square: number; min: number }[] = [
  { id: "1080", label: "1080p", long: 1920, square: 1080, min: 0 },
  { id: "2k", label: "2K", long: 2560, square: 2048, min: 0 },
  { id: "4k", label: "4K", long: 3840, square: 3840, min: 0 },
  { id: "8k", label: "8K", long: 7680, square: 7680, min: 8192 }, // min＝需要的 MAX_TEXTURE_SIZE
];

export function coverDims(ratio: CoverRatio, tier: CoverResTier): { w: number; h: number } {
  const r = COVER_RES.find((x) => x.id === tier) || COVER_RES[2];
  if (ratio === "1:1") return { w: r.square, h: r.square };
  const short = Math.round((r.long * 9) / 16);
  return ratio === "16:9" ? { w: r.long, h: short } : { w: short, h: r.long };
}

// 預覽用：固定比例、輕量解析度（跟 export 畫質無關，省效能）。
export function coverPreviewDims(ratio: CoverRatio): { w: number; h: number } {
  if (ratio === "1:1") return { w: 760, h: 760 };
  const L = 1000, short = Math.round((L * 9) / 16);
  return ratio === "16:9" ? { w: L, h: short } : { w: short, h: L };
}

// ───────── 文字圖層 ─────────

export type CoverText = {
  id: string;
  content: string;
  fontId: string;
  color: string;
  sizePct: number;   // 字級＝短邊 × sizePct%
  x: number; y: number; // 0~1（畫面比例座標）
  rot: number;       // 度
  align: CanvasTextAlign;
  strokeOn: boolean; strokeColor: string; strokePct: number; // 描邊寬＝px × strokePct%
  shadowOn: boolean; shadowColor: string; shadowPct: number; // 陰影模糊＝px × shadowPct%
};

let textSeq = 0;
export const genCoverTextId = () => `ct_${Date.now().toString(36)}_${textSeq++}`;

export const defaultCoverText = (id: string): CoverText => ({
  id, content: "標題文字", fontId: "modab", color: "#ffffff", sizePct: 14,
  x: 0.5, y: 0.5, rot: 0, align: "center",
  strokeOn: false, strokeColor: "#000000", strokePct: 7,
  shadowOn: true, shadowColor: "rgba(0,0,0,0.55)", shadowPct: 16,
});

export function coverFontFamily(fontId: string): string {
  const f = (LYRIC_FONTS.find((x) => x.id === fontId) || LYRIC_FONTS[0]).fonts[0];
  return `'${f}', 'NotoSerifTC-Medium', 'LXGWWenKaiTC-Medium', serif`;
}

const clearShadow = (ctx: CanvasRenderingContext2D) => {
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
};

export function drawCoverText(ctx: CanvasRenderingContext2D, t: CoverText, W: number, H: number) {
  const short = Math.min(W, H);
  const px = Math.max(4, (t.sizePct / 100) * short);
  ctx.save();
  ctx.translate(t.x * W, t.y * H);
  if (t.rot) ctx.rotate((t.rot * Math.PI) / 180);
  ctx.font = `${px}px ${coverFontFamily(t.fontId)}`;
  ctx.textAlign = t.align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const lines = t.content.split("\n");
  const lh = px * 1.22;
  const total = (lines.length - 1) * lh;
  for (let i = 0; i < lines.length; i++) {
    const yy = i * lh - total / 2;
    // 陰影只掛在「最外層那一筆」（有描邊→描邊帶陰影；否則填色帶陰影），避免疊兩次糊掉
    if (t.strokeOn) {
      ctx.lineWidth = Math.max(1, (t.strokePct / 100) * px);
      ctx.strokeStyle = t.strokeColor;
      if (t.shadowOn) { ctx.shadowColor = t.shadowColor; ctx.shadowBlur = (t.shadowPct / 100) * px; ctx.shadowOffsetX = px * 0.03; ctx.shadowOffsetY = px * 0.05; }
      ctx.strokeText(lines[i], 0, yy);
      clearShadow(ctx);
      ctx.fillStyle = t.color; ctx.fillText(lines[i], 0, yy);
    } else {
      if (t.shadowOn) { ctx.shadowColor = t.shadowColor; ctx.shadowBlur = (t.shadowPct / 100) * px; ctx.shadowOffsetX = px * 0.03; ctx.shadowOffsetY = px * 0.05; }
      ctx.fillStyle = t.color; ctx.fillText(lines[i], 0, yy);
      clearShadow(ctx);
    }
  }
  ctx.restore();
}

// ───────── 疊圖層（其他圖疊上去：logo / 裝飾 / 黑底特效素材）─────────

export type CoverBlend = "normal" | "screen" | "multiply";
// 混合模式：normal 正常疊；screen 濾色＝黑底去背(純黑透明、亮部疊上，比照影片層)；multiply 色彩增值＝白底去背(白透明、暗部疊上，水墨黑稿用)
export const COVER_BLENDS: { id: CoverBlend; label: string }[] = [
  { id: "normal", label: "正常" },
  { id: "screen", label: "濾色（黑底去背）" },
  { id: "multiply", label: "色彩增值（白底去背）" },
];

export type CoverImage = {
  id: string;
  x: number; y: number;   // 0~1（中心點，畫面比例座標）
  scalePct: number;       // 寬度＝畫布寬 × scalePct%
  rot: number;            // 度
  opacity: number;        // 0~1
  blend: CoverBlend;
};

let imgSeq = 0;
export const genCoverImageId = () => `ci_${Date.now().toString(36)}_${imgSeq++}`;
export const defaultCoverImage = (id: string): CoverImage => ({ id, x: 0.5, y: 0.5, scalePct: 40, rot: 0, opacity: 1, blend: "normal" });

export function drawCoverImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, ci: CoverImage, W: number, H: number) {
  if (!img.naturalWidth) return;
  const dw = Math.max(1, (ci.scalePct / 100) * W);
  const dh = dw * (img.naturalHeight / img.naturalWidth);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, ci.opacity));
  if (ci.blend === "screen") ctx.globalCompositeOperation = "screen";
  else if (ci.blend === "multiply") ctx.globalCompositeOperation = "multiply";
  ctx.translate(ci.x * W, ci.y * H);
  if (ci.rot) ctx.rotate((ci.rot * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true;
  (ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// ───────── 美化特效（重用 bg-fx，封面用的精選清單）─────────

export const COVER_FX_MENU: { id: string; name: string; hasFocus: boolean }[] = [
  { id: "crossglass", name: "交叉聚焦框", hasFocus: true },
  { id: "vignette", name: "暗角聚焦", hasFocus: false },
  { id: "chroma", name: "色像差", hasFocus: false },
  { id: "bulge", name: "凸透鏡", hasFocus: false },
  { id: "blur", name: "柔焦模糊", hasFocus: false },
  { id: "grayscale", name: "黑白", hasFocus: false },
];
export const coverFxName = (id: string) =>
  COVER_FX_MENU.find((x) => x.id === id)?.name || BG_EFFECTS.find((e) => e.id === id)?.name || id;

export type CoverFx = BgFilterCall & { uid: string };
let fxSeq = 0;
export const genCoverFxId = () => `cf_${Date.now().toString(36)}_${fxSeq++}`;

export const defaultCoverFx = (uid: string, fx: string): CoverFx => {
  // crossglass：兩條獨立角度的清晰直條(線一45°/線二135°＝X)，帶內清晰、帶外模糊+黑白。density=外圈黑白、speed=外圈模糊、colorA=外框色。
  if (fx === "crossglass") return { uid, fx, amount: 0.9, posX: 0.5, posY: 0.5, scale: 1, angle: 45, angle2: 135, density: 0.35, speed: 0.55, colorA: "#ffffff" };
  return { uid, fx, amount: 0.6 };
};

// ───────── 渲染協調 ─────────

// 裁切：zoom 縮放(1=cover-fit 填滿)、x/y 平移(0~1，0.5=置中)。
export type CoverCrop = { zoom: number; x: number; y: number };
export const defaultCoverCrop = (): CoverCrop => ({ zoom: 1, x: 0.5, y: 0.5 });

export function drawImageCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, W: number, H: number, crop?: CoverCrop) {
  const z = crop?.zoom ?? 1, ox = crop?.x ?? 0.5, oy = crop?.y ?? 0.5;
  const k = Math.max(W / img.naturalWidth, H / img.naturalHeight) * z;
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  ctx.imageSmoothingEnabled = true;
  (ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
  ctx.drawImage(img, (W - w) * ox, (H - h) * oy, w, h);
}

export type RenderCoverOpts = {
  W: number; H: number;
  bgImg: HTMLImageElement | null;
  bgColor: string;
  texts: CoverText[];
  fx: BgFilterCall[];
  fxEngine: BgFx | null; // 有 fx 且有底圖時用來跑 GPU 後製
  crop?: CoverCrop;
  overlays?: { ci: CoverImage; img: HTMLImageElement }[]; // 疊圖（底圖+特效之上、文字之下）
};

// 一次把整張封面畫進 ctx（底圖→特效→疊圖→文字）。預覽與匯出共用。
export function renderCover(ctx: CanvasRenderingContext2D, o: RenderCoverOpts) {
  const { W, H, bgImg, fx, fxEngine, crop } = o;
  ctx.clearRect(0, 0, W, H);
  if (bgImg && fx.length && fxEngine && fxEngine.ok) {
    fxEngine.resize(W, H);
    fxEngine.setSource(bgImg, W, H, crop);
    fxEngine.render(fx, 0);
    ctx.drawImage(fxEngine.canvas, 0, 0, W, H);
  } else if (bgImg) {
    drawImageCover(ctx, bgImg, W, H, crop);
  } else {
    ctx.fillStyle = o.bgColor || "#0a0809";
    ctx.fillRect(0, 0, W, H);
  }
  for (const ov of o.overlays ?? []) drawCoverImage(ctx, ov.img, ov.ci, W, H);
  for (const t of o.texts) drawCoverText(ctx, t, W, H);
}

// 偵測這台裝置的 WebGL 紋理上限（決定 8K 能不能開、export 是否要降階）。
export function detectMaxTexture(): number {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return 4096;
    return (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).MAX_TEXTURE_SIZE) as number;
  } catch { return 4096; }
}
