// 水墨生物框架 InkCreature — 純 Canvas 2D、自包含、可重用
// 設計哲學：把「算」和「畫」徹底分開，換生物只換配置不改引擎
//   Marrow  骨架物理：算身體主鏈（head trail 等弧長取樣）+ 尾飄帶（多縷正弦行波）
//   InkRenderer 墨色暈染：吃節點鏈畫本體，不算
//   TraceField  尾跡粒子：尾根釋放、變大淡出
//   InkStage    Canvas 環境：宣紙底 + 殘影 fade 擦除
// 資料流：update(dt) → Marrow.step → Trace.emit/step；draw → Trace → Ink

export type Vec = { x: number; y: number };
export type InkNode = { x: number; y: number; dir: number; width: number };
export type Env = { w: number; h: number; cx?: number; cy?: number; roam?: number; flow?: (x: number, y: number) => Vec };

// 平滑偽噪聲：多八度正弦疊加，週期不可公約 → 不重複、平滑無折角（取代 Perlin 給尋路用）
function fnoise(x: number): number {
  return (Math.sin(x) + Math.sin(x * 2.13 + 1.3) * 0.5 + Math.sin(x * 4.07 + 2.7) * 0.25) / 1.75;
}
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function dist(a: Vec, b: Vec) { return Math.hypot(a.x - b.x, a.y - b.y); }

// ── 錦鯉純色：墨色／白色／金色／銀色（單選一色；金銀帶金屬光澤）──
export const KOI_COLOR_LIST: { key: string; label: string; hex: string }[] = [
  { key: "ink", label: "墨色", hex: "#1a1512" },
  { key: "white", label: "白色", hex: "#efe9df" },
  { key: "gold", label: "金色", hex: "#c89a38" },
  { key: "silver", label: "銀色", hex: "#b3b9c1" },
];
// 每色的 底色／受光高光／暗邊（金銀光差大＝金屬感；墨白較內斂）
const KOI_SOLID: Record<string, { base: string; light: string; dark: string }> = {
  ink:    { base: "#1a1512", light: "#403930", dark: "#0b0908" },
  white:  { base: "#efe9df", light: "#fdfbf6", dark: "#cfc7b8" },
  gold:   { base: "#c89a38", light: "#f1d985", dark: "#7c5c1d" },
  silver: { base: "#b3b9c1", light: "#edf0f5", dark: "#767c86" },
};
const KOI_HEX: Record<string, string> = Object.fromEntries(KOI_COLOR_LIST.map((c) => [c.key, c.hex]));
function hx2rgb(h: string): [number, number, number] { const s = h.replace("#", ""); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; }
function koiShade(h: string, amt: number): string {
  const [r, g, b] = hx2rgb(h);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  const t2 = (v: number) => f(v).toString(16).padStart(2, "0");
  return "#" + t2(r) + t2(g) + t2(b);
}
function koiRgba(h: string, a: number): string { const [r, g, b] = hx2rgb(h); return `rgba(${r},${g},${b},${a})`; }

// 魚身寬度輪廓（半寬比例）：圓頭 → 頸微收 → 身最寬 → 尾根收（雙峰，不套圓形）
const BODY_PROFILE: [number, number][] = [[0, 0.24], [0.12, 0.5], [0.28, 0.54], [0.45, 0.8], [0.58, 0.78], [0.78, 0.54], [1, 0.32]];
function bodyProfile(t: number): number {
  for (let i = 0; i < BODY_PROFILE.length - 1; i++) {
    const [t0, v0] = BODY_PROFILE[i], [t1, v1] = BODY_PROFILE[i + 1];
    if (t <= t1) {
      const lt = (t - t0) / (t1 - t0);
      return lerp(v0, v1, lt * lt * (3 - 2 * lt)); // smoothstep：控制點處斜率連續＝無稜角
    }
  }
  return BODY_PROFILE[BODY_PROFILE.length - 1][1];
}

