// 九墨 Phase 2-3（媒體層）：把 composition 的「上傳資產」層畫進合成 canvas。
//   背景圖（鋪底）/ 圖片 Logo / 影片 / 文字，依各層 transform（位置·大小）與 timing（起訖秒數）。
//   墨效 / 墨體 / 歌詞 / 印章仍由 studio 既有路徑渲染；此檔只管「使用者上傳的素材層」。
//   媒體元素（Image/Video）以 cache 復用，src 變了才重建。

import type { AlphaParams, BackgroundParams, Composition, Layer, TextAnim, Easing } from "./composition";
import { isLayerActive } from "./composition";
import { PAPER_COLORS } from "./palette";
import { LYRIC_FONTS, type LyricLine } from "./lyrics";
import { renderGlass } from "./glass-fx";

// 背景純色（自訂色優先，否則 paperMode 紙色）→ CSS 字串。圖的底色 / 無圖時的鋪色共用。
export function bgColorCss(p: BackgroundParams): string {
  if (p.customColor) return p.customColor;
  const c = PAPER_COLORS[p.paperMode];
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

type MediaEl = HTMLImageElement | HTMLVideoElement;
export type MediaCache = Map<string, MediaEl>;

type TextFx = "none" | "outline" | "shadow" | "neon" | "lines";

// 白線夾字幕：在文字中心 (cx,cy) 上／下各畫一條白線（mode 選上線/下線/雙線）。用當前 ctx.font 量字寬。
function drawSandwichLines(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, px: number, mode: "top" | "bottom" | "both" = "both") {
  const w = ctx.measureText(text).width;
  const halfW = w / 2 + px * 0.55;
  const gap = px * 0.72; // 線距文字中心
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.96)";
  ctx.lineWidth = Math.max(2, px * 0.05);
  ctx.lineCap = "round";
  if (mode !== "bottom") { ctx.beginPath(); ctx.moveTo(cx - halfW, cy - gap); ctx.lineTo(cx + halfW, cy - gap); ctx.stroke(); }
  if (mode !== "top") { ctx.beginPath(); ctx.moveTo(cx - halfW, cy + gap); ctx.lineTo(cx + halfW, cy + gap); ctx.stroke(); }
  ctx.restore();
}
// 完整 font-family fallback 鏈：主字體缺字 → 退思源宋體（近全 CJK 覆蓋）→ 退系統字。
// 回傳已含引號的字串，直接接在 ctx.font 的 "{px}px " 後面（不要再外加引號）。
function fontFamily(fontId: string): string {
  const primary = (LYRIC_FONTS.find((x) => x.id === fontId) || LYRIC_FONTS[0]).fonts[0];
  return `'${primary}', 'NotoSerifTC-Medium', 'LXGWWenKaiTC-Medium', serif`;
}
// 描邊由呼叫端在 fill 前 strokeText；此處只設陰影/霓虹
function applyTextShadow(ctx: CanvasRenderingContext2D, fxs: readonly TextFx[], color: string, px: number) {
  // neon 與 shadow 都吃 ctx.shadow*（同一狀態）→ 同時選時 neon 優先
  if (fxs.includes("neon")) { ctx.shadowColor = color; ctx.shadowBlur = px * 0.45; }
  else if (fxs.includes("shadow")) { ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = px * 0.18; ctx.shadowOffsetX = px * 0.05; ctx.shadowOffsetY = px * 0.05; }
}
function currentLyric(lines: LyricLine[], t: number): LyricLine | null {
  let r: LyricLine | null = null;
  for (const l of lines) { if (l.t <= t) r = l; else break; }
  if (r && r.end != null && t > r.end) return null; // 有設定結束時間：過了就讓這句消失（SRT 兩句間的空檔）
  return r;
}

function easeT2(e: Easing, f: number): number {
  switch (e) {
    case "in": return f * f;
    case "out": return 1 - (1 - f) * (1 - f);
    case "inout": return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    default: return f;
  }
}
function hasTextAnim(a?: TextAnim): boolean {
  return !!a && !!(a.alpha || a.blur || a.scale || a.horiz || a.vert || a.liquid || a.distort || a.shake);
}
// 取文字特效清單（複選）。舊專案存的是單一 textEffect 字串 → 轉成陣列相容。
function textFxList(p: { textEffects?: TextFx[]; textEffect?: TextFx }): readonly TextFx[] {
  if (p.textEffects) return p.textEffects;
  return p.textEffect && p.textEffect !== "none" ? [p.textEffect] : [];
}

