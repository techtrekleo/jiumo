// 九墨內建墨體庫：程序化剪影（Canvas2D 繪製、黑形透明底）
// 各自帶建議參數：月不漂移、水母大活性高律動、錦鯉飄尾、龍蜿蜒

export type BodyPreset = {
  id: string;
  name: string;
  defaults: { size: number; wiggle: number; drift: boolean; pulse: boolean; amount: number };
  draw: (ctx: CanvasRenderingContext2D, S: number) => void;
};

const INK = "#0a0808";

/* 漸細曲線（觸手/鬚）：沿 quadratic 路徑疊圓、半徑遞減 */
function taperedCurve(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
  w0: number, w1: number,
) {
  const N = 26;
  ctx.fillStyle = INK;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    const r = (w0 + (w1 - w0) * t) / 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ── 墨水母：鐘形傘 + 裙緣 + 六條垂墜觸手 ── */
function drawJellyfish(ctx: CanvasRenderingContext2D, S: number) {
  const k = S / 512;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = INK;
  // 傘
  ctx.beginPath();
  ctx.moveTo(116, 240);
  ctx.bezierCurveTo(110, 90, 402, 90, 396, 240);
  // 傘底緣波浪
  ctx.bezierCurveTo(370, 222, 350, 224, 326, 240);
  ctx.bezierCurveTo(302, 224, 280, 224, 256, 240);
  ctx.bezierCurveTo(232, 224, 210, 224, 186, 240);
  ctx.bezierCurveTo(162, 224, 142, 222, 116, 240);
  ctx.closePath();
  ctx.fill();
  // 口腕（中間兩條粗、帶褶）
  taperedCurve(ctx, 226, 238, 196, 330, 232, 460, 18, 4);
  taperedCurve(ctx, 286, 238, 318, 340, 274, 470, 18, 4);
  // 細觸手四條
  taperedCurve(ctx, 150, 236, 128, 330, 158, 430, 8, 1.6);
  taperedCurve(ctx, 196, 240, 178, 350, 206, 488, 7, 1.4);
  taperedCurve(ctx, 318, 240, 342, 350, 312, 492, 7, 1.4);
  taperedCurve(ctx, 362, 236, 386, 320, 356, 424, 8, 1.6);
  ctx.restore();
}

/* ── 墨錦鯉：俯視金魚 — 圓頭錐身 + 大飄帶尾 ── */
function drawKoi(ctx: CanvasRenderingContext2D, S: number) {
  const k = S / 512;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = INK;
  // 頭 + 身（淚滴）
  ctx.beginPath();
  ctx.moveTo(256, 58);
  ctx.bezierCurveTo(330, 62, 344, 150, 318, 218);
  ctx.bezierCurveTo(300, 268, 276, 296, 262, 318);
  ctx.lineTo(250, 318);
  ctx.bezierCurveTo(236, 296, 212, 268, 194, 218);
  ctx.bezierCurveTo(168, 150, 182, 62, 256, 58);
  ctx.closePath();
  ctx.fill();
  // 胸鰭
  ctx.beginPath();
  ctx.moveTo(186, 150);
  ctx.quadraticCurveTo(130, 168, 122, 218);
  ctx.quadraticCurveTo(168, 212, 196, 184);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(326, 150);
  ctx.quadraticCurveTo(382, 168, 390, 218);
  ctx.quadraticCurveTo(344, 212, 316, 184);
  ctx.closePath();
  ctx.fill();
  // 尾鰭：三片飄帶
  ctx.beginPath();
  ctx.moveTo(250, 312);
  ctx.bezierCurveTo(210, 370, 150, 396, 128, 472);
  ctx.bezierCurveTo(170, 452, 204, 452, 232, 396);
  ctx.bezierCurveTo(240, 372, 248, 344, 252, 326);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(262, 312);
  ctx.bezierCurveTo(298, 374, 356, 400, 376, 478);
  ctx.bezierCurveTo(336, 458, 304, 458, 278, 398);
  ctx.bezierCurveTo(268, 372, 262, 344, 258, 326);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(252, 320);
  ctx.bezierCurveTo(244, 380, 250, 420, 256, 462);
  ctx.bezierCurveTo(262, 420, 268, 380, 260, 320);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ── 墨龍：S 形蜿蜒軀幹 + 角鬚爪 ── */
function drawDragon(ctx: CanvasRenderingContext2D, S: number) {
  const k = S / 512;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = INK;
  // 軀幹：沿 S 路徑疊圓、半徑遞減
  const pts: [number, number][] = [
    [368, 110], [322, 148], [300, 204], [330, 258], [296, 312],
    [228, 330], [168, 300], [128, 338], [136, 402], [196, 446], [262, 462],
  ];
  for (let seg = 0; seg < pts.length - 1; seg++) {
    const [x0, y0] = pts[seg];
    const [x1, y1] = pts[seg + 1];
    const r0 = 30 - (seg / (pts.length - 1)) * 22;
    const r1 = 30 - ((seg + 1) / (pts.length - 1)) * 22;
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      ctx.beginPath();
      ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r0 + (r1 - r0) * t, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 頭
  ctx.beginPath();
  ctx.ellipse(382, 102, 40, 28, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // 吻
  ctx.beginPath();
  ctx.moveTo(404, 76);
  ctx.quadraticCurveTo(452, 56, 466, 70);
  ctx.quadraticCurveTo(446, 84, 414, 96);
  ctx.closePath();
  ctx.fill();
  // 雙角（後掠細長）
  taperedCurve(ctx, 372, 80, 330, 36, 300, 18, 10, 1.5);
  taperedCurve(ctx, 392, 74, 368, 26, 348, 8, 10, 1.5);
  // 鬚
  taperedCurve(ctx, 440, 80, 480, 110, 462, 152, 4, 0.8);
  taperedCurve(ctx, 430, 92, 466, 132, 442, 176, 4, 0.8);
  // 背鰭小三角
  const finT = [0.12, 0.24, 0.38, 0.52, 0.66];
  for (const ft of finT) {
    const idx = Math.floor(ft * (pts.length - 1));
    const [fx, fy] = pts[idx];
    ctx.beginPath();
    ctx.moveTo(fx - 8, fy - 18);
    ctx.lineTo(fx + 2, fy - 44);
    ctx.lineTo(fx + 12, fy - 16);
    ctx.closePath();
    ctx.fill();
  }
  // 前爪
  taperedCurve(ctx, 318, 230, 350, 270, 378, 262, 10, 2);
  taperedCurve(ctx, 290, 310, 282, 360, 312, 380, 10, 2);
  ctx.restore();
}

/* ── 墨月：月牙 ── */
function drawMoon(ctx: CanvasRenderingContext2D, S: number) {
  const k = S / 512;
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(256, 256, 184, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(338, 212, 178, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export const BODY_PRESETS: BodyPreset[] = [
  { id: "jellyfish", name: "墨水母", defaults: { size: 0.45, wiggle: 0.6, drift: true, pulse: true, amount: 1 }, draw: drawJellyfish },
  { id: "koi", name: "墨錦鯉", defaults: { size: 0.42, wiggle: 0.7, drift: true, pulse: true, amount: 1 }, draw: drawKoi },
  { id: "dragon", name: "墨龍", defaults: { size: 0.55, wiggle: 0.45, drift: true, pulse: true, amount: 1 }, draw: drawDragon },
  { id: "moon", name: "墨月", defaults: { size: 0.5, wiggle: 0.12, drift: false, pulse: false, amount: 1.1 }, draw: drawMoon },
];

export function makeBodyCanvas(preset: BodyPreset, S = 512): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  preset.draw(ctx, S);
  return c;
}