// ───────────────────────────────────────────────────────────
// Marrow：骨架物理（身體主鏈 + 尾飄帶）
// ───────────────────────────────────────────────────────────
export type MarrowOpts = {
  bodyCount: number;  // 身體節點數（頭→尾根）
  segLen: number;     // 身體節點間弧長
  bodyWidth: number;  // 身體峰值半寬
  tailCount: number;  // 尾飄帶條數
  tailNodes: number;  // 每條飄帶節點數
  tailLen: number;    // 飄帶總長 px
  maxSpeed: number;   // 最大游速 px/s
  x: number; y: number;
};

export class Marrow {
  body: InkNode[] = [];
  tails: InkNode[][] = [];
  fins: InkNode[][] = [];
  speed = 0;
  speedNorm = 0;
  maxSpeed: number;
  steady = false; // true＝恆定游速（不 fnoise 變速），studio 錦鯉用
  private trail: Vec[] = [];
  private hx: number; private hy: number; private hdir: number;
  private t = 0;
  private seed = Math.random() * 1000;
  private turnRate = 0; // 轉向率（有阻尼隨機漫步 → 路徑每次都不同、不重複）
  private o: MarrowOpts;

  constructor(o: MarrowOpts) {
    this.o = o;
    this.maxSpeed = o.maxSpeed;
    this.hx = o.x; this.hy = o.y;
    this.hdir = Math.random() * TAU;
    // trail 預填一條直線（沿初始反方向），避免起始抽搐
    const back = this.hdir + Math.PI;
    const fillStep = (o.bodyCount * o.segLen + o.tailLen) / (o.bodyCount + o.tailNodes);
    for (let i = 0; i < o.bodyCount + o.tailNodes + 5; i++) {
      this.trail.push({ x: o.x + Math.cos(back) * i * fillStep, y: o.y + Math.sin(back) * i * fillStep });
    }
    this.rebuildSpine();
    this.rebuildFins();
  }

  step(dt: number, env: Env) {
    this.t += dt;
    // 頭：轉向率做「有阻尼的隨機漫步」→ 每次游的路徑都不同、永不重複固定曲線（取代會週期重複的 fnoise）；
    // 阻尼讓轉向率衰減回 0 → 不會朝同方向一直轉成圈，是平滑的隨意彎。
    this.turnRate += (Math.random() - 0.5) * dt * 11;
    this.turnRate *= Math.pow(0.16, dt);
    this.hdir += this.turnRate * dt;
    if (this.steady) {
      this.speedNorm = 0.5;       // 行波頻率/振幅也固定
      this.speed = this.maxSpeed; // 恆定游速，不 fnoise 時快時慢
    } else {
      this.speedNorm = 0.5 + 0.5 * fnoise(this.t * 0.6 + this.seed + 10);
      this.speed = this.maxSpeed * (0.55 + 0.45 * this.speedNorm);
    }
    let nx = this.hx + Math.cos(this.hdir) * this.speed * dt;
    let ny = this.hy + Math.sin(this.hdir) * this.speed * dt;
    // 邊界：靠近邊緣越近、轉回中心越強（柔性回游、不撞牆）
    // 邊界回游：roam 模式繞著指定中心 (cx,cy) 游（studio 用）；否則沿畫面邊緣（InkLab demo 用）
    let want: number | null = null, strength = 0;
    if (env.roam && env.cx != null && env.cy != null) {
      // roam 模式也要避牆（否則大 roam 會貼牆游）：靠畫面邊緣優先轉回中心；
      // 沒靠牆、但游出家範圍才「柔柔」轉回家（力道很輕 → 不被拉成死圈、回家路上仍隨意游）。
      const margin = 110;
      const edge = Math.min(nx, env.w - nx, ny, env.h - ny);
      if (edge < margin) {
        want = Math.atan2(env.h / 2 - ny, env.w / 2 - nx);
        strength = Math.min(1, dt * 3.5 * (1 - edge / margin));
      } else {
        const dc = Math.hypot(nx - env.cx, ny - env.cy);
        if (dc > env.roam) { want = Math.atan2(env.cy - ny, env.cx - nx); strength = Math.min(1, dt * (dc > env.roam * 2 ? 2.6 : 1.0)); }
      }
    } else {
      const margin = 140;
      const edge = Math.min(nx, env.w - nx, ny, env.h - ny);
      if (edge < margin) { want = Math.atan2(env.h / 2 - ny, env.w / 2 - nx); strength = Math.min(1, dt * 3.2 * (1 - edge / margin)); }
    }
    if (want != null) {
      let d = want - this.hdir;
      while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      this.hdir += d * strength;
      nx = this.hx + Math.cos(this.hdir) * this.speed * dt;
      ny = this.hy + Math.sin(this.hdir) * this.speed * dt;
    }
    this.hx = Math.max(20, Math.min(env.w - 20, nx));
    this.hy = Math.max(20, Math.min(env.h - 20, ny));
    this.trail.unshift({ x: this.hx, y: this.hy });
    while (this.trail.length > 1200) this.trail.pop();
    this.rebuildSpine();
    this.rebuildFins();
  }