// 畫一行帶進場動畫的文字／字幕。呼叫端先設好 ctx.font；appearT=出現時刻、t=現在（秒）。
//   進場（alpha/blur/scale/horiz/vert）以 inDur+easing 補間；shake 是進場晃動爆發；liquid/distort 逐字持續。
export function drawAnimText(
  ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, px: number,
  color: string, fxs: readonly TextFx[], anim: TextAnim | undefined, appearT: number, t: number,
  lineMode: "top" | "bottom" | "both" = "both",
) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const stroke = (s: string, x: number, y: number) => {
    if (fxs.includes("outline")) { ctx.lineWidth = Math.max(2, px * 0.08); ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.strokeText(s, x, y); }
  };
  if (!hasTextAnim(anim)) {
    if (fxs.includes("lines")) drawSandwichLines(ctx, text, cx, cy, px, lineMode);
    applyTextShadow(ctx, fxs, color, px);
    stroke(text, cx, cy);
    ctx.fillStyle = color; ctx.fillText(text, cx, cy);
    ctx.restore();
    return;
  }
  const a = anim!;
  const inDur = Math.max(0.001, a.inDur ?? 0.5);
  const el = t - appearT;
  const p = easeT2(a.easing ?? "out", Math.max(0, Math.min(1, el / inDur)));
  let dx = 0, dy = 0;
  if (a.horiz) dx += (1 - p) * px * 6;   // 從右滑入
  if (a.vert) dy += (1 - p) * px * 2.5;  // 從下滑入
  if (a.shake && el >= 0) {               // 進場晃動爆發（隨時間衰減）
    const sdur = Math.max(0.05, a.shakeDur ?? 0.4);
    if (el < sdur) {
      const amp = (a.shakeAmp ?? 8) * (1 - el / sdur);
      const ph = el * (a.shakeFreq ?? 14) * Math.PI * 2;
      dx += Math.sin(ph) * amp; dy += Math.cos(ph * 1.3) * amp;
    }
  }
  ctx.translate(cx + dx, cy + dy);
  if (a.scale) { const s = 0.55 + 0.45 * p; ctx.scale(s, s); }
  if (a.alpha) ctx.globalAlpha *= p;
  if (a.blur && p < 1) ctx.filter = `blur(${(1 - p) * Math.max(2, px * 0.14)}px)`;
  if (fxs.includes("lines")) drawSandwichLines(ctx, text, 0, 0, px, lineMode); // 已 translate 到字中心 → 在 local 原點畫
  applyTextShadow(ctx, fxs, color, px);
  if (a.liquid || a.distort) {            // 逐字：液化(垂直波)＋扭曲(隨機抖)
    const chars = [...text];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((s, w) => s + w, 0);
    let gx = -total / 2;
    for (let i = 0; i < chars.length; i++) {
      const w = widths[i];
      let ox = 0, oy = 0;
      if (a.liquid) oy += Math.sin(t * 4 + i * 0.6) * px * 0.16;
      if (a.distort) { ox += Math.sin(t * 33 + i * 7) * px * 0.07; oy += Math.cos(t * 29 + i * 4) * px * 0.07; }
      const ccx = gx + w / 2;
      stroke(chars[i], ccx + ox, oy);
      ctx.fillStyle = color; ctx.fillText(chars[i], ccx + ox, oy);
      gx += w;
    }
  } else {
    stroke(text, 0, 0);
    ctx.fillStyle = color; ctx.fillText(text, 0, 0);
  }
  ctx.restore();
}

function getImage(cache: MediaCache, key: string, url: string): HTMLImageElement | null {
  const cached = cache.get(key);
  if (cached instanceof HTMLImageElement && cached.dataset.srcKey === url) {
    return cached.complete && cached.naturalWidth > 0 ? cached : null;
  }
  const img = new Image();
  img.dataset.srcKey = url;
  img.src = url;
  cache.set(key, img);
  return null; // 載入中，這幀先不畫
}

// 影片：建立元素並把「播放位置同步到時間軸 t」。playhead 在哪 → 影片就跳到對應幀。
//   這樣拉回片頭、影片會跟著回到開頭重現（修：原本影片自己跑一次就停、跟 playhead 脫鉤，拉回去不見）。
//   startSec = 這層的出現起點（timing.start）；loop 會在影片長度內循環；playing = 時間軸是否前進中。
function syncVideo(
  cache: MediaCache, key: string, url: string, loop: boolean, startSec: number, t: number, playing: boolean,
): HTMLVideoElement | null {
  const cached = cache.get(key);
  if (!(cached instanceof HTMLVideoElement) || cached.dataset.srcKey !== url) {
    const nv = document.createElement("video");
    nv.dataset.srcKey = url;
    nv.src = url;
    nv.muted = true;
    nv.playsInline = true;
    nv.preload = "auto";
    cache.set(key, nv);
    return null; // 載入中
  }
  const v = cached;
  if (v.readyState < 2 || v.videoWidth === 0 || !v.duration) return null;
  const dur = v.duration;
  let vt = t - startSec;                 // 影片應在的播放位置（相對它的起點）
  if (loop && dur > 0) vt = ((vt % dur) + dur) % dur;
  const inWindow = vt >= 0 && (loop || vt <= dur);
  const target = Math.max(0, Math.min(dur - 0.001, vt));
  if (playing && inWindow) {
    if (v.paused) void v.play().catch(() => {});
    if (Math.abs(v.currentTime - vt) > 0.34) v.currentTime = target; // 漂移才校正，平常讓它自然播、不卡頓
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target; // 暫停/拖曳 → 直接跳到對應幀
  }
  return v;
}

// 清掉 cache 裡已不在 comp 的媒體（避免殘留影片繼續解碼）
export function pruneMediaCache(cache: MediaCache, comp: Composition) {
  const live = new Set(comp.map((l) => l.id));
  for (const key of [...cache.keys()]) {
    if (!live.has(key)) {
      const el = cache.get(key);
      if (el instanceof HTMLVideoElement) { el.pause(); el.src = ""; }
      cache.delete(key);
    }
  }
}

function coverFit(sw: number, sh: number, W: number, H: number) {
  const k = Math.max(W / sw, H / sh);
  const w = sw * k, h = sh * k;
  return { dx: (W - w) / 2, dy: (H - h) / 2, dw: w, dh: h };
}

// 背景圖：鋪滿整個畫面（cover）。回傳是否畫了圖（讓 studio 決定墨要不要用混合模式疊上去）。
export function drawBackgroundLayer(
  ctx: CanvasRenderingContext2D, comp: Composition, cache: MediaCache,
  t: number, duration: number, W: number, H: number,
): boolean {
  const bg = comp.find((l) => l.type === "background");
  if (!bg || !isLayerActive(bg, t, duration) || bg.type !== "background") return false;
  const url = bg.params.imageUrl;
  if (!url) return false;
  const img = getImage(cache, bg.id, url);
  if (!img) return false;
  // 先鋪背景色（自訂色/紙色）→ 圖半透明時露出底色
  ctx.fillStyle = bgColorCss(bg.params);
  ctx.fillRect(0, 0, W, H);
  const { dx, dy, dw, dh } = coverFit(img.naturalWidth, img.naturalHeight, W, H);
  ctx.save();
  ctx.globalAlpha = bg.params.imageOpacity ?? 1;
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
  return true;
}

