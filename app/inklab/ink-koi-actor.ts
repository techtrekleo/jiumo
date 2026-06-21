// 墨錦鯉 studio 接口：用 InkCreature 的 spine + 暈染 + 鰭 + 飄尾，
// 但對外維持 BodyActor 的介面（constructor / setTint / update / emitInk / draw），
// 讓 studio 與 offline 能無痛抽換。運動繞著 bodyParams.x/y 游、尾巴往流體場拖墨。

import { Marrow, InkRenderer } from "./ink-creature";
import { FluidCore } from "../engine/fluid-core";
import { toInk, type Palette, type PaperMode, type RGB } from "../engine/palette";
import type { BodyParams } from "../engine/body-actor";

type AudioLike = { bassSpike: boolean };

export class InkKoiActor {
  private marrow: Marrow;
  private ink = new InkRenderer();
  private w = 1280;
  private h = 720;
  private curSize: number;
  private pulse = 0;
  private night = false;
  x: number; y: number; // uv（相容欄位，studio 不直接用）

  // 第一參數收 stamp 只為跟 BodyActor 簽名一致；錦鯉是程序生成、用不到
  constructor(_stamp: HTMLCanvasElement | null, initX: number, initY: number) {
    this.x = initX; this.y = initY;
    this.curSize = 0.42;
    this.marrow = this.makeMarrow(this.curSize, initX * this.w, (1 - initY) * this.h);
  }

  private makeMarrow(size: number, px: number, py: number): Marrow {
    const L = size * this.h; // 身長基準（跟 BodyActor 的 sizePx = size*H 同基準）
    const bodyCount = 20;
    const bodyLen = L * 0.95, tailLen = L * 0.85;
    const m = new Marrow({
      bodyCount, segLen: bodyLen / bodyCount, bodyWidth: L * 0.12,
      tailCount: 5, tailNodes: 18, tailLen,
      maxSpeed: L * 0.42, x: px, y: py,
    });
    m.steady = true; // 恆定游速，一放進去就維持、不時快時慢
    return m;
  }

  // 墨錦鯉不跟調色盤主色變（保持牠自己的錦鯉配色）
  setTint(_hex: string) {}
  // 錦鯉配色（黑白橘黃紅可混搭）；傳 null/空＝純墨黑水墨
  setColors(keys: string[] | null) { this.ink.setColors(keys); }

  update(dt: number, audio: AudioLike, p: BodyParams) {
    dt = Math.min(0.05, dt); // 防卡頓時 dt 暴衝 → spine 一次位移過大而劇烈抖動
    if (Math.abs(p.size - this.curSize) > 0.002) {
      this.curSize = p.size;
      const head = this.marrow.head;
      this.marrow = this.makeMarrow(p.size, head.x, head.y);
    }
    if (p.pulse && audio.bassSpike) this.pulse = 1;
    this.pulse *= Math.pow(0.4, dt);
    const L = this.curSize * this.h;
    // 繞著「水平/垂直」設定的家 (p.x,p.y) 游，超出 roam 半徑就柔轉回來 → 位置滑桿真的會動牠、也不會亂飄到右邊。
    // drift 關時慢游但仍移動（避免原地行波抖）、roam 收窄 → 幾乎定點呼吸。
    this.marrow.maxSpeed = (p.drift ? L * 0.42 : L * 0.12) * (1 + this.pulse * 0.8);
    const cx = p.x * this.w, cy = (1 - p.y) * this.h; // uv → 畫布座標（y 反向）
    // 游動半徑放大很多 → 幾乎整個畫面隨意游（home 只當很弱的重心、跑超遠才柔拉回）；
    // 靠牆有獨立避讓（見 Marrow），不會貼牆。drift 關才收成幾乎定點。
    const roam = L * (p.drift ? 2.3 : 0.3);
    this.marrow.step(dt, { w: this.w, h: this.h, cx, cy, roam });
    this.x = this.marrow.head.x / this.w;
    this.y = 1 - this.marrow.head.y / this.h;
  }

  emitInk(core: FluidCore, palette: Palette, paperMode: PaperMode, p: BodyParams, dt: number, W: number, H: number) {
    this.night = paperMode === "night";
    const col: RGB = toInk(palette.primary, paperMode);
    const tail = this.marrow.tailRoot;
    const ux = tail.x / W, uy = 1 - tail.y / H;
    const dose = p.amount * dt * 5;
    core.splatDye(ux, uy, [col[0] * dose, col[1] * dose, col[2] * dose], FluidCore.SPLAT_RADIUS * 0.5, 1.0);
    // 尾巴往後（前進反方向）推墨，讓拖墨線飄起來
    const head = this.marrow.head;
    const bx = tail.x - head.x, by = tail.y - head.y;
    const len = Math.hypot(bx, by) || 1;
    const sp = this.marrow.speed;
    // 只輕推墨痕往後飄；灌太強會在墨滴/墨暈等強攪動 effect 下把拖墨翻騰得很躁
    core.splatVel(ux, uy, (bx / len) * sp / W * 0.7, -(by / len) * sp / H * 0.7, FluidCore.SPLAT_RADIUS * 0.5);
  }

  draw(ctx: CanvasRenderingContext2D, W: number, H: number, _p: BodyParams) {
    this.w = W; this.h = H;
    // TODO 夜紙(this.night)：深墨在深底看不見，待 InkRenderer 支援亮墨模式再處理
    this.ink.draw(ctx, this.marrow, 5);
  }
}