  // 中心線：身體 + 尾巴沿「同一條 head trail」等弧長取樣 → 整條連續彎曲；疊同一列連續行波（相位從頭遞延到尾尖）
  // 解決身尾交接生硬：尾巴不再程序化射出，而是延續身體的彎曲弧線
  private rebuildSpine() {
    const o = this.o;
    const tailStep = o.tailLen / o.tailNodes;
    const total = o.bodyCount + o.tailNodes;
    // 等弧長取樣（body 段 segLen 間距、tail 段 tailStep 間距，但同一條 trail 連續）
    const raw: Vec[] = [];
    let prev = this.trail[0];
    raw.push({ x: prev.x, y: prev.y });
    let acc = 0, idx = 1, need = o.segLen;
    while (raw.length < total && idx < this.trail.length) {
      const cur = this.trail[idx];
      const d = dist(prev, cur);
      if (d < 1e-4) { idx++; continue; }
      if (acc + d >= need) {
        const tt = (need - acc) / d;
        prev = { x: lerp(prev.x, cur.x, tt), y: lerp(prev.y, cur.y, tt) };
        raw.push({ x: prev.x, y: prev.y });
        acc = 0; need = raw.length < o.bodyCount ? o.segLen : tailStep;
      } else { acc += d; prev = cur; idx++; }
    }
    while (raw.length < total) raw.push({ x: raw[raw.length - 1].x, y: raw[raw.length - 1].y });
    const dirOf = (arr: { x: number; y: number }[], i: number) => {
      const a = arr[Math.max(0, i - 1)], b = arr[Math.min(arr.length - 1, i + 1)];
      return Math.atan2(b.y - a.y, b.x - a.x);
    };
    // 連續行波：相位一路遞延、振幅頭小尾大（頭穩尾擺，整條一列波）
    const omega = 6.5 * (1 + 0.5 * this.speedNorm);
    const spine: InkNode[] = [];
    for (let i = 0; i < total; i++) {
      const gi = i / (total - 1);
      const phase = this.t * omega - i * 0.42;
      const amp = o.segLen * (0.12 + Math.pow(gi, 1.6) * 2.8) * (1.1 - 0.4 * this.speedNorm);
      const perp = dirOf(raw, i) + HALF_PI;
      spine.push({ x: raw[i].x + Math.cos(perp) * Math.sin(phase) * amp, y: raw[i].y + Math.sin(perp) * Math.sin(phase) * amp, dir: 0, width: 0 });
    }
    for (let i = 0; i < total; i++) spine[i].dir = dirOf(spine, i); // 行波後重算 dir → 輪廓法向正確
    // 身體寬度（雙峰輪廓）
    const bw = 1.12 - 0.32 * this.speedNorm;
    for (let i = 0; i < o.bodyCount; i++) spine[i].width = o.bodyWidth * bodyProfile(i / (o.bodyCount - 1)) * bw;
    this.body = spine.slice(0, o.bodyCount);
    // 尾鰭多縷：基於延續的中心線（spine 尾段）做側向散開 + 次級細飄 + 漸細 → 與身體同弧線、轉彎不生硬
    const center = spine.slice(o.bodyCount - 1);
    const cn = center.length;
    const rootW = this.body[this.body.length - 1].width;
    const tails: InkNode[][] = [];
    for (let j = 0; j < o.tailCount; j++) {
      const spr = (j - (o.tailCount - 1) / 2) * 0.16;
      const phaseOff = j * 1.1;
      const nodes: InkNode[] = [];
      for (let k = 0; k < cn; k++) {
        const tk = k / (cn - 1);
        const c = center[k];
        const perp = c.dir + HALF_PI;
        const off = spr * tk * 110 + Math.sin(this.t * 4 - k * 0.5 + phaseOff) * 7 * tk; // 散開（根聚攏尾散開）+ 細飄
        nodes.push({ x: c.x + Math.cos(perp) * off, y: c.y + Math.sin(perp) * off, dir: c.dir, width: Math.max(0.4, rootW * 0.85 * Math.pow(1 - tk, 1.35)) });
      }
      tails.push(nodes);
    }
    this.tails = tails;
  }