// 取「已載入完成」的背景圖元素（給 BgFx 濾鏡管線當輸入）；沒圖／載入中回 null。
// 與 drawBackgroundLayer 共用同一個 cache key（bg.id），不會重複載。
export function getBackgroundImage(
  comp: Composition, cache: MediaCache, t: number, duration: number,
): HTMLImageElement | null {
  const bg = comp.find((l) => l.type === "background");
  if (!bg || !isLayerActive(bg, t, duration) || bg.type !== "background") return null;
  const url = bg.params.imageUrl;
  if (!url) return null;
  return getImage(cache, bg.id, url);
}

// 自訂落款：複刻「九墨」品牌章造型 — 硃砂直角底 + 宣紙白單線外框 + 直書置中白字。
//   尺寸/比例對齊 seal-jiumo.png（576×1524、外框內縮 48px、框線 15px）；只差字型走站上自帶（授權乾淨）。
//   兩字時的footprint與品牌章完全一致；字多/字少時 box 沿直書方向伸縮、文字維持置中。
function drawCustomSeal(
  ctx: CanvasRenderingContext2D, text: string, fontId: string,
  sealColor: string, textColor: string, opacity: number,
  cx: number, cy: number, W: number, H: number, scale: number,
) {
  const chars = [...text].slice(0, 8);
  const n = chars.length;
  if (n === 0) return;
  const unit = Math.min(W, H) * scale;
  const fontPx = unit * 0.0487; //   字級＝品牌章字級
  const pitch = fontPx; //           直書字距（中心距，品牌章＝1 em）
  const boxW = fontPx * 1.63; //     章寬＝字級 ×1.63（對齊 576:1524）
  const marginV = fontPx * 1.16; //  上下留白（品牌章雙字置中的留白）
  const boxH = (n - 1) * pitch + fontPx + marginV * 2;
  const left = cx - boxW / 2, top = cy - boxH / 2;
  const inset = boxW * 0.083; //     外框內縮（48/576）
  const stroke = boxW * 0.026; //    框線粗細（15/576）
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = sealColor; //                          硃砂底（直角矩形）
  ctx.fillRect(left, top, boxW, boxH);
  ctx.strokeStyle = textColor; //                        宣紙白外框
  ctx.lineWidth = stroke;
  const fo = inset + stroke / 2; // 框線中心線位置（外緣落在 inset）
  ctx.strokeRect(left + fo, top + fo, boxW - fo * 2, boxH - fo * 2);
  ctx.fillStyle = textColor; //                          直書印文（置中）
  ctx.font = `${fontPx}px ${fontFamily(fontId)}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const y0 = cy - ((n - 1) * pitch) / 2;
  for (let i = 0; i < n; i++) ctx.fillText(chars[i], cx, y0 + i * pitch);
  ctx.restore();
}

/* ── CTA 訂閱動畫 ─────────────────────────────────────────────────────────
   YouTube 風格三連發：拇指(讚) → 訂閱(中英上下) → 鈴鐺；游標依序點擊，每顆點到
   就 pop 變紅 + 漣漪擴散，鈴鐺點完搖一下。給「沒自己做片頭」的人當開場 CTA。
   icon 用 lucide 向量路徑（乾淨專業）。整段由 composition 時間 t 驅動 → 預覽=錄製=匯出一致。 */
const CTA_ICON = {
  thumb: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z",
  thumbLine: "M7 10v12",
  bell: "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  bellClap: "M10.268 21a2 2 0 0 0 3.464 0",
  cursor: "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z",
};
let ctaPathCache: Record<string, Path2D> | null = null;
function ctaPath(name: keyof typeof CTA_ICON): Path2D {
  if (!ctaPathCache) ctaPathCache = Object.fromEntries(Object.entries(CTA_ICON).map(([k, d]) => [k, new Path2D(d)]));
  return ctaPathCache[name];
}
const ctaEaseInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const ctaEaseOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
  const bl = Math.round(lerp(pa & 255, pb & 255, t));
  return `rgb(${r},${g},${bl})`;
}
// 畫 lucide icon（24×24 viewBox）描邊，置中於 (cx,cy)、視覺線寬 lw、可旋轉
function ctaStrokeIcon(ctx: CanvasRenderingContext2D, names: (keyof typeof CTA_ICON)[], cx: number, cy: number, size: number, color: string, lw: number, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot);
  const s = size / 24;
  ctx.scale(s, s);
  ctx.translate(-12, -12);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw / s;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const nm of names) ctx.stroke(ctaPath(nm));
  ctx.restore();
}
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCta(ctx: CanvasRenderingContext2D, gx: number, gy: number, W: number, H: number, scale: number, red: string, localT: number, loop: boolean) {
  const PERIOD = 6.0;
  const HOLD_END = 4.8, DISSOLVE = 1.25, VANISH = HOLD_END + DISSOLVE; // 不循環：播完保持一下 → 墨隱消失
  if (!loop && localT >= VANISH) return; // 墨隱後不再畫（片頭跑一次就消失、不佔畫面）
  const T = loop ? localT % PERIOD : localT;
  const TAU = Math.PI * 2;
  const ctaEaseIn = (t: number) => t * t * t;
  const PAPER = "#f4eee2", INK = "#2b2622", PAPERLT = "#fbf7ee"; // 宣紙 / 墨 / 亮紙
  const CLICKS = [0.7, 1.85, 3.0]; // 拇指 / 訂閱 / 鈴鐺 點擊時刻
  const hexRgb = (h: string) => { const p = parseInt(h.slice(1), 16); return `${(p >> 16) & 255},${(p >> 8) & 255},${p & 255}`; };
  const rgba = (h: string, a: number) => `rgba(${hexRgb(h)},${a})`;

  // 每顆的「上墨」進度（點到才暈染，循環時 5s 後淡回宣紙）
  const fillOf = (i: number) => {
    const tc = CLICKS[i];
    if (T < tc) return 0;
    const up = ctaEaseOut(clamp01((T - tc) / 0.34)); // 墨暈擴散稍慢、更像滲開
    if (loop && T > 5.0) return up * clamp01(1 - (T - 5.0) / 0.7);
    return up;
  };
  const popOf = (i: number) => {
    const p = clamp01((T - CLICKS[i]) / 0.3);
    return p > 0 && p < 1 ? 1 + 0.14 * Math.sin(p * Math.PI) : 1;
  };

  // 版面：拇指圓鈕 — 訂閱藥丸 — 鈴鐺圓鈕，水平置中於 (gx,gy)
  const D = Math.min(W, H) * 0.135 * scale;
  const pillW = D * 2.9, pillH = D;
  const gap = D * 0.42;
  const totalW = D + gap + pillW + gap + D;
  let cur = gx - totalW / 2;
  const likeC = { x: cur + D / 2, y: gy }; cur += D + gap;
  const subC = { x: cur + pillW / 2, y: gy }; cur += pillW + gap;
  const bellC = { x: cur + D / 2, y: gy };
  const lw = D * 0.07; // icon 線寬

  // 硃砂墨暈：在已 clip 的形狀內，從 origin(ox,oy) 滲開填滿（多層徑向墨團疊出暈染、不規則邊）
  const inkBloom = (ox: number, oy: number, reach: number, fill: number) => {
    if (fill <= 0) return;
    const r = reach * (0.25 + 1.25 * ctaEaseOut(fill));
    const box = reach * 3;
    const blob = (cx2: number, cy2: number, rad: number, a0: number) => {
      const g = ctx.createRadialGradient(cx2, cy2, rad * 0.18, cx2, cy2, rad);
      g.addColorStop(0, rgba(red, a0));
      g.addColorStop(0.7, rgba(red, a0));
      g.addColorStop(0.9, rgba(red, a0 * 0.7));
      g.addColorStop(1, rgba(red, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-box, -box, box * 2, box * 2);
    };
    blob(ox, oy, r, 1);
    blob(ox + r * 0.42, oy - r * 0.3, r * 0.6, 0.7); // 衛星墨團 → 暈染不規則
    blob(ox - r * 0.36, oy + r * 0.4, r * 0.55, 0.65);
  };

  const drawCircleBtn = (c: { x: number; y: number }, fill: number, pop: number, iconNames: (keyof typeof CTA_ICON)[], rot = 0) => {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(pop, pop);
    ctx.save(); // 宣紙底 + 墨影
    ctx.shadowColor = "rgba(43,38,34,0.22)";
    ctx.shadowBlur = D * 0.1;
    ctx.shadowOffsetY = D * 0.04;
    ctx.fillStyle = PAPER;
    ctx.beginPath(); ctx.arc(0, 0, D / 2, 0, TAU); ctx.fill();
    ctx.restore();
    if (fill > 0) { // 硃砂墨暈（clip 圓內滲開）
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, D / 2, 0, TAU); ctx.clip();
      inkBloom(D * 0.16, D * 0.16, D * 0.66, fill);
      ctx.restore();
    }
    ctx.lineWidth = D * 0.038; // 毛筆邊：墨 → 硃砂
    ctx.strokeStyle = mixHex(INK, red, fill);
    ctx.beginPath(); ctx.arc(0, 0, D / 2 - D * 0.019, 0, TAU); ctx.stroke();
    ctaStrokeIcon(ctx, iconNames, 0, 0, D * 0.5, mixHex(INK, PAPERLT, clamp01(fill * 1.25)), lw, rot);
    ctx.restore();
  };

  // 墨韻擴散漣漪：點下瞬間幾圈柔墨環向外滲、淡去
  const drawInkRing = (c: { x: number; y: number }, i: number, r0: number) => {
    const p = (T - CLICKS[i]) / 0.6;
    if (p <= 0 || p >= 1) return;
    ctx.save();
    for (let k = 0; k < 2; k++) {
      const pp = clamp01(p - k * 0.18);
      if (pp <= 0 || pp >= 1) continue;
      ctx.strokeStyle = rgba(red, (1 - pp) * 0.4);
      ctx.lineWidth = D * 0.05 * (1 - pp);
      ctx.beginPath();
      ctx.arc(c.x, c.y, lerp(r0, r0 + D * 0.75, ctaEaseOut(pp)), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  };

  // 游標路徑（純 T 的函式 → 可取過去位置畫墨痕）
  const home = { x: gx + totalW * 0.4, y: gy + D * 1.5 };
  const wps: { t: number; p: { x: number; y: number } }[] = [
    { t: 0.0, p: home },
    { t: 0.6, p: { x: likeC.x + D * 0.14, y: likeC.y + D * 0.14 } },
    { t: 1.75, p: { x: subC.x + pillW * 0.1, y: subC.y + pillH * 0.16 } },
    { t: 2.9, p: { x: bellC.x + D * 0.14, y: bellC.y + D * 0.14 } },
    { t: 3.7, p: home },
  ];
  const cursorAt = (tt: number): { x: number; y: number } => {
    if (tt <= wps[0].t) return wps[0].p;
    for (let i = 0; i < wps.length - 1; i++) {
      if (tt >= wps[i].t && tt < wps[i + 1].t) {
        const k = ctaEaseInOut((tt - wps[i].t) / (wps[i + 1].t - wps[i].t));
        return { x: lerp(wps[i].p.x, wps[i + 1].p.x, k), y: lerp(wps[i].p.y, wps[i + 1].p.y, k) };
      }
    }
    return wps[wps.length - 1].p;
  };

  // 墨隱收尾（不循環）：保持一段 → 整組淡出 + 往上飄散 + 硃砂往外擴散
  let exitA = 1, exitRise = 0, exitDiff = 0;
  if (!loop && T > HOLD_END) {
    const e = clamp01((T - HOLD_END) / DISSOLVE);
    exitA = 1 - ctaEaseIn(e);
    exitRise = D * 0.55 * ctaEaseOut(e);
    exitDiff = e;
  }

  ctx.save();
  if (!loop) { ctx.globalAlpha = exitA; ctx.translate(0, -exitRise); }

  // ── 訂閱藥丸（主角）：宣紙底 + 硃砂墨暈滲滿 + 訂閱/SUBSCRIBE
  const subFill = fillOf(1), subPop = popOf(1);
  ctx.save();
  ctx.translate(subC.x, subC.y);
  ctx.scale(subPop, subPop);
  ctx.save();
  ctx.shadowColor = "rgba(43,38,34,0.24)";
  ctx.shadowBlur = D * 0.12;
  ctx.shadowOffsetY = D * 0.05;
  ctx.fillStyle = PAPER;
  roundRectPath(ctx, -pillW / 2, -pillH / 2, pillW, pillH, pillH * 0.5);
  ctx.fill();
  ctx.restore();
  if (subFill > 0) {
    ctx.save();
    roundRectPath(ctx, -pillW / 2, -pillH / 2, pillW, pillH, pillH * 0.5);
    ctx.clip();
    inkBloom(pillW * 0.1, pillH * 0.16, pillW * 0.62, subFill); // 從點擊處往外滲
    ctx.restore();
  }
  ctx.lineWidth = D * 0.034;
  ctx.strokeStyle = mixHex(INK, red, subFill);
  roundRectPath(ctx, -pillW / 2 + D * 0.017, -pillH / 2 + D * 0.017, pillW - D * 0.034, pillH - D * 0.034, pillH * 0.5);
  ctx.stroke();
  const txtCol = mixHex(INK, PAPERLT, clamp01(subFill * 1.25));
  ctx.fillStyle = txtCol;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${pillH * 0.4}px 'GenSenRounded', 'NotoSerifTC-Medium', sans-serif`;
  ctx.fillText("訂閱", 0, -pillH * 0.14);
  const prevLS = ctx.letterSpacing;
  ctx.letterSpacing = `${pillH * 0.06}px`;
  ctx.font = `${pillH * 0.26}px 'BebasNeue', sans-serif`;
  ctx.fillText("SUBSCRIBE", pillH * 0.03, pillH * 0.26);
  ctx.letterSpacing = prevLS;
  ctx.restore();

  // ── 拇指 / 鈴鐺
  drawCircleBtn(likeC, fillOf(0), popOf(0), ["thumb", "thumbLine"]);
  let bellRot = 0;
  if (T > CLICKS[2]) { const e = T - CLICKS[2]; bellRot = Math.sin(e * 22) * 0.36 * Math.exp(-e * 3.2); }
  drawCircleBtn(bellC, fillOf(2), popOf(2), ["bell", "bellClap"], bellRot);

  drawInkRing(likeC, 0, D / 2);
  drawInkRing(subC, 1, pillH / 2);
  drawInkRing(bellC, 2, D / 2);

  // 墨隱：消失時硃砂往外散成一團墨霧、再淡盡 → 像墨滴入水化開
  if (exitDiff > 0) {
    const cloud = (c: { x: number; y: number }, baseR: number) => {
      const r = baseR * (1 + 2.4 * exitDiff);
      const a = (1 - exitDiff) * 0.5;
      const g = ctx.createRadialGradient(c.x, c.y, r * 0.1, c.x, c.y, r);
      g.addColorStop(0, rgba(red, a));
      g.addColorStop(0.55, rgba(red, a * 0.55));
      g.addColorStop(1, rgba(red, 0));
      ctx.fillStyle = g;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    };
    cloud(likeC, D * 0.5);
    cloud(subC, pillW * 0.4);
    cloud(bellC, D * 0.5);
  }

  // ── 游標墨痕：取最近一段路徑畫漸細漸淡的墨絲（呼應墨流/錦鯉拖墨）。游標做完事先淡出，剩按鈕墨隱。
  const cursorA = loop ? 1 : clamp01(1 - (T - 3.7) / 0.55);
  const cp = cursorAt(T);
  if (cursorA > 0.01) {
    ctx.save();
    ctx.globalAlpha = exitA * cursorA;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const TRN = 9, span = 0.34;
    for (let s = 0; s < TRN; s++) {
      const ta = T - (s / TRN) * span, tb = T - ((s + 1) / TRN) * span;
      if (!loop && tb < 0) break;
      const pa = cursorAt(ta), pb = cursorAt(tb);
      const f = 1 - s / TRN;
      ctx.strokeStyle = rgba(INK, 0.26 * f);
      ctx.lineWidth = D * 0.085 * f;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    ctx.restore();

    // 游標：點擊瞬間壓一下；墨色填 + 宣紙白邊（任何底都看得到）
    let press = 1;
    for (const tc of CLICKS) { const d = Math.abs(T - tc); if (d < 0.13) press = Math.min(press, 1 - 0.24 * (1 - d / 0.13)); }
    const cSize = D * 0.82 * press;
    ctx.save();
    ctx.globalAlpha = exitA * cursorA;
    ctx.translate(cp.x, cp.y);
    const cs = cSize / 24;
    ctx.scale(cs, cs);
    ctx.translate(-4.3, -4.3); // 游標尖(≈4,4)對到點擊點
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 / cs;
    ctx.strokeStyle = PAPERLT;
    ctx.stroke(ctaPath("cursor"));
    ctx.fillStyle = INK;
    ctx.fill(ctaPath("cursor"));
    ctx.restore();
  }

  ctx.restore();
}

/* ── 控制板（lofi 播放器卡）────────────────────────────────────────────────
   雨淋濕整個背景 → 上方圓角矩形專輯窗（窗內＝未壓暗的清晰背景圖＋陰影霓虹光）
   → 右緣半圓窗 + 夾在中間的旋轉唱片（邊緣光、中心墨紅標籤）→ 底部時間軸。
   旋轉/進度全由 composition 時間 t 驅動 → 預覽=錄製=匯出一致。 */
function fmtTime(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
// 模組級暫存：快照「卡下方畫面」當折射來源 + 背景模糊來源（預覽/匯出共用、不並發）
let _snapCanvas: HTMLCanvasElement | null = null;
let _snapCtx: CanvasRenderingContext2D | null = null;
function getPlayerSnap(W: number, H: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  try {
    if (!_snapCanvas) { _snapCanvas = document.createElement("canvas"); _snapCtx = _snapCanvas.getContext("2d"); }
    if (!_snapCtx || !_snapCanvas) return null;
    if (_snapCanvas.width !== W || _snapCanvas.height !== H) { _snapCanvas.width = W; _snapCanvas.height = H; }
    return { canvas: _snapCanvas, ctx: _snapCtx };
  } catch { return null; }
}
function hex01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s || "000000", 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function drawPlayerCard(
  ctx: CanvasRenderingContext2D, bgImg: HTMLImageElement | null,
  cx: number, cy: number, W: number, H: number, scale: number,
  wetColor: string, accent: string, glow: string, wet: number, spin: number,
  t: number, duration: number,
  bgBlur: number, frostBlur: number, refract: number, aberration: number,
) {
  const S = Math.min(W, H);

  // ── 1. 版面（卡片＝左圓角矩形 ∪ 右半圓）──
  const cardW = S * 0.6 * scale, cardH = cardW * 0.5;
  const left = cx - cardW / 2, top = cy - cardH / 2, right = cx + cardW / 2, bottom = cy + cardH / 2;
  const rrL = cardH * 0.16;            // 只圓「左邊」兩角；右邊直角、跟半圓平邊切齊
  const semiR = cardH * 0.5;           // 右側半圓＝跟矩形等高 → 平邊貼齊矩形右緣
  const vinR = cardH * 0.44;           // 唱片半徑（略小於半圓 → 露出一圈半圓邊）
  const vinCx = right, vinCy = cy;
  const fullW = cardW + semiR;
  const cardPath = () => {
    ctx.beginPath();
    ctx.moveTo(left + rrL, top);
    ctx.lineTo(right, top);
    ctx.arc(vinCx, cy, semiR, -Math.PI / 2, Math.PI / 2);   // 右側半圓凸出
    ctx.lineTo(left + rrL, bottom);
    ctx.arcTo(left, bottom, left, bottom - rrL, rrL);         // 左下圓角
    ctx.lineTo(left, top + rrL);
    ctx.arcTo(left, top, left + rrL, top, rrL);               // 左上圓角
    ctx.closePath();
  };

  // ── 2. 快照「卡下方的清晰畫面」（玻璃折射 + 背景模糊共用同一份）──
  const snap = getPlayerSnap(W, H);
  if (snap) { snap.ctx.clearRect(0, 0, W, H); try { snap.ctx.drawImage(ctx.canvas, 0, 0); } catch { /* 同源才可讀 */ } }

  // ── 3. 液態玻璃 pass（WebGL：折射卡下方畫面＋色散＋霜面）；無 WebGL/無快照 → null 走 Canvas2D 霜面 ──
  const glassCanvas = snap ? renderGlass(snap.canvas, W, H, {
    rectCx: cx, rectCy: cy, rectHx: cardW / 2, rectHy: cardH / 2, rrL,
    semiCx: right, semiCy: cy, semiR,
    refract: refract * cardH * 0.13,        // 折射強度 → px
    aberration,
    frost: frostBlur * cardH * 0.06,        // 播放器霜面模糊 → px
    tint: hex01(wetColor), tintAmt: wet, glow: hex01(glow),
  }) : null;

  // ── 4. 背景模糊（把卡下方畫面整片高斯模糊，程度可調）+ 冷色罩 ──
  ctx.save();
  const bgPx = bgBlur * 42;               // 0~1 → 0~42px
  if (snap && bgPx > 0.5) { ctx.filter = `blur(${bgPx}px)`; ctx.drawImage(snap.canvas, 0, 0); ctx.filter = "none"; }
  else if (!snap && bgImg && bgImg.naturalWidth) { // 無快照退路：重畫模糊背景圖
    const cf = coverFit(bgImg.naturalWidth, bgImg.naturalHeight, W, H);
    ctx.filter = `blur(${Math.max(1, bgPx)}px)`; ctx.drawImage(bgImg, cf.dx, cf.dy, cf.dw, cf.dh); ctx.filter = "none";
  }
  ctx.fillStyle = wetColor; ctx.globalAlpha = 0.18 + wet * 0.32; ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // ── 5. 合成玻璃面板 ──
  // 卡下投影（玻璃本體 shader 已含邊框/高光；投影另畫增加浮起感）
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = S * 0.045; ctx.shadowOffsetY = S * 0.012;
  ctx.fillStyle = "#0a0e16"; cardPath(); ctx.fill();   // 被玻璃蓋住，只留卡外投影
  ctx.restore();

  if (glassCanvas) {
    ctx.drawImage(glassCanvas, 0, 0);                  // 液態玻璃（折射＋色散＋霜面＋邊框高光都在 shader）
  } else {
    // Canvas2D 霜面 fallback（無 WebGL）：clip 卡形 → 模糊後快照 + 霜白漸層 + 上緣高光 + 外框
    ctx.save();
    cardPath(); ctx.clip();
    if (snap) { ctx.filter = `blur(${Math.max(2, frostBlur * cardH * 0.06)}px)`; ctx.drawImage(snap.canvas, 0, 0); ctx.filter = "none"; }
    else { ctx.fillStyle = mixHex(wetColor, "#ffffff", 0.4); ctx.fillRect(left, top, fullW, cardH); }
    const fg = ctx.createLinearGradient(0, top, 0, bottom);
    fg.addColorStop(0, "rgba(255,255,255,0.28)"); fg.addColorStop(0.5, "rgba(255,255,255,0.1)"); fg.addColorStop(1, "rgba(255,255,255,0.04)");
    ctx.fillStyle = fg; ctx.fillRect(left, top, fullW, cardH);
    ctx.restore();
    ctx.save();
    cardPath(); ctx.clip();
    const hl = Math.max(1, S * 0.0016);
    ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = hl;
    ctx.beginPath(); ctx.moveTo(left + rrL, top + hl); ctx.lineTo(right, top + hl); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.42)"; ctx.lineWidth = Math.max(1, S * 0.0016); cardPath(); ctx.stroke();
    ctx.globalAlpha = 0.22; ctx.strokeStyle = glow; ctx.lineWidth = Math.max(1, S * 0.001);
    ctx.shadowColor = glow; ctx.shadowBlur = S * 0.025; cardPath(); ctx.stroke();
    ctx.restore();
  }

  // 2c. 唱片（旋轉、邊緣光、中心墨紅標籤）
  const rot = t * spin * Math.PI * 2;
  ctx.save();
  ctx.shadowColor = glow; ctx.shadowBlur = S * 0.02;
  ctx.fillStyle = "#0b0b0e"; ctx.beginPath(); ctx.arc(vinCx, vinCy, vinR, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(vinCx, vinCy); ctx.rotate(rot);
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = Math.max(1, S * 0.0008);
  for (let i = 3; i <= 9; i++) { ctx.beginPath(); ctx.arc(0, 0, vinR * (i / 10), 0, Math.PI * 2); ctx.stroke(); }
  const labR = vinR * 0.4; // 中心墨紅標籤
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(0, 0, labR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = Math.max(1, S * 0.001); ctx.beginPath(); ctx.arc(0, 0, labR, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = Math.max(1, S * 0.0014); // 標籤刻痕（看得出在轉）
  ctx.beginPath(); ctx.moveTo(labR * 0.3, 0); ctx.lineTo(labR * 0.85, 0); ctx.stroke();
  ctx.fillStyle = "#0b0b0e"; ctx.beginPath(); ctx.arc(0, 0, labR * 0.14, 0, Math.PI * 2); ctx.fill(); // 軸孔
  ctx.restore();
  ctx.save(); // 邊緣固定反光弧（不轉）
  ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = Math.max(1.2, S * 0.0016);
  ctx.beginPath(); ctx.arc(vinCx, vinCy, vinR * 0.97, -Math.PI * 0.8, -Math.PI * 0.35); ctx.stroke();
  ctx.restore();

  // ── 3. 時間軸（卡下方）──
  const axisY = bottom + cardH * 0.42, axisL = left, axisR = right + vinR;
  const prog = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
  const hx = axisL + (axisR - axisL) * prog;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = Math.max(2, S * 0.003);
  ctx.beginPath(); ctx.moveTo(axisL, axisY); ctx.lineTo(axisR, axisY); ctx.stroke();
  ctx.strokeStyle = accent; ctx.lineWidth = Math.max(2, S * 0.0034);
  ctx.beginPath(); ctx.moveTo(axisL, axisY); ctx.lineTo(hx, axisY); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(hx, axisY, Math.max(3, S * 0.005), 0, Math.PI * 2); ctx.fill();
  const fs = Math.max(10, S * 0.022);
  ctx.font = `600 ${fs}px system-ui, sans-serif`; ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.textAlign = "left"; ctx.fillText(fmtTime(t), axisL, axisY + fs * 1.4);
  ctx.textAlign = "right"; ctx.fillText(fmtTime(duration), axisR, axisY + fs * 1.4);
  ctx.restore();
}

// 控制板畫成「單層」：給渲染迴圈照圖層 z 序、跟 GPU 特效交錯呼叫（不再塞在 overlay pass 一起畫）。
// → 排在控制板下面的特效會被它的背景模糊/折射吃到（當背景）；排在它上面的特效在它之後才畫＝保持清晰。
export function drawPlayerLayer(
  ctx: CanvasRenderingContext2D, layer: Layer, comp: Composition, cache: MediaCache,
  t: number, duration: number, W: number, H: number,
) {
  if (layer.type !== "player" || !isLayerActive(layer, t, duration)) return;
  const tf = layer.transform ?? { x: 0.5, y: 0.5, scale: 1 };
  const pp = layer.params;
  const bgImg = getBackgroundImage(comp, cache, t, duration);
  drawPlayerCard(ctx, bgImg, tf.x * W, tf.y * H, W, H, tf.scale, pp.wetColor, pp.accent, pp.glow, pp.wet, pp.spin, t, duration,
    pp.bgBlur ?? 0.6, pp.frostBlur ?? 0.4, pp.refract ?? 0.6, pp.aberration ?? 0.5);
}

// 透明度層：在區域（或整張）疊一層色，不透明度跟音樂跳動 → 底下的圖閃動。beat 模式吃 beatEnv、shimmer 連續正弦。
export function drawAlphaLayer(
  ctx: CanvasRenderingContext2D, layer: Layer, t: number, duration: number,
  beatEnv: number, time: number, W: number, H: number,
) {
  if (layer.type !== "alpha" || !isLayerActive(layer, t, duration)) return;
  const p = layer.params as AlphaParams;
  const tf = layer.transform;
  const lw = (tf?.w ?? 1) * W, lh = (tf?.h ?? 1) * H;
  const lx = (tf?.x ?? 0.5) * W - lw / 2, ly = (tf?.y ?? 0.5) * H - lh / 2;
  const pulse = p.mode === "shimmer" ? 0.5 + 0.5 * Math.sin(time * (p.speed ?? 6)) : beatEnv;
  const a = Math.min(1, (p.base ?? 0) + (p.intensity ?? 0.6) * pulse);
  if (a <= 0.002) return;
  ctx.save();
  const rot = ((tf?.rot ?? 0) * Math.PI) / 180; // 繞框中心旋轉
  if (rot) { const cx = (tf?.x ?? 0.5) * W, cy = (tf?.y ?? 0.5) * H; ctx.translate(cx, cy); ctx.rotate(rot); ctx.translate(-cx, -cy); }
  ctx.globalAlpha = a;
  ctx.fillStyle = p.color ?? "#000000";
  ctx.fillRect(lx, ly, lw, lh);
  ctx.restore();
}

// 疊加層：圖片 Logo / 影片 / 文字 / 落款 / CTA，依 z 序（陣列順序）畫在最上。位置=transform 中心比例，大小=scale。
//   （控制板已抽成 drawPlayerLayer，由渲染迴圈跟特效交錯畫 → 此處不再畫 player）
// offVideos：離線渲染專用。呼叫端已把每個在場影片「逐幀 seek」好、放進這個 map（key=layer.id）。
//   給了就用 map 裡的元素同步畫影片（照 z 序內嵌、不再另外抽出去畫最上）；不給=即時預覽，用 syncVideo 跟播放對齊。
export function drawOverlayLayers(
  ctx: CanvasRenderingContext2D, comp: Composition, cache: MediaCache,
  t: number, duration: number, W: number, H: number, playing = false,
  offVideos?: Map<string, HTMLVideoElement> | null,
) {
  // 自動讓位：場上只要有「可見、在時段內、有字」的自訂落款，品牌章就隱藏（換成使用者自己的章）。
  const hasCustomSeal = comp.some(
    (l) => l.type === "seal" && l.visible && (l.params.mode ?? "brand") === "custom"
      && l.params.text.trim().length > 0 && isLayerActive(l, t, duration),
  );
  for (const layer of comp) {
    if (layer.type !== "image" && layer.type !== "video" && layer.type !== "text" && layer.type !== "seal" && layer.type !== "cta") continue;
    if (!isLayerActive(layer, t, duration)) continue;
    const tf = layer.transform ?? { x: 0.5, y: 0.5, scale: 1 };
    const cx = tf.x * W, cy = tf.y * H;

    if (layer.type === "image") {
      if (!layer.params.dataUrl) continue;
      const img = getImage(cache, layer.id, layer.params.dataUrl);
      if (!img) continue;
      const dw = tf.scale * W;
      const dh = dw * (img.naturalHeight / img.naturalWidth);
      ctx.save();
      ctx.globalAlpha = layer.params.opacity;
      ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    } else if (layer.type === "video") {
      if (!layer.params.src) continue;
      const startSec = layer.timing?.start ?? 0; // 片頭通常 start=0，跟著時間軸對齊
      // 離線：用呼叫端已 seek 好的元素（同步畫）；即時預覽：syncVideo 跟播放對齊。兩條都走同一段 z 序內嵌繪製。
      const vid = offVideos ? (offVideos.get(layer.id) ?? null) : syncVideo(cache, layer.id, layer.params.src, layer.params.loop, startSec, t, playing);
      if (!vid || vid.videoWidth === 0) continue;
      const vt = t - startSec;
      if (vt < 0) continue; // 還沒輪到它出現
      const ended = !layer.params.loop && vt > vid.duration; // 播一次且已播完
      if (ended && layer.params.mode === "intro") continue;   // 片頭播完 → 不畫，露出底下主視覺
      ctx.save();
      if (layer.params.blend === "screen") ctx.globalCompositeOperation = "screen"; // 黑底去背
      if (layer.params.mode === "intro") {
        // 片頭：cover 尺寸 × scale（scale=1 滿版、可縮小），置中於 transform 位置
        const cf = coverFit(vid.videoWidth, vid.videoHeight, W, H);
        const dw = cf.dw * tf.scale, dh = cf.dh * tf.scale;
        ctx.drawImage(vid, cx - dw / 2, cy - dh / 2, dw, dh);
      } else {
        const dw = tf.scale * W; // 角落小窗：依 transform 位置 + 大小（播完停在最後一幀）
        const dh = dw * (vid.videoHeight / vid.videoWidth);
        ctx.drawImage(vid, cx - dw / 2, cy - dh / 2, dw, dh);
      }
      ctx.restore();
    } else if (layer.type === "text") {
      const text = layer.params.content;
      if (!text) continue;
      const px = Math.max(8, tf.scale * 0.08 * H);
      ctx.font = `${px}px ${fontFamily(layer.params.fontId)}`;
      drawAnimText(ctx, text, cx, cy, px, layer.params.color, textFxList(layer.params), layer.params.anim, layer.timing?.start ?? 0, t, layer.params.lineMode ?? "both");
    } else if (layer.type === "seal") {
      const sp = layer.params;
      if ((sp.mode ?? "brand") === "custom") {
        // 使用者自訂落款：直書印文 + 站上自帶字型（授權乾淨，不碰劍豪體）。
        drawCustomSeal(ctx, sp.text, sp.fontId, sp.sealColor, sp.textColor, sp.opacity, cx, cy, W, H, tf.scale);
      } else {
        // 「九墨」品牌印章圖（劍豪體已烤進 PNG，不外送字體檔）。場上有自訂落款時自動讓位。
        if (hasCustomSeal) continue;
        const img = getImage(cache, layer.id, "/seal-jiumo.png?v=2");
        if (!img || img.naturalWidth === 0) continue;
        const dh = Math.min(W, H) * 0.21 * tf.scale; // 圖含全形上下空格較高 → 提高渲染高度讓字維持大小
        const dw = dh * (img.naturalWidth / img.naturalHeight);
        ctx.save();
        ctx.globalAlpha = sp.opacity;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        ctx.restore();
      }
    } else if (layer.type === "cta") {
      const localT = t - (layer.timing?.start ?? 0);
      if (localT < 0) continue;
      drawCta(ctx, cx, cy, W, H, tf.scale, layer.params.color, localT, layer.params.loop);
    }
  }
}

// 多組 LRC：每個有自帶 lines 的歌詞層，畫它的「當前句」在自己的 transform、用自己的字型/特效/顏色。
//   lines 空的歌詞層 = 主卷軸（由 studio 的 LyricScroller 畫），不在此處理。
export function drawLyricsLayers(
  ctx: CanvasRenderingContext2D, comp: Composition, t: number, duration: number, W: number, H: number,
) {
  for (const layer of comp) {
    if (layer.type !== "lyrics" || !isLayerActive(layer, t, duration)) continue;
    const p = layer.params;
    if (!p.lines || p.lines.length === 0) continue;
    const line = currentLyric(p.lines, t);
    if (!line || !line.text) continue;
    const tf = layer.transform ?? { x: 0.5, y: 0.5, scale: 1 };
    const cx = tf.x * W, cy = tf.y * H;
    const px = Math.max(10, tf.scale * 0.06 * H);
    ctx.font = `${px}px ${fontFamily(p.fontId)}`;
    // 進場以「當前句的時間戳」起算 → 每換一句重新觸發動畫
    drawAnimText(ctx, line.text, cx, cy, px, p.color, textFxList(p), p.anim, line.t, t, p.lineMode ?? "both");
  }
}
