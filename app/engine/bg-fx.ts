// 九墨「背景濾鏡」引擎 — 原生 WebGL2，跟墨流（FluidCore）／音訊圖（GpuVisuals）同技術棧、零新依賴。
// 把背景圖當輸入貼圖，串接一條後製濾鏡鏈（扭曲／模糊／色彩），每個濾鏡＝一支 fragment shader。
//   - 扭曲類（bulge/fisheye/twirl/ripple/mirror/polar）：算出變形後的 uv，再 src(uv) 取樣
//   - 色彩/通道類（grayscale/rgbshift/vhs/glitch/vignette）：直接對像素做運算
//   - 模糊類（blur/zoomblur/tiltshift）：多點取樣求平均
// 每支 shader 都吃 uAmt（0~1 強度，使用者拉的滑桿）；會動的（ripple/vhs/glitch）另吃 uTime。
// 多濾鏡用兩張 FBO ping-pong 串接；最後一關直接畫到 canvas，再由 studio 用 ctx2d.drawImage 鋪底。

export type BgEffect = { id: string; name: string; category: string; frag: string };

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type FBO = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

// 全螢幕三角形（gl_VertexID，免頂點緩衝）
const VERT = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// 濾鏡共用 header：uniforms + 取樣（夾邊免黑框）+ 雜訊 + 長寬比
const HEADER = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uTime;
uniform float uAmt;          // 強度 0~1
uniform float uEnergy;       // 整體音樂能量 0~1（給粒子加速）
uniform float uBeat;         // 重音包絡 0~1（鼓點瞬間更快/更亮）
uniform float uPTime;        // 粒子專用時間（已包覆到 [0,7200)→ float32 精度安全；雪花環面捲動讓 wrap 無接縫，不像 uTime 會無限長大掉精度）
uniform float uDensity;      // 粒子疏密度 0~1（雪花/光點唯一可調；預設 0.5＝舊版 0% 稀疏）
uniform float uSpeed;        // （保留；雪花/光點已改固定速度、不再使用）
uniform float uAngle;        // 眼鏡反光傾斜 / crossglass 線一角度（弧度，0=水平；雪花已固定向下、不用）
uniform float uAngle2;       // crossglass 線二角度（弧度，獨立於線一）
uniform float uPosX;         // 眼鏡反光中心 X（0~1，預設 0.5）
uniform float uPosY;         // 眼鏡反光中心 Y（0~1，預設 0.5）
uniform float uGScale;       // 眼鏡反光大小（預設 1）
uniform vec3 uColA;          // 眼鏡反光漸層起色（預設白）
uniform vec3 uColB;          // 眼鏡反光漸層終色（預設淡藍）
vec2 vUv(){ return gl_FragCoord.xy / uRes; }
float aspect(){ return uRes.x / uRes.y; }
// 夾邊取樣：uv 超出 [0,1] 時取邊緣像素（扭曲不會露出黑邊／重複）
vec4 src(vec2 uv){ return texture(uSrc, clamp(uv, vec2(0.0009), vec2(0.9991))); }
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
`;
const MAIN = `
void main(){ o = effect(vUv()); }`;
// 純拷貝（無濾鏡時把背景畫到 canvas）
const COPY = HEADER + `vec4 effect(vec2 uv){ return src(uv); }` + MAIN;

/* ───────── 扭曲類 ───────── */

// 凸透鏡 / 凹陷：中心放大（魚缸感）。amt 越大越鼓。
const bulge: BgEffect = { id: "bulge", name: "凸透鏡", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 c = uv - 0.5; c.x *= aspect();
  float r = length(c);
  if (r < 1e-4) return src(uv);
  float maxR = 0.72;
  float rr = pow(min(r/maxR, 1.0), 1.0 - uAmt*0.7) * maxR; // 指數 <1 → 把中心往外推、邊緣壓縮＝放大中心
  vec2 nc = c / r * rr; nc.x /= aspect();
  return src(nc + 0.5);
}` };

// 魚眼：桶形變形，整體往外彎。
const fisheye: BgEffect = { id: "fisheye", name: "魚眼", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 p = uv - 0.5; p.x *= aspect();
  float r2 = dot(p, p);
  float f = 1.0 - uAmt * 0.9 * r2;     // 邊緣往內收 → 桶形
  vec2 q = p * f; q.x /= aspect();
  return src(q + 0.5);
}` };

// 魚眼 2：枕形變形（邊緣放大、中央壓縮），跟魚眼相反方向的廣角感。
const fisheye2: BgEffect = { id: "fisheye2", name: "魚眼 2", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 p = uv - 0.5; p.x *= aspect();
  float r2 = dot(p, p);
  vec2 q = p * (1.0 + uAmt * 1.3 * r2); // 邊緣往外推 → 枕形廣角
  q.x /= aspect();
  return src(q + 0.5);
}` };

// 位移：用程序雜訊當置換貼圖，整片像隔著毛玻璃/熱浪流動（會動）。
const displace: BgEffect = { id: "displace", name: "位移", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  float t = uTime * 0.2;
  vec2 n = vec2(noise(uv*6.0 + t), noise(uv*6.0 + 17.0 - t*0.8));
  vec2 off = (n - 0.5) * uAmt * 0.12;
  return src(uv + off);
}` };

// 液化：fbm 域變形，像顏料被攪動的流體（會動）。
const liquify: BgEffect = { id: "liquify", name: "液化", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  float t = uTime * 0.15;
  vec2 q = vec2(noise(uv*3.0 + t), noise(uv*3.0 + vec2(5.2,1.3) - t));
  vec2 r = vec2(noise(uv*3.0 + q*2.2 + t*0.5), noise(uv*3.0 + q*2.2 + vec2(8.3,2.8)));
  vec2 off = (r - 0.5) * uAmt * 0.18;
  return src(uv + off);
}` };