  // 胸鰭/腹鰭：從身體側面長出的細飄帶（根鬚狀），對稱左右、後掠飄動、漸細化飛白
  private rebuildFins() {
    const o = this.o, body = this.body;
    const fins: InkNode[][] = [];
    const specs = [
      { t: 0.26, len: 0.52, sweep: 0.62 }, // 胸鰭（前、貼身後掠）
      { t: 0.5, len: 0.38, sweep: 0.5 },   // 腹鰭（中後、更貼身）
    ];
    for (const s of specs) {
      const a = body[Math.round(s.t * (body.length - 1))];
      for (const side of [-1, 1]) fins.push(this.genFin(a, side, o.tailLen * s.len, s.sweep, s.t * 17 + side * 3));
    }
    this.fins = fins;
  }

  private genFin(anchor: InkNode, side: number, len: number, sweep: number, seed: number): InkNode[] {
    const segN = 12, step = len / segN, base = anchor.dir + side * sweep;
    const w0 = this.o.bodyWidth * 0.2;
    let x = anchor.x, y = anchor.y, ang = base;
    const nodes: InkNode[] = [{ x, y, dir: ang, width: w0 }];
    for (let k = 1; k <= segN; k++) {
      const tk = k / segN;
      const wave = Math.sin(this.t * 3.5 - k * 0.5 + seed) * 0.5 * tk;
      ang = base + side * 0.18 * tk + wave; // 收斂外展＝鰭更貼身後掠
      x += Math.cos(ang) * step; y += Math.sin(ang) * step;
      nodes.push({ x, y, dir: ang, width: Math.max(0.3, w0 * Math.pow(1 - tk, 1.3)) });
    }
    return nodes;
  }

  get head(): InkNode { return this.body[0]; }
  get tailRoot(): InkNode { return this.body[this.body.length - 1]; }
}

// ───────────────────────────────────────────────────────────
// InkRenderer：墨色暈染（Phase 1 = 有機黑形 + 暈邊 + 沿軸漸層；Phase 2 上飛白/留白/硃砂）
// ───────────────────────────────────────────────────────────
export class InkRenderer {
  // 錦鯉色彩 keys（黑白橘黃紅其一或混搭）；null＝純墨黑水墨（預設、向後相容 inklab demo）
  private colors: string[] | null = null;
  setColors(keys: string[] | null) {
    const valid = keys?.filter((k) => KOI_HEX[k]) ?? [];
    this.colors = valid.length ? valid : null;
  }

