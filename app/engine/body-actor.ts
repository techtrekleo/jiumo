// 九墨活體 v3：本體 = 清晰 overlay（畫在流體之上、永不糊）
// 游動 = 路徑巡游 + 頭朝運動方向 + 分條波動（頭穩尾擺）
// 墨線 = 尾/鰭錨點在墨場留點、本體游走 → 流場把點串拉成拖曳飄帶

import { FluidCore } from "./fluid-core";
import { toInk, type Palette, type PaperMode, type RGB } from "./palette";

export type BodyParams = {
  x: number; y: number; size: number; amount: number;
  wiggle: number; drift: boolean; pulse: boolean;
};

type AudioLike = { bassSpike: boolean };

// 泛用墨線錨點（stamp uv、頭朝上座標系）：尾巴 + 兩側鰭
const ANCHORS: { ax: number; ay: number; w: number }[] = [
  { ax: 0.5, ay: 0.84, w: 1.0 },
  { ax: 0.3, ay: 0.58, w: 0.45 },
  { ax: 0.7, ay: 0.58, w: 0.45 },
];

const STRIPS = 14;

// 顏色加深/提亮：amt < 0 加深、amt > 0 往白提亮（立體墨的濃淡用）
function shade(hex: string, amt: number): string {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const f = (i: number) => {
    let x = parseInt(v.slice(i, i + 2), 16);
    x = amt < 0 ? x * (1 + amt) : x + (255 - x) * amt;
    return Math.max(0, Math.min(255, Math.round(x)));
  };
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(f(0))}${to2(f(2))}${to2(f(4))}`;
}

// 圖正規化：白底黑圖 / 透明底黑圖統一成「黑形 + alpha = 形狀」
// shape = alpha × 暗度（白→透明、黑→實心），跟流體引擎的 stamp 邏輯一致
function normalizeStamp(src: HTMLCanvasElement): HTMLCanvasElement {
  const S = src.width;
  const out = document.createElement("canvas");
  out.width = S; out.height = S;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 765;
    const a = d[i + 3] / 255;
    const shape = a * (1 - lum);
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round(shape * 255);
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export class BodyActor {
  private stamp: HTMLCanvasElement;
  private tinted: HTMLCanvasElement;
  x: number; y: number;
  private heading = -Math.PI / 2; // canvas 座標、初始朝上
  private phase = Math.random() * 10;
  private speedPulse = 0;
  private pathT = Math.random() * 100;
  private vx = 0; private vy = 0; // uv/秒

  constructor(stamp: HTMLCanvasElement, initX: number, initY: number) {
    this.stamp = normalizeStamp(stamp);
    this.tinted = document.createElement("canvas");
    this.tinted.width = stamp.width;
    this.tinted.height = stamp.height;
    this.x = initX; this.y = initY;
    this.setTint("#26221f");
  }

  // 形狀著色層：把 stamp 內縮 inset、模糊 blurPx、填成 color，回傳離屏圖
  // 立體墨用的零件 —— 不同 inset/色階疊起來就是「邊緣濃、中心淡」的厚度
  private buildLayer(color: string, inset: number, blurPx: number): HTMLCanvasElement {
    const S = this.stamp.width;
    const cv = document.createElement("canvas");
    cv.width = S; cv.height = S;
    const c = cv.getContext("2d")!;
    if (blurPx > 0) c.filter = `blur(${blurPx}px)`;
    c.drawImage(this.stamp, inset, inset, S - inset * 2, S - inset * 2);
    c.filter = "none";
    c.globalCompositeOperation = "source-in";
    c.fillStyle = color;
    c.fillRect(0, 0, S, S);
    return cv;
  }

  // 本體上色 + 立體墨厚度（跟調色盤主色走、夜紙選亮色就亮）
  // 徑向「邊緣濃、中心淡」模擬墨在邊緣堆積的厚度；中心受光略偏上 → draw 旋轉後落在頭朝向（迎光）
  setTint(hex: string) {
    const S = this.stamp.width;
    const c = this.tinted.getContext("2d")!;
    c.clearRect(0, 0, S, S);
    c.globalCompositeOperation = "source-over";
    c.filter = "none";
    // 底：整形濃墨（邊緣厚度色）
    c.drawImage(this.buildLayer(shade(hex, -0.42), 0, 0), 0, 0);
    // 中心受光：基礎色、內縮 + 柔邊，略往上偏；source-atop 裁進形狀內、底部留濃墨當背光厚度
    c.globalCompositeOperation = "source-atop";
    c.drawImage(this.buildLayer(hex, Math.round(S * 0.13), Math.round(S * 0.06)), 0, -Math.round(S * 0.05));
    // 高光：極淡提亮一小團、更靠頭側，給一點墨體的圓潤反光
    c.drawImage(this.buildLayer(shade(hex, 0.16), Math.round(S * 0.3), Math.round(S * 0.05)), 0, -Math.round(S * 0.1));
    c.globalCompositeOperation = "source-over";
  }

  update(dt: number, audio: AudioLike, p: BodyParams) {
    this.phase += dt * (2.6 + this.speedPulse * 7) * (0.4 + p.wiggle * 1.2);
    if (p.pulse && audio.bassSpike) this.speedPulse = 1;
    this.speedPulse *= Math.pow(0.4, dt);
    const px = this.x, py = this.y;
    if (p.drift) {
      this.pathT += dt * (0.14 + this.speedPulse * 0.4);
      const nx = p.x + 0.2 * Math.sin(this.pathT * 0.7) * Math.sin(this.pathT * 0.23 + 1);
      const ny = p.y + 0.16 * Math.sin(this.pathT * 1.13 + 1.3);
      const dx = (nx - px), dy = (ny - py);
      if (Math.hypot(dx, dy) > 1e-6) {
        // canvas 座標 y 向下 → dyCanvas = -dy(uv)
        const target = Math.atan2(-dy, dx);
        let dh = target - this.heading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        this.heading += dh * Math.min(1, dt * 2.4);
      }
      this.x = nx; this.y = ny;
      this.vx = dx / Math.max(dt, 1e-4);
      this.vy = dy / Math.max(dt, 1e-4);
    } else {
      this.x = p.x; this.y = p.y;
      this.vx = this.vy = 0;
    }
  }

  private stripOffset(t: number, ampPx: number): number {
    // t: 0 頭 → 1 尾；尾端擺幅大、頭穩
    return Math.sin(this.phase - t * 2.8) * ampPx * (0.12 + t * 0.88);
  }

  // 本體繪製：旋轉朝向 + 分條波動
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, p: BodyParams) {
    const sizePx = p.size * H;
    const S = this.stamp.width;
    const strip = S / STRIPS;
    const amp = p.wiggle * sizePx * 0.085;
    ctx.save();
    ctx.translate(this.x * W, (1 - this.y) * H);
    ctx.rotate(this.heading + Math.PI / 2);
    const breathe = 1 + 0.03 * Math.sin(this.phase * 0.6) + this.speedPulse * 0.05;
    ctx.scale(breathe, breathe);
    ctx.globalAlpha = 0.88;
    for (let i = 0; i < STRIPS; i++) {
      const t = i / (STRIPS - 1);
      const off = this.stripOffset(t, amp);
      ctx.drawImage(
        this.tinted,
        0, i * strip, S, strip,
        -sizePx / 2 + off, -sizePx / 2 + t * sizePx * ((STRIPS - 1) / STRIPS), sizePx, sizePx / STRIPS + 0.8,
      );
    }
    ctx.restore();
  }

  // 錨點轉世界座標（uv）
  private anchorUv(ax: number, ay: number, p: BodyParams, W: number, H: number): [number, number] {
    const sizePx = p.size * H;
    const amp = p.wiggle * sizePx * 0.085;
    const lx = (ax - 0.5) * sizePx + this.stripOffset(ay, amp);
    const ly = (ay - 0.5) * sizePx;
    const r = this.heading + Math.PI / 2;
    const wx = lx * Math.cos(r) - ly * Math.sin(r);
    const wy = lx * Math.sin(r) + ly * Math.cos(r);
    const X = this.x * W + wx;
    const Y = (1 - this.y) * H + wy;
    return [X / W, 1 - Y / H];
  }

  // 墨線：錨點留墨 + 微微繼承反向速度讓線飄
  emitInk(core: FluidCore, palette: Palette, paperMode: PaperMode, p: BodyParams, dt: number, W: number, H: number) {
    const col: RGB = toInk(palette.primary, paperMode);
    const moving = Math.hypot(this.vx, this.vy) > 0.004;
    if (p.drift && moving) {
      // 煙縷感：極細、半透明、幾乎不攪動 — 線由本體游走自然留下、流場輕拉成絲
      const dose = p.amount * dt * 5;
      for (const a of ANCHORS) {
        const [ux, uy] = this.anchorUv(a.ax, a.ay, p, W, H);
        core.splatDye(ux, uy, [col[0] * dose * a.w, col[1] * dose * a.w, col[2] * dose * a.w], FluidCore.SPLAT_RADIUS * 0.16, 1.0);
      }
      const [tx, ty] = this.anchorUv(ANCHORS[0].ax, ANCHORS[0].ay, p, W, H);
      core.splatVel(tx, ty, -this.vx * 3.5, -this.vy * 3.5, FluidCore.SPLAT_RADIUS * 0.5);
    } else if (!p.drift) {
      // 靜物（月）：邊緣雲 — 沿邊隨機點微量滲墨、讓流場去暈
      if (Math.random() < dt * 9) {
        const ang = Math.random() * Math.PI * 2;
        const rr = 0.36 + Math.random() * 0.1;
        const [ux, uy] = this.anchorUv(0.5 + Math.cos(ang) * rr, 0.5 + Math.sin(ang) * rr, p, W, H);
        const dose = p.amount * 0.35;
        core.splatDye(ux, uy, [col[0] * dose, col[1] * dose, col[2] * dose], FluidCore.SPLAT_RADIUS * (0.8 + Math.random() * 1.6), 1.0);
      }
    }
  }
}