// 衝擊波：從中心一圈圈擴散的單一震波、循環（會動）。
const impact: BgEffect = { id: "impact", name: "衝擊波", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 c = uv - 0.5; c.x *= aspect();
  float r = length(c);
  if (r < 1e-4) return src(uv);
  float ph = fract(uTime * 0.4);                 // 0..1 週期
  float radius = ph * 0.8;
  float ring = smoothstep(0.07, 0.0, abs(r - radius)); // 環帶
  float w = ring * (1.0 - ph) * uAmt * 0.07;     // 隨擴散衰減
  vec2 off = c / r * w; off.x /= aspect();
  return src(uv + off);
}` };

// 幽靈：上下＋左右正弦波抖動，鬼影飄動感（會動）。
const spooky: BgEffect = { id: "spooky", name: "幽靈", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  float t = uTime * 1.2;
  vec2 off;
  off.x = sin(uv.y * 14.0 + t) * 0.018 * uAmt;
  off.y = cos(uv.x * 12.0 + t * 0.8) * 0.018 * uAmt;
  return src(uv + off);
}` };

// 漩渦：繞中心旋轉，越靠中心轉越多。
const twirl: BgEffect = { id: "twirl", name: "漩渦", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 c = uv - 0.5; c.x *= aspect();
  float r = length(c);
  float ang = uAmt * 7.0 * smoothstep(0.6, 0.0, r); // 中心轉最多、外圍漸無
  float s = sin(ang), co = cos(ang);
  c = mat2(co, -s, s, co) * c; c.x /= aspect();
  return src(c + 0.5);
}` };

// 漣漪：從中心一圈圈擴散的水波（會動）。
const ripple: BgEffect = { id: "ripple", name: "漣漪", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 c = uv - 0.5; c.x *= aspect();
  float r = length(c);
  if (r < 1e-4) return src(uv);
  float w = sin(r * 38.0 - uTime * 3.5) * uAmt * 0.028 * smoothstep(0.0, 0.1, r);
  vec2 off = c / r * w; off.x /= aspect();
  return src(uv + off);
}` };