  // 由節點左右半寬構成上下輪廓，quadraticCurveTo 串成有機閉合身形（不用 arc）
  private ribbon(nodes: InkNode[]): Path2D {
    const p = new Path2D();
    const top: Vec[] = [], bot: Vec[] = [];
    for (const nd of nodes) {
      const perp = nd.dir + HALF_PI;
      top.push({ x: nd.x + Math.cos(perp) * nd.width, y: nd.y + Math.sin(perp) * nd.width });
      bot.push({ x: nd.x - Math.cos(perp) * nd.width, y: nd.y - Math.sin(perp) * nd.width });
    }
    const smooth = (pts: Vec[]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        p.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      p.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    };
    // 頭端：用貝茲在吻部前方勾圓弧、把上下緣接起來＝有機魚頭（身體輪廓自然延伸，不套圓形）
    const h = nodes[0];
    const fwd = h.dir + Math.PI; // 前進方向（dir 指向尾，反向＝頭朝向）
    const hx = h.x + Math.cos(fwd) * h.width * 1.6;
    const hy = h.y + Math.sin(fwd) * h.width * 1.6;
    p.moveTo(bot[0].x, bot[0].y);
    p.quadraticCurveTo(hx, hy, top[0].x, top[0].y);
    smooth(top);                                            // 上緣 頭→尾
    p.lineTo(bot[bot.length - 1].x, bot[bot.length - 1].y); // 尾端封口
    smooth(bot.slice().reverse());                          // 下緣 尾→頭
    p.closePath();
    return p;
  }