// 鏡像：左右對稱（amt 從原圖漸變到完全鏡射）。
const mirror: BgEffect = { id: "mirror", name: "鏡像", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 m = uv; if (m.x > 0.5) m.x = 1.0 - m.x;
  return src(mix(uv, m, clamp(uAmt, 0.0, 1.0)));
}` };

// 極座標：把畫面捲成圓形（amt 漸變）。
const polar: BgEffect = { id: "polar", name: "極座標", category: "扭曲", frag: `
vec4 effect(vec2 uv){
  vec2 c = uv - 0.5; c.x *= aspect();
  float r = clamp(length(c) * 1.9, 0.0, 1.0);
  float a = atan(c.y, c.x) / 6.28318 + 0.5;
  return src(mix(uv, vec2(a, r), clamp(uAmt, 0.0, 1.0)));
}` };

/* ───────── 色彩 · 通道類 ───────── */

// 色差 / RGB 分離：紅藍通道沿放射方向錯位（距離線性）。
const rgbshift: BgEffect = { id: "rgbshift", name: "色差分離", category: "色彩", frag: `
vec4 effect(vec2 uv){
  vec2 dir = uv - 0.5;
  float k = uAmt * 0.045;
  vec4 base = src(uv);
  return vec4(src(uv + dir*k).r, base.g, src(uv - dir*k).b, base.a);
}` };

// 色像差：鏡頭式彩邊，邊緣更強（距離平方加權），比色差分離更像真實透鏡。
const chroma: BgEffect = { id: "chroma", name: "色像差", category: "色彩", frag: `
vec4 effect(vec2 uv){
  vec2 d = uv - 0.5;
  vec2 dir = d / (length(d) + 1e-4);
  float k = uAmt * 0.05 * dot(d, d) * 4.0; // 中央幾乎不偏、邊緣明顯
  vec4 base = src(uv);
  return vec4(src(uv + dir*k).r, base.g, src(uv - dir*k).b, base.a);
}` };

// 黑白：去飽和（amt 控制脫色程度）。
const grayscale: BgEffect = { id: "grayscale", name: "黑白", category: "色彩", frag: `
vec4 effect(vec2 uv){
  vec4 c = src(uv);
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  return vec4(mix(c.rgb, vec3(g), clamp(uAmt, 0.0, 1.0)), c.a);
}` };

// 暗角：四周壓暗、聚焦中央。
const vignette: BgEffect = { id: "vignette", name: "暗角", category: "色彩", frag: `
vec4 effect(vec2 uv){
  vec4 c = src(uv);
  vec2 p = (uv - 0.5) * vec2(aspect(), 1.0);
  float v = smoothstep(0.85, 0.32, length(p));
  return vec4(c.rgb * mix(1.0, v, clamp(uAmt, 0.0, 1.0)), c.a);
}` };

// VHS：色差 + 掃描線 + 抖動 + 雜訊（會動，老錄影帶感）。
const vhs: BgEffect = { id: "vhs", name: "VHS 錄影帶", category: "色彩", frag: `
vec4 effect(vec2 uv){
  float t = uTime;
  float wob = sin(uv.y * 130.0 + t * 5.0) * 0.0022 * uAmt;
  vec2 u = uv + vec2(wob, 0.0);
  float sh = 0.007 * uAmt;
  vec3 col = vec3(src(u + vec2(sh,0)).r, src(u).g, src(u - vec2(sh,0)).b);
  float scan = 0.82 + 0.18 * sin(uv.y * uRes.y * 1.6); // 掃描線
  col *= mix(1.0, scan, uAmt * 0.8);
  float n = noise(uv * uRes.xy * 0.4 + t * 60.0);
  col += (n - 0.5) * 0.18 * uAmt;
  return vec4(col, src(uv).a);
}` };

// 故障：橫向區塊位移 + RGB 撕裂（會動）。
const glitch: BgEffect = { id: "glitch", name: "故障", category: "色彩", frag: `
vec4 effect(vec2 uv){
  float t = floor(uTime * 11.0);
  float band = floor(uv.y * 26.0);
  float r = hash(vec2(band, t));
  float shift = step(0.72, r) * (hash(vec2(band, t + 1.7)) - 0.5) * uAmt * 0.14;
  vec2 u = uv + vec2(shift, 0.0);
  float sp = uAmt * 0.02 * step(0.55, hash(vec2(t, 2.3)));
  return vec4(src(u + vec2(sp,0)).r, src(u).g, src(u - vec2(sp,0)).b, src(u).a);
}` };

/* ───────── 模糊類 ───────── */

// 高斯模糊：5×5 取樣（強度＝模糊半徑）。
const blur: BgEffect = { id: "blur", name: "模糊", category: "模糊", frag: `
vec4 effect(vec2 uv){
  vec2 px = (1.0 / uRes) * uAmt * 7.0;
  vec3 s = vec3(0.0); float tot = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
    float w = exp(-float(i*i + j*j) / 4.0);
    s += src(uv + vec2(float(i), float(j)) * px).rgb * w; tot += w;
  }
  return vec4(s / tot, src(uv).a);
}` };

// 三角模糊：三角形（線性）權重，比高斯更柔、邊緣更綿。
const triblur: BgEffect = { id: "triblur", name: "三角模糊", category: "模糊", frag: `
vec4 effect(vec2 uv){
  vec2 px = (1.0 / uRes) * uAmt * 6.0;
  vec3 s = vec3(0.0); float tot = 0.0;
  for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) {
    float w = (4.0 - abs(float(i))) * (4.0 - abs(float(j))); // 三角權重
    s += src(uv + vec2(float(i), float(j)) * px).rgb * w; tot += w;
  }
  return vec4(s / tot, src(uv).a);
}` };

// 橫向模糊：只在水平方向糊（動態橫掃感）。
const hblur: BgEffect = { id: "hblur", name: "橫向模糊", category: "模糊", frag: `
vec4 effect(vec2 uv){
  float px = (1.0 / uRes.x) * uAmt * 14.0;
  vec3 s = vec3(0.0); float tot = 0.0;
  for (int i = -7; i <= 7; i++) { float w = exp(-float(i*i) / 24.0); s += src(uv + vec2(float(i)*px, 0.0)).rgb * w; tot += w; }
  return vec4(s / tot, src(uv).a);
}` };

// 直向模糊：只在垂直方向糊。
const vblur: BgEffect = { id: "vblur", name: "直向模糊", category: "模糊", frag: `
vec4 effect(vec2 uv){
  float px = (1.0 / uRes.y) * uAmt * 14.0;
  vec3 s = vec3(0.0); float tot = 0.0;
  for (int i = -7; i <= 7; i++) { float w = exp(-float(i*i) / 24.0); s += src(uv + vec2(0.0, float(i)*px)).rgb * w; tot += w; }
  return vec4(s / tot, src(uv).a);
}` };

// 縮放模糊：沿往中心的方向疊影（爆發/速度感）。
const zoomblur: BgEffect = { id: "zoomblur", name: "縮放模糊", category: "模糊", frag: `
vec4 effect(vec2 uv){
  vec2 dir = (0.5 - uv);
  vec3 s = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    float k = float(i) / 15.0;
    s += src(uv + dir * k * uAmt * 0.3).rgb;
  }
  return vec4(s / 16.0, src(uv).a);
}` };

// 移軸：上下模糊、中間清晰（微縮模型感）。
const tiltshift: BgEffect = { id: "tiltshift", name: "移軸", category: "模糊", frag: `
vec4 effect(vec2 uv){
  float d = abs(uv.y - 0.5) * 2.0;
  float b = smoothstep(0.28, 1.0, d) * uAmt;
  vec2 px = vec2(0.0, 1.0 / uRes.y) * b * 12.0;
  vec3 s = vec3(0.0); float tot = 0.0;
  for (int i = -6; i <= 6; i++) { float w = exp(-float(i*i) / 18.0); s += src(uv + px * float(i)).rgb * w; tot += w; }
  return vec4(s / tot, src(uv).a);
}` };

/* ───────── 粒子類（雪花/光點＝不跟音樂的自然樣子；只調疏密度。眼鏡反光＝重音一閃）───────── */

// 雪花：整片緩緩往下飄落。不跟音樂、不可選方向、不調速度（固定溫和）。每顆自己的大小＋水平微飄路線；速度層次靠 5 層景深。
// ⚠️ 無接縫捲動（解決「跳回原點」）：用 mod(id,SNOW_PER) 把雜訊場做成 per=60 的「環面」→ 捲動 wrap 時對到同一顆 → 永不瞬移。
//    速度全是 0.05 的倍數＋per=60＋uPTime 包覆到 7200：7200*speed 必為 60 的整數倍 → 連每 2hr 那次 uPTime wrap 也無接縫。
//    （走過的兩條錯路：(1)無限長大的 uTime 慢速掉精度→倒退；(2)非整數倍 wrap→整片瞬移回原點。環面把兩者一次解掉。）
// 疏密度預設 0.5（中間值）＝舊版 0% 的稀疏感：gate=clamp(mix(1.62,0.32,d),0,1)，d=0.5→0.97（約 3% 格子有粒子）。
const snow: BgEffect = { id: "snow", name: "雪花", category: "粒子", frag: `
float snowLayer(vec2 uv, float cells, float speed, float seed){
  const float PER = 60.0;                                   // 環面週期（cells）；螢幕只看到 7~25 cells → 重複看不見
  vec2 gp = vec2(uv.x * aspect(), uv.y) * cells;
  gp.y += mod(uPTime * speed, PER);                         // 往下捲動（環面 wrap 無接縫、不跳回原點）
  vec2 baseId = floor(gp);
  float gate = clamp(mix(1.62, 0.32, uDensity), 0.0, 1.0);  // 疏密度：0.5→0.97（舊 0% 稀疏）、1.0→密、0→空
  float swPhase = uPTime * 6.2831853 / 60.0;                // 微飄相位：基底週期 60s、7200/60=120 整數 → wrap 無接縫
  float acc = 0.0;
  for (int oy = -1; oy <= 1; oy++) {                        // 3x3 鄰格取樣：抖動把粒子推出格外也不裁邊（不出框框）
    for (int ox = -1; ox <= 1; ox++) {
      vec2 id = baseId + vec2(float(ox), float(oy));
      vec2 wid = mod(id, vec2(PER));                         // 環面：捲動 wrap 後對到同一顆 → 無接縫
      float h = hash(wid + seed);
      if (h < gate) continue;
      float h2 = hash(wid*1.7 + seed + 5.0), h3 = hash(wid*2.3 + seed + 9.0);
      float n = floor(2.0 + h2 * 4.0);                       // 每顆自己的微飄週期（整數→wrap 無接縫）
      float sway = sin(swPhase * n + h * 6.2831853) * 0.16;  // 水平微飄＝各自路線（幅度小，垂直前進為主，不會原地扭）
      vec2 center = (id + vec2(0.5)) + vec2((h2 - 0.5) * 0.6 + sway, (h3 - 0.5) * 0.6);
      float r = 0.06 + 0.16 * h2;                            // 大小不一
      acc = max(acc, smoothstep(r, r * 0.3, length(gp - center)) * (0.5 + 0.5 * h));
    }
  }
  return acc;
}
vec4 effect(vec2 uv){
  vec4 col = src(uv);
  // 5 層景深：cells 越大＝越小越遠的雪；speed 皆 0.05 倍數（wrap 無接縫）；螢幕速度 speed/cells 各異＝速度有層次
  float s = snowLayer(uv, 7.0, 0.40, 1.3) + snowLayer(uv, 10.0, 0.50, 4.4) + snowLayer(uv, 14.0, 0.60, 7.7)
          + snowLayer(uv, 19.0, 0.70, 11.1) + snowLayer(uv, 25.0, 0.80, 13.1);
  s = clamp(s, 0.0, 1.0) * uAmt;
  return vec4(mix(col.rgb, vec3(1.0), s), col.a);
}` };

// 光點：原地閃爍、完全不移動、不跟音樂（＝沒音樂時的閃爍樣子）。只調疏密度。冷暖不一、柔光暈，加色（lighter）。
// 靜止 → 無捲動/無 wrap/無精度問題。閃爍相位綁 60s 基底＋整數倍 → uPTime wrap 也無接縫。
// 疏密度預設 0.5（中間值）＝舊版 0% 稀疏：gate=clamp(mix(1.52,0.42,d),0,1)，d=0.5→0.97。
const lightdots: BgEffect = { id: "lightdots", name: "光點", category: "粒子", frag: `
vec3 dotLayer(vec2 uv, float cells, float seed){
  vec2 gp = vec2(uv.x * aspect(), uv.y) * cells;             // 靜止（原地閃，不捲動）
  vec2 baseId = floor(gp);
  float gate = clamp(mix(1.52, 0.42, uDensity), 0.0, 1.0);
  float swPhase = uPTime * 6.2831853 / 60.0;                 // 閃爍相位（wrap 無接縫）
  vec3 acc = vec3(0.0);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 id = baseId + vec2(float(ox), float(oy));
      float h = hash(id + seed);
      if (h < gate) continue;
      float h2 = hash(id*2.3 + seed + 9.0), h3 = hash(id*3.1 + seed + 2.0);
      vec2 center = (id + vec2(0.5)) + (vec2(h3, h2) - 0.5) * 0.7; // 靜態抖動（位置固定，只閃不動）
      float dl = length(gp - center);
      float r = 0.05 + 0.13 * h;
      float core = smoothstep(r, 0.0, dl);
      float glow = smoothstep(r * 4.0, 0.0, dl) * 0.5;        // 柔光暈
      float nt = floor(3.0 + h2 * 5.0);                       // 每顆閃爍週期（整數→wrap 無接縫）
      float tw = 0.5 + 0.5 * sin(swPhase * nt + h * 6.2831853); // 原地閃爍
      vec3 tint = mix(vec3(1.0, 0.92, 0.7), vec3(0.7, 0.85, 1.0), h2); // 暖/冷不一
      acc += tint * (core + glow) * tw * (0.6 + 0.4 * h);
    }
  }
  return acc;
}
vec4 effect(vec2 uv){
  vec4 col = src(uv);
  vec3 g = dotLayer(uv, 6.0, 2.1) + dotLayer(uv, 9.0, 5.5) + dotLayer(uv, 13.0, 8.3)
         + dotLayer(uv, 18.0, 11.9) + dotLayer(uv, 24.0, 15.7);
  return vec4(col.rgb + g * uAmt, col.a);                    // 加色發光
}` };

// 眼鏡反光：兩道光條（下長上短），位置/大小/角度/漸層色皆可調。預設水平。重音時更亮（眼鏡一閃）。
const glint: BgEffect = { id: "glint", name: "眼鏡反光", category: "粒子", frag: `
float streak(vec2 p, vec2 c, float len, float thick, float ca, float sa, out float tpos){
  vec2 d = p - c;
  vec2 r = vec2(d.x*ca - d.y*sa, d.x*sa + d.y*ca);     // 旋轉到條軸：r.x 沿軸、r.y 橫向
  tpos = clamp(r.x / len * 0.5 + 0.5, 0.0, 1.0);       // 沿軸位置 0~1（給顏色漸層用）
  float along = smoothstep(len, len*0.5, abs(r.x));    // 沿軸限長＋軟端
  float across = exp(-(r.y*r.y) / (thick*thick));      // 橫向細高斯（亮芯）
  return along * across;
}
vec4 effect(vec2 uv){
  vec4 col = src(uv);
  vec2 p = vec2(uv.x * aspect(), uv.y);
  vec2 ctr = vec2(uPosX * aspect(), uPosY);            // 位置（可調）
  float sc = uGScale;                                  // 大小（可調）
  float ca = cos(uAngle), sa = sin(uAngle);            // 角度（預設 0＝水平）
  float t1, t2;
  float s1 = streak(p, ctr + vec2(0.0, -0.05*sc),   0.30*sc, 0.013*sc, ca, sa, t1); // 下：長
  float s2 = streak(p, ctr + vec2(0.05*sc, 0.045*sc), 0.15*sc, 0.010*sc, ca, sa, t2); // 上：短、偏右
  // 顏色曲線：沿條軸 colorA→colorB 平滑漸層（smoothstep＝曲線，反光不會整條同色）
  vec3 c1 = mix(uColA, uColB, smoothstep(0.0, 1.0, t1));
  vec3 c2 = mix(uColA, uColB, smoothstep(0.0, 1.0, t2));
  float flash = uAmt * (0.7 + 0.7 * uBeat);            // 重音時更亮
  vec3 g = (c1 * s1 + c2 * s2) * flash;
  return vec4(col.rgb + g, col.a);                     // 加色光
}` };

// 交叉聚焦框（crossglass）：兩條獨立角度的「乾淨清晰直條」交叉，帶內＝原圖清晰、帶外＝高斯模糊＋可黑白化，
// 邊緣＝細亮外框＋外緣柔陰影（長條浮起來）。無折射/色散/白線/波浪（使用者打槍液態玻璃，改乾淨方案）。
// 位置 uPosX/uPosY(top-origin)、大小 uGScale、線一角度 uAngle、線二角度 uAngle2、外圈黑白 uDensity、外圈模糊 uSpeed、外框色 uColA、強度 uAmt。靜態。
const crossglass: BgEffect = { id: "crossglass", name: "交叉聚焦框", category: "扭曲", frag: `
vec3 blurAround(vec2 uv, float r){                               // 帶外高斯模糊（9 點）
  vec2 px = vec2(1.0/uRes.x, 1.0/uRes.y) * r;
  vec3 s = src(uv).rgb * 0.20;
  s += (src(uv+vec2(px.x,0.0)).rgb + src(uv-vec2(px.x,0.0)).rgb + src(uv+vec2(0.0,px.y)).rgb + src(uv-vec2(0.0,px.y)).rgb) * 0.12;
  s += (src(uv+px).rgb + src(uv-px).rgb + src(uv+vec2(px.x,-px.y)).rgb + src(uv-vec2(px.x,-px.y)).rgb) * 0.08;
  return s;
}
float armDist(vec2 p, float ang){ vec2 n = vec2(-sin(ang), cos(ang)); return abs(dot(p, n)); } // 到該角度直條中心線的垂直距離
vec4 effect(vec2 uv){
  float asp = aspect();
  vec3 raw = src(uv).rgb;
  vec2 p = uv - vec2(uPosX, 1.0 - uPosY); p.x *= asp;            // 焦點（uPosY 轉 top-origin → 拖曳上下不反）
  float halfw = 0.10 * uGScale;                                  // 直條半寬＝大小
  float d1 = armDist(p, uAngle);                                 // 線一（直，無 noise）
  float d2 = armDist(p, uAngle2);                                // 線二（獨立角度）
  float clear1 = 1.0 - smoothstep(halfw * 0.85, halfw, d1);      // 清晰遮罩（乾淨邊）
  float clear2 = 1.0 - smoothstep(halfw * 0.85, halfw, d2);
  float clearM = max(clear1, clear2);                            // 聯集＝清晰區
  // 帶外：高斯模糊 + 黑白化
  vec3 blur = blurAround(uv, 3.0 + 15.0 * uSpeed);
  float gray = dot(blur, vec3(0.299, 0.587, 0.114));
  vec3 outside = mix(blur, vec3(gray), clamp(uDensity, 0.0, 1.0));
  // 外框細亮線（rim，落在直條邊緣 d≈halfw，只在聯集外緣顯示）＋外緣柔陰影
  float e1 = (d1 - halfw) / (halfw * 0.09), e2 = (d2 - halfw) / (halfw * 0.09);
  float rim = max(exp(-e1 * e1) * (1.0 - clear2), exp(-e2 * e2) * (1.0 - clear1));
  float sw = halfw * 0.7;                                        // 陰影寬
  float sh1 = smoothstep(halfw, halfw + 0.0005, d1) * (1.0 - smoothstep(halfw, halfw + sw, d1)) * (1.0 - clear2);
  float sh2 = smoothstep(halfw, halfw + 0.0005, d2) * (1.0 - smoothstep(halfw, halfw + sw, d2)) * (1.0 - clear1);
  float shadow = max(sh1, sh2);
  vec3 col = mix(outside, raw, clearM);                          // 帶內原圖清晰、帶外模糊（無折射無色散）
  col *= 1.0 - shadow * 0.5;                                     // 外緣陰影（清晰長條浮起）
  col += uColA * rim * 0.5;                                      // 外框細亮線
  return vec4(mix(raw, col, uAmt), src(uv).a);                  // 強度（0＝原圖）
}` };

// 玻璃滑光（lightsweep）：整片去色壓暗，一道斜光帶每隔幾秒掃過、把經過的區域點亮回原色＋提亮，再滑出畫面。
// 不跟音樂、純時間驅動；每一輪用 hash(cycle) 隨機方向/角度/高度/寬度 → 每次出現都不一樣。會動 → 進 ANIMATED。
// 頻率 uSpeed（多久一輪）、滑動速度 uPosX（掃過多快）、光帶寬 uGScale、去色程度 uDensity、光色 uColA、強度 uAmt。
const lightsweep: BgEffect = { id: "lightsweep", name: "玻璃滑光", category: "色彩", frag: `
vec4 effect(vec2 uv){
  float asp = aspect();
  vec3 raw = src(uv).rgb;
  float gray = dot(raw, vec3(0.299, 0.587, 0.114));
  vec3 dim = mix(raw, vec3(gray) * 0.78, clamp(uDensity, 0.0, 1.0));   // 去色＋壓暗的底
  float period = mix(7.0, 2.6, clamp(uSpeed, 0.0, 1.0));               // 多久一輪（頻率）
  float sweepDur = clamp(mix(2.6, 0.5, clamp(uPosX, 0.0, 1.0)), 0.3, period * 0.9); // 滑動速度（uPosX 高=快、掃得短）；上限留 gap
  float cyc = floor(uPTime / period);
  float lt = uPTime - cyc * period;                                    // 本輪 0..period
  vec3 col = dim;
  if (lt < sweepDur) {
    float h1 = hash(vec2(cyc, 1.7)), h2 = hash(vec2(cyc, 4.3)), h3 = hash(vec2(cyc, 8.1)), h4 = hash(vec2(cyc, 12.9));
    float dir = h1 < 0.5 ? 1.0 : -1.0;                                 // 方向（左右）
    float ang = (h2 - 0.5) * 0.7;                                      // 傾斜 ±0.35 rad
    float voff = (h3 - 0.5) * 0.5;                                     // 中心高度偏移
    float halfw = (0.07 + 0.06 * h4) * uGScale;                       // 光帶半寬
    float sp = lt / sweepDur;
    float ease = sp * sp * (3.0 - 2.0 * sp);
    float travel = dir > 0.0 ? ease : 1.0 - ease;                      // 0..1 沿掃描軸
    float bx = mix(-halfw * 2.0 - 0.1, asp + halfw * 2.0 + 0.1, travel); // 帶中心 x（aspect 空間、進出畫面）
    vec2 p = vec2(uv.x * asp, uv.y);
    vec2 n = vec2(cos(ang), sin(ang));                                 // 帶法線（近垂直、可傾斜）
    float d = dot(p - vec2(bx, 0.5 + voff), n);
    float band = 1.0 - smoothstep(halfw * 0.6, halfw, abs(d));         // 帶內=1
    float ee = (abs(d) - halfw) / (halfw * 0.18);
    float edge = exp(-ee * ee);                                        // 邊緣亮線（玻璃緣）
    vec3 lit = raw * (1.0 + 0.25 * band);                             // 點亮：還原原色＋提亮
    col = mix(dim, lit, band);
    col += uColA * edge * 0.5;
  }
  return vec4(mix(raw, col, uAmt), src(uv).a);                         // 強度（0＝原圖）
}` };

export const BG_EFFECTS: BgEffect[] = [
  bulge, fisheye, fisheye2, twirl, ripple, impact, mirror, polar, displace, liquify, spooky, crossglass,
  rgbshift, chroma, grayscale, vignette, vhs, glitch, lightsweep,
  blur, triblur, hblur, vblur, zoomblur, tiltshift,
  snow, lightdots, glint,
];
export const BG_CATEGORIES: { name: string; ids: string[] }[] = [
  { name: "扭曲", ids: ["bulge", "fisheye", "fisheye2", "twirl", "ripple", "impact", "mirror", "polar", "displace", "liquify", "spooky", "crossglass"] },
  { name: "色彩", ids: ["rgbshift", "chroma", "grayscale", "vignette", "vhs", "glitch", "lightsweep"] },
  { name: "模糊", ids: ["blur", "triblur", "hblur", "vblur", "zoomblur", "tiltshift"] },
  { name: "粒子", ids: ["snow", "lightdots", "glint"] },
];

// 哪些濾鏡會動（需要每幀重畫，即使背景圖沒換）
const ANIMATED = new Set(["ripple", "vhs", "glitch", "displace", "liquify", "impact", "spooky", "snow", "lightdots", "glint", "lightsweep"]);
export function bgFiltersAnimated(filters: { fx: string }[]): boolean {
  return filters.some((f) => ANIMATED.has(f.fx));
}

export type BgFilterCall = { fx: string; amount: number; density?: number; speed?: number; angle?: number; angle2?: number; posX?: number; posY?: number; scale?: number; colorA?: string; colorB?: string };

const hexToRgb3 = (hex: string): [number, number, number] => {
  const h = (hex || "#ffffff").replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
};

export class BgFx {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject | null = null;
  private srcTex: WebGLTexture | null = null;
  private srcCanvas: HTMLCanvasElement;
  private srcCtx: CanvasRenderingContext2D | null = null;
  private srcImg: HTMLImageElement | null = null; // 上次上傳的圖（用參照比對，不讀 img.src）
  private srcW = 0;
  private srcH = 0;
  private srcZoom = 1; private srcOx = 0.5; private srcOy = 0.5; // 上次裁切（縮放/水平/垂直）
  private progs = new Map<string, Prog | null>();
  private byId = new Map<string, BgEffect>();
  private pCopy!: Prog;
  private fboA: FBO | null = null;
  private fboB: FBO | null = null;
  ok = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    for (const e of BG_EFFECTS) this.byId.set(e.id, e);
    this.srcCanvas = document.createElement("canvas");
    this.srcCtx = this.srcCanvas.getContext("2d");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) { this.gl = gl as unknown as WebGL2RenderingContext; return; }
    this.gl = gl;
    try {
      this.vao = gl.createVertexArray();
      this.srcTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.pCopy = this.link(COPY);
      this.ok = true;
    } catch (err) { console.error("[BgFx] 初始化失敗", err); }
  }

  private compile(type: number, s: string): WebGLShader {
    const gl = this.gl, sh = gl.createShader(type)!;
    gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader error");
    return sh;
  }
  private link(frag: string): Prog {
    const gl = this.gl, p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
    const u: Prog["u"] = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); if (info) u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  private programFor(fx: string): Prog | null {
    if (this.progs.has(fx)) return this.progs.get(fx)!;
    const eff = this.byId.get(fx);
    if (!eff) { this.progs.set(fx, null); return null; }
    try { const prog = this.link(HEADER + eff.frag + MAIN); this.progs.set(fx, prog); return prog; }
    catch (err) { console.error(`[BgFx] ${fx} 編譯失敗`, err); this.progs.set(fx, null); return null; }
  }

  private makeFBO(w: number, h: number): FBO {
    const gl = this.gl, tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }
  private delFBO(f: FBO | null) { if (!f) return; const gl = this.gl; gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); }
  private ensureFBO(w: number, h: number) {
    if (this.fboA && this.fboA.w === w && this.fboA.h === h) return;
    this.delFBO(this.fboA); this.delFBO(this.fboB);
    this.fboA = this.makeFBO(w, h); this.fboB = this.makeFBO(w, h);
  }

  resize(w: number, h: number) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }

  // 把背景圖 cover-fit（可選裁切）進來源 canvas → 上傳成貼圖（只有圖/尺寸/裁切變了才重做）
  // crop：zoom 縮放(1=cover-fit)、x/y 平移(0~1，0.5=置中)；不給＝置中 cover-fit（影片背景沿用原行為）。
  setSource(img: HTMLImageElement, W: number, H: number, crop?: { zoom?: number; x?: number; y?: number }) {
    if (!this.ok || !this.srcCtx) return;
    const z = crop?.zoom ?? 1, ox = crop?.x ?? 0.5, oy = crop?.y ?? 0.5;
    // ⚠️ 用「圖的物件參照＋尺寸＋裁切」當 key，千萬別讀 img.src：背景是 dataURL 時 src 是數 MB 的
    //    base64 字串，每幀拼接＋逐字比對會狂配記憶體噴 GC → 開濾鏡就爆卡。
    //    layer-render 的 getImage 在圖沒換時回傳同一個 <img> 實例，換圖才換參照，剛好可當便宜 key。
    if (img === this.srcImg && W === this.srcW && H === this.srcH && z === this.srcZoom && ox === this.srcOx && oy === this.srcOy) return;
    this.srcImg = img; this.srcW = W; this.srcH = H; this.srcZoom = z; this.srcOx = ox; this.srcOy = oy;
    const sc = this.srcCanvas; sc.width = W; sc.height = H;
    const cx = this.srcCtx;
    const k = Math.max(W / img.naturalWidth, H / img.naturalHeight) * z;
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    cx.clearRect(0, 0, W, H);
    cx.drawImage(img, (W - w) * ox, (H - h) * oy, w, h);  // ox/oy 0.5=置中、0~1 平移裁切
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); // canvas 上下相反 → 翻正
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  }

  private drawTo(target: FBO | null) {
    const gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 串接濾鏡鏈，最終畫到 canvas。filters 空 → 直接拷貝背景。
  render(filters: BgFilterCall[], time: number, energy = 0, beat = 0) {
    if (!this.ok) return;
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    this.ensureFBO(W, H);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const chain = filters.filter((f) => this.byId.has(f.fx) && this.programFor(f.fx));
    if (chain.length === 0) { // 無有效濾鏡 → 拷貝原圖
      gl.useProgram(this.pCopy.p);
      gl.uniform2f(this.pCopy.u.uRes!, W, H);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.uniform1i(this.pCopy.u.uSrc!, 0);
      this.drawTo(null);
      return;
    }

    let readTex = this.srcTex;
    let writeIdx = 0; // 0→A、1→B
    const fbos = [this.fboA!, this.fboB!];
    for (let i = 0; i < chain.length; i++) {
      const last = i === chain.length - 1;
      const prog = this.programFor(chain[i].fx)!;
      gl.useProgram(prog.p);
      if (prog.u.uRes) gl.uniform2f(prog.u.uRes, W, H);
      if (prog.u.uTime) gl.uniform1f(prog.u.uTime, time);
      if (prog.u.uPTime) gl.uniform1f(prog.u.uPTime, time - Math.floor(time / 7200) * 7200); // 包覆到 [0,7200)：float32 精度安全、wrap 每 2hr 才一次（一般 session 碰不到）
      if (prog.u.uAmt) gl.uniform1f(prog.u.uAmt, chain[i].amount);
      if (prog.u.uEnergy) gl.uniform1f(prog.u.uEnergy, energy);
      if (prog.u.uBeat) gl.uniform1f(prog.u.uBeat, beat);
      if (prog.u.uDensity) gl.uniform1f(prog.u.uDensity, chain[i].density ?? 0.35);
      if (prog.u.uSpeed) gl.uniform1f(prog.u.uSpeed, chain[i].speed ?? 0.4);
      if (prog.u.uAngle) gl.uniform1f(prog.u.uAngle, ((chain[i].angle ?? 0) * Math.PI) / 180);
      if (prog.u.uAngle2) gl.uniform1f(prog.u.uAngle2, ((chain[i].angle2 ?? 135) * Math.PI) / 180);
      if (prog.u.uPosX) gl.uniform1f(prog.u.uPosX, chain[i].posX ?? 0.5);
      if (prog.u.uPosY) gl.uniform1f(prog.u.uPosY, chain[i].posY ?? 0.5);
      if (prog.u.uGScale) gl.uniform1f(prog.u.uGScale, chain[i].scale ?? 1);
      if (prog.u.uColA) { const c = hexToRgb3(chain[i].colorA ?? "#ffffff"); gl.uniform3f(prog.u.uColA, c[0], c[1], c[2]); }
      if (prog.u.uColB) { const c = hexToRgb3(chain[i].colorB ?? "#bfe0ff"); gl.uniform3f(prog.u.uColB, c[0], c[1], c[2]); }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, readTex); if (prog.u.uSrc) gl.uniform1i(prog.u.uSrc, 0);
      const target = last ? null : fbos[writeIdx];
      this.drawTo(target);
      if (!last) { readTex = fbos[writeIdx].tex; writeIdx ^= 1; }
    }
  }

  destroy() {
    if (!this.ok) return;
    const gl = this.gl;
    for (const pr of this.progs.values()) if (pr) gl.deleteProgram(pr.p);
    if (this.pCopy) gl.deleteProgram(this.pCopy.p);
    this.delFBO(this.fboA); this.delFBO(this.fboB);
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}

// 縮圖用：模組級共用一個離屏引擎，把一張示意背景套上單一濾鏡 → 渲染單幀（給濾鏡選單預覽）。
let thumbEngine: BgFx | null = null;
let thumbImg: HTMLImageElement | null = null;
let thumbReady = false;
export function setBgThumbSource(url: string) {
  if (thumbImg && thumbImg.src.endsWith(url)) return;
  thumbImg = new Image();
  thumbReady = false;
  thumbImg.onload = () => { thumbReady = true; };
  thumbImg.src = url;
}
export function renderBgThumb(fx: string, dst: HTMLCanvasElement, amount = 0.7): boolean {
  if (!thumbImg || !thumbReady) return false;
  if (!thumbEngine) {
    const c = document.createElement("canvas"); c.width = 240; c.height = 135;
    thumbEngine = new BgFx(c);
  }
  if (!thumbEngine.ok) return false;
  thumbEngine.resize(240, 135);
  thumbEngine.setSource(thumbImg, 240, 135);
  thumbEngine.render([{ fx, amount }], 1.2);
  const ctx = dst.getContext("2d"); if (!ctx) return false;
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.drawImage(thumbEngine.canvas, 0, 0, dst.width, dst.height);
  return true;
}