  // 飛白枯筆：沿中心線後段畫斷續細絲，模擬乾筆掃過露白（疊在 ribbon 末端）
  // 斷續用確定性 hash（基於節點 index，不隨幀閃爍），越末端越容易斷
  private wisp(ctx: CanvasRenderingContext2D, nodes: InkNode[]) {
    const n = nodes.length;
    if (n < 5) return;
    const start = Math.floor(n * 0.42);
    ctx.save();
    ctx.lineCap = "round";
    for (let s = 0; s < 3; s++) {
      const off = (s - 1) * 1.4;
      let drawing = false;
      ctx.beginPath();
      for (let i = start; i < n; i++) {
        const nd = nodes[i];
        const perp = nd.dir + HALF_PI;
        const x = nd.x + Math.cos(perp) * off, y = nd.y + Math.sin(perp) * off;
        const tk = (i - start) / (n - start);
        if (((i * 7 + s * 13) % 10) / 10 > tk * 0.7) { // 越末端越容易斷
          if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
        } else drawing = false;
      }
      ctx.strokeStyle = `rgba(28,24,20,${0.45 - s * 0.1})`;
      ctx.lineWidth = 1.3 - s * 0.35;
      ctx.stroke();
    }
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, m: { body: InkNode[]; tails: InkNode[][]; fins: InkNode[][] }, blur: number) {
    const body = m.body;
    if (body.length < 3) return;
    if (this.colors) { this.drawSolid(ctx, m, blur, this.colors[0]); return; }
    const head = body[0], root = body[body.length - 1];
    ctx.save();
    // 尾飄帶（底層）：每縷根濃尖淡，自然轉飛白
    for (const tail of m.tails) {
      if (tail.length < 3) continue;
      const a = tail[0], b = tail[tail.length - 1];
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, "rgba(20,17,15,0.85)");
      g.addColorStop(0.5, "rgba(30,26,22,0.5)");
      g.addColorStop(1, "rgba(50,44,38,0)");
      if (blur > 0) { ctx.shadowColor = "rgba(20,16,14,0.4)"; ctx.shadowBlur = blur * 0.6; }
      ctx.fillStyle = g;
      ctx.fill(this.ribbon(tail));
      ctx.shadowBlur = 0;
      this.wisp(ctx, tail);
    }
    // 胸鰭/腹鰭（薄飄帶、身體下層、半透明）
    for (const fin of m.fins) {
      if (fin.length < 3) continue;
      const a = fin[0], b = fin[fin.length - 1];
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, "rgba(26,22,19,0.6)");
      g.addColorStop(0.6, "rgba(42,36,30,0.3)");
      g.addColorStop(1, "rgba(55,48,42,0)");
      if (blur > 0) { ctx.shadowColor = "rgba(20,16,14,0.3)"; ctx.shadowBlur = blur * 0.5; }
      ctx.fillStyle = g;
      ctx.fill(this.ribbon(fin));
      ctx.shadowBlur = 0;
      this.wisp(ctx, fin);
    }
    // 身體（蓋住尾根接縫）：沿軸漸層 + 濕墨暈邊
    const bg = ctx.createLinearGradient(head.x, head.y, root.x, root.y);
    bg.addColorStop(0, "#0b0a0a");
    bg.addColorStop(0.5, "#15110e");
    bg.addColorStop(1, "rgba(28,24,20,0.7)");
    const bodyPath = this.ribbon(body);
    if (blur > 0) { ctx.shadowColor = "rgba(20,16,14,0.5)"; ctx.shadowBlur = blur; }
    ctx.fillStyle = bg;
    ctx.fill(bodyPath);
    ctx.shadowBlur = 0;
    // 純黑白水墨：不加硃砂紅斑、不加留白破墨
    ctx.restore();
  }

  // 錦鯉純色：整身一色（頭受光→base→尾沉），clip 身形疊柔光團＝金屬光澤（金銀明顯、墨白內斂）；
  // 尾鰭跟底色、保留 dark halo 墨暈邊維持水墨質感。
  private drawSolid(ctx: CanvasRenderingContext2D, m: { body: InkNode[]; tails: InkNode[][]; fins: InkNode[][] }, blur: number, key: string) {
    const C = KOI_SOLID[key] || KOI_SOLID.ink;
    const halo = "rgba(20,16,14,0.5)";
    const body = m.body, head = body[0], root = body[body.length - 1];
    ctx.save();
    // 尾飄帶（底層）：base 根濃尖淡
    for (const tail of m.tails) {
      if (tail.length < 3) continue;
      const a = tail[0], b = tail[tail.length - 1];
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, koiRgba(koiShade(C.base, -0.12), 0.85));
      g.addColorStop(0.5, koiRgba(C.base, 0.45));
      g.addColorStop(1, koiRgba(C.base, 0));
      if (blur > 0) { ctx.shadowColor = halo; ctx.shadowBlur = blur * 0.6; }
      ctx.fillStyle = g; ctx.fill(this.ribbon(tail)); ctx.shadowBlur = 0;
      this.wisp(ctx, tail);
    }
    // 胸鰭/腹鰭：base 薄飄帶
    for (const fin of m.fins) {
      if (fin.length < 3) continue;
      const a = fin[0], b = fin[fin.length - 1];
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, koiRgba(C.base, 0.55));
      g.addColorStop(0.6, koiRgba(C.base, 0.28));
      g.addColorStop(1, koiRgba(C.base, 0));
      if (blur > 0) { ctx.shadowColor = halo; ctx.shadowBlur = blur * 0.5; }
      ctx.fillStyle = g; ctx.fill(this.ribbon(fin)); ctx.shadowBlur = 0;
    }
    // 身體：純色（頭受光 light → base → 尾沉 dark）＋墨暈邊
    const bodyPath = this.ribbon(body);
    const bg = ctx.createLinearGradient(head.x, head.y, root.x, root.y);
    bg.addColorStop(0, C.light);
    bg.addColorStop(0.3, C.base);
    bg.addColorStop(0.72, C.base);
    bg.addColorStop(1, C.dark);
    if (blur > 0) { ctx.shadowColor = halo; ctx.shadowBlur = blur; }
    ctx.fillStyle = bg; ctx.fill(bodyPath); ctx.shadowBlur = 0;
    // 金屬光澤：clip 身形、沿脊偏一側放兩顆柔光團（light）→ 金銀有反光、墨白只一抹潤澤
    ctx.save();
    ctx.clip(bodyPath);
    for (const t of [0.32, 0.58]) {
      const nd = body[Math.round(t * (body.length - 1))];
      const w = Math.max(nd.width, 8);
      const perp = nd.dir + HALF_PI;
      const cx = nd.x + Math.cos(perp) * w * 0.35, cy = nd.y + Math.sin(perp) * w * 0.35;
      const r = w * 1.3;
      const rg = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      rg.addColorStop(0, koiRgba(C.light, 0.5));
      rg.addColorStop(1, koiRgba(C.light, 0));
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }
}

// ───────────────────────────────────────────────────────────
// TraceField：尾跡粒子（魚游過激起的墨點漣漪，變大淡出）
// ───────────────────────────────────────────────────────────
type Particle = { x: number; y: number; r: number; alpha: number; grow: number; vx: number; vy: number };

export class TraceField {
  private ps: Particle[] = [];
  private acc = 0;

  emit(at: InkNode, speed: number, dt: number) {
    this.acc += (0.4 + speed / 140) * dt * 26;
    while (this.acc >= 1) {
      this.acc -= 1;
      const a = Math.random() * TAU, s = Math.random() * 5;
      this.ps.push({
        x: at.x + Math.cos(a) * s, y: at.y + Math.sin(a) * s,
        r: 1 + Math.random() * 2, alpha: 0.1 + Math.random() * 0.08,
        grow: 5 + Math.random() * 9, vx: 0, vy: 0,
      });
    }
    if (this.ps.length > 500) this.ps.splice(0, this.ps.length - 500);
  }

  step(dt: number, env: Env) {
    for (const p of this.ps) {
      if (env.flow) { const f = env.flow(p.x, p.y); p.vx = f.x; p.vy = f.y; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.r += p.grow * dt;
      p.alpha -= 0.24 * dt;
    }
    this.ps = this.ps.filter((p) => p.alpha > 0.01);
  }

  draw(ctx: CanvasRenderingContext2D) {
    for (const p of this.ps) {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, `rgba(28,24,20,${p.alpha})`);
      g.addColorStop(1, "rgba(28,24,20,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
  }
}

// ───────────────────────────────────────────────────────────
// InkStage：Canvas 環境（宣紙底 + 殘影 fade）
// ───────────────────────────────────────────────────────────
export class InkStage {
  private paperCv: HTMLCanvasElement | null = null;

  private buildPaper(w: number, h: number) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#f3ece1";
    c.fillRect(0, 0, w, h);
    c.globalAlpha = 0.04;
    for (let i = 0; i < (w * h) / 1400; i++) {
      c.fillStyle = Math.random() < 0.5 ? "#000" : "#c9b79a";
      c.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
    c.globalAlpha = 1;
    this.paperCv = cv;
  }

  paper(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!this.paperCv || this.paperCv.width !== w || this.paperCv.height !== h) this.buildPaper(w, h);
    ctx.drawImage(this.paperCv!, 0, 0);
  }

  // 每幀蓋一層半透明宣紙色 → 舊筆觸緩慢淡去（水墨動態殘影）。fade 越小殘影越久
  clearFade(ctx: CanvasRenderingContext2D, w: number, h: number, fade: number) {
    ctx.fillStyle = `rgba(243,236,225,${fade})`;
    ctx.fillRect(0, 0, w, h);
  }
}

// ───────────────────────────────────────────────────────────
// InkCreature：組合一隻水墨生物
// ───────────────────────────────────────────────────────────
export type CreatureOpts = MarrowOpts & { blur?: number };

export class InkCreature {
  marrow: Marrow;
  ink = new InkRenderer();
  trace = new TraceField();
  blur: number;

  constructor(o: CreatureOpts) {
    this.marrow = new Marrow(o);
    this.blur = o.blur ?? 8;
  }

  update(dt: number, env: Env) {
    this.marrow.step(dt, env);
    this.trace.emit(this.marrow.tailRoot, this.marrow.speed, dt);
    this.trace.step(dt, env);
  }

  draw(ctx: CanvasRenderingContext2D) {
    this.trace.draw(ctx);
    this.ink.draw(ctx, this.marrow, this.blur);
  }
}
