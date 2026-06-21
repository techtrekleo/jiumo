// 九墨「GPU 光效」引擎 — 原生 WebGL2，跟墨流（FluidCore）同技術棧、零新依賴。
// 每個特效＝一支 fragment shader（提供 `vec4 effect(vec2 uv)`），FFT 當 1D 貼圖餵進去。
// 渲染管線（學 vizzy/ShaderToy 的高級感來源）：
//   1) 特效 shader → sceneFBO（用 SDF 距離場畫乾淨形狀、餘弦調色盤上色）
//   2) 亮部抽出（軟膝閾值）→ 半解析度
//   3) 可分離高斯模糊 H、V → 得到 bloom
//   4) 合成：scene + bloom，tone mapping 柔性壓縮 → premultiplied 輸出
// 結果用跟墨流一樣的 ctx2d.drawImage 合成進 2D 舞台。

export type GpuEffect = { id: string; name: string; category: string; frag: string; ink?: boolean };

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type FBO = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

const FREQ_BINS = 2048; // = fftSize 4096 的 frequencyBinCount（高解析度 → bar 各自獨立）

// 全螢幕三角形（gl_VertexID，免頂點緩衝）
const VERT = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// 特效共用 header：uniforms + 感知頻譜 + SDF + 調色 + 雜訊
const HEADER = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime, uSens, uBeat, uBass, uMid, uTreble;
uniform float uWidth, uSpacing; // 粗細（條寬/線寬/點大小）、間距（條數疏密），預設 1
uniform float uBalance;         // 高低頻平衡：<0 抬低頻、>0 抬高頻，0=中性
uniform float uBeatPhase;       // 距上個重音多久（0=剛下→1=傳遞完成→>1淡出；9=無重音）。給「重音漣漪」用
uniform float uPaper;         // 1=宣紙(深墨，給 ctx2d multiply) 0=夜紙/暗底(亮墨，給 lighter+bloom)
uniform vec3 uC0, uC1, uC2;   // primary / secondary / accent
uniform sampler2D uFreq;
uniform float uScale;   // 頻率刻度（X 軸分布）：0 對數log / 1 線性linear / 2 Bark / 3 Mel（借鏡 audioMotion frequencyScale）
uniform float uWeight;  // 加權（決定圖型高低）：0 預設(九墨手刻) / 1 A / 2 B / 3 C（借鏡 audioMotion weightingFilter）

// ── audioMotion 頻率刻度：Hz↔刻度值（精確公式），把 X 位置 t 映到對應頻段 ──
float fScale(float f){
  if (uScale < 0.5) return log2(f);                          // log
  if (uScale < 1.5) return f;                                // linear
  if (uScale < 2.5) return (26.81 * f) / (1960.0 + f) - 0.53; // bark
  return log2(1.0 + f / 700.0);                              // mel
}
float fInv(float x){
  if (uScale < 0.5) return exp2(x);
  if (uScale < 1.5) return x;
  if (uScale < 2.5) return 1960.0 / (26.81 / (x + 0.53) - 1.0);
  return 700.0 * (exp2(x) - 1.0);
}
// t∈[0,1]（X 位置）→ 正規化貼圖座標(freq/nyquist)。log 模式與原本 lo*pow(hi/lo,t) 逐位元一致。
float scaleCoord(float t){
  float FMIN = (2.0/2048.0) * 22050.0, FMAX = 0.46 * 22050.0; // ~21.5Hz ~10kHz（同原 lo/hi）
  float s = mix(fScale(FMIN), fScale(FMAX), clamp(t, 0.0, 1.0));
  return clamp(fInv(s) / 22050.0, 0.0, 0.999);
}
// ── audioMotion 加權曲線：給頻率回傳 dB（A/B/C），1kHz≈0dB ──
float linearTodB(float x){ return 8.6858896 * log(max(x, 1e-12)); } // 20/ln(10)
float weightDb(float f){
  if (uWeight < 0.5) return 0.0;
  float f2 = f * f;
  float s206 = 424.36, s1077 = 11599.29, s1585 = 25122.25, s7379 = 544496.41, s12194 = 148693636.0;
  if (uWeight < 1.5) return 2.0  + linearTodB((s12194 * f2 * f2) / ((f2 + s206) * sqrt((f2 + s1077) * (f2 + s7379)) * (f2 + s12194))); // A
  if (uWeight < 2.5) return 0.17 + linearTodB((s12194 * f2 * f)  / ((f2 + s206) * sqrt(f2 + s1585) * (f2 + s12194)));                 // B
  return 0.06 + linearTodB((s12194 * f2) / ((f2 + s206) * (f2 + s12194)));                                                            // C
}
// 取樣後的高度加權：uWeight=0 走原本九墨手刻曲線（預設不變）；否則套 audioMotion 加權（dB→/70 正規化位移）＋平衡度。
float applyWeight(float v, float t){
  float fHz = scaleCoord(t) * 22050.0;
  float bal = clamp(1.0 + uBalance*(t-0.5)*2.0, 0.0, 2.5);
  if (uWeight < 0.5) {
    float lowcut = (fHz/100.0) / (1.0 + fHz/100.0);
    float hicut  = 1.0 / (1.0 + (fHz/14000.0)*(fHz/14000.0));
    return clamp(v * (0.45 + 0.9*lowcut) * hicut * bal, 0.0, 1.0);
  }
  return clamp((v + weightDb(fHz) / 70.0) * bal, 0.0, 1.0);
}
// 感知頻譜：依 uScale 把 X 位置映到頻段、取「這根 bar 涵蓋頻段內的峰值」(5 tap max) → 各 bar 解耦獨立、抓得到瞬態。
float spec(float t){
  t = clamp(t, 0.0, 1.0);
  float dt = 0.009; // bar 半寬（X 空間）
  float c0 = scaleCoord(t - dt), c1 = scaleCoord(t + dt);
  float v = 0.0;
  for (int i = 0; i < 5; i++) v = max(v, texture(uFreq, vec2(mix(c0, c1, float(i)/4.0), 0.5)).r);
  return applyWeight(v, t);
}
float specSym(float a){ return spec(abs(a)/3.14159265); }
// 控制卡用：線性頻段取樣（bandStart~bandEnd 是 len 分數）＋3-tap 峰值＋平衡度傾斜＋靈敏度當主增益（反應強、sens 拉滿很猛）
float cardSamp(float bandStart, float bandEnd, float t){
  float x = clamp(mix(bandStart, bandEnd, t), 0.0, 0.46);
  float v = 0.0;
  for(int i=0;i<3;i++) v = max(v, texture(uFreq, vec2(clamp(x + (float(i)-1.0)*0.005, 0.0, 0.46), 0.5)).r);
  float bal = clamp(1.0 + uBalance*((x/0.46)*2.0-1.0)*1.6, 0.0, 2.6);
  return clamp(v * bal * (0.5 + uSens), 0.0, 1.5);
}
// 軟性高度上限：tanh 壓縮 → 大聲時平滑收在 cap 下、不撞頂壓平、保留波形相對差異
float softH(float x, float cap){ return cap * tanh(x / cap); }

// 調色：三色平滑漸層 ＋ IQ 餘弦調色盤（要彩虹時用）
vec3 ramp(float t){ t = clamp(t,0.0,1.0); return t < 0.5 ? mix(uC0, uC1, t*2.0) : mix(uC1, uC2, (t-0.5)*2.0); }
vec3 cospal(float t){ return 0.5 + 0.5*cos(6.28318*(t + vec3(0.0,0.33,0.67))); }
// 墨色輸出：宣紙→深墨(被 multiply 壓進紙)；夜紙/暗底→亮墨(被 lighter 疊加、吃 bloom)。回傳 premultiplied。
vec4 inkOut(float amt, vec3 darkInk, vec3 brightInk){
  amt = clamp(amt, 0.0, 1.0);
  vec3 c = uPaper > 0.5 ? darkInk : brightInk;
  return vec4(c*amt, amt);
}

// SDF 距離場（vizzy 的形狀都是這樣設定的）
float sdCircle(vec2 p, float r){ return length(p) - r; }
float sdRing(vec2 p, float r){ return abs(length(p) - r); }
float sdSegment(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*h); }
float sdBox(vec2 p, vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,d.y),0.0); }
// SDF → 銳利填充（隨解析度自動抗鋸齒）
float fill(float d){ float w = fwidth(d)*1.2; return smoothstep(w, -w, d); }
// SDF → 發光：峰值 1（d=0）、k 控制銳利度（越大越緊）。bloom 後製會再暈開
float glow(float d, float k){ return 1.0 / (1.0 + abs(d)*k); }

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*noise(p); p=p*2.02+1.7; a*=0.5; } return s; }
`;

// uv 已做長寬比校正（p）。effect 回傳 emissive 顏色（rgb）+ 覆蓋率（a）
const MAIN = `
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  fragColor = effect(uv);
}`;

/* ───────── 後製 shader ───────── */
const POST_HEAD = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
vec2 uv(){ return gl_FragCoord.xy / uRes; }
`;
// 亮部抽出（軟膝閾值：只讓夠亮的部分泛光）
const POST_BRIGHT = POST_HEAD + `
uniform sampler2D uTex;
void main(){ vec3 c = texture(uTex, uv()).rgb; float l = dot(c, vec3(0.299,0.587,0.114));
  o = vec4(c * smoothstep(0.5, 1.3, l), 1.0); }`; // HDR：只讓真正的高光泛光
// 可分離高斯模糊（9 tap）
const POST_BLUR = POST_HEAD + `
uniform sampler2D uTex;
uniform vec2 uDir;
void main(){
  vec2 p = uv();
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 s = texture(uTex, p).rgb * w[0];
  for(int i=1;i<5;i++){ vec2 d = uDir*float(i); s += texture(uTex, p+d).rgb*w[i]; s += texture(uTex, p-d).rgb*w[i]; }
  o = vec4(s, 1.0);
}`;
// 合成：scene + bloom，tone mapping 柔性壓縮，輸出 premultiplied（emissive over 背景）
const POST_COMP = POST_HEAD + `
uniform sampler2D uScene, uBloom;
uniform float uBloomStr, uGain, uFeather, uInk;
vec3 tonemap(vec3 x){ return (x*(2.51*x+0.03)) / (x*(2.43*x+0.59)+0.14); } // ACES 近似
void main(){
  vec2 p = uv();
  vec4 sc = texture(uScene, p);
  if(uInk > 0.5){ o = sc; return; }   // 墨模式：直接輸出深墨場景(premult)，不過 bloom/tonemap
  vec3 bl = texture(uBloom, p).rgb;
  vec3 col = tonemap((sc.rgb + bl*uBloomStr) * uGain); // uGain＝整體亮度、uBloomStr＝泛光強度
  // alpha 只看「場景本身」（不含 bloom 霧）→ 空白處真的透明、不被泛光霧填成矩形框（學點狀）。
  // bloom 仍進 col → 有內容的地方一樣會亮會發光，只是不會把光暈鋪滿整個框。
  float sLuma = dot(tonemap(sc.rgb * uGain), vec3(0.299,0.587,0.114));
  float a = clamp(max(sc.a, sLuma * 1.35), 0.0, 1.0);
  // 橢圓羽化：內容向框邊漸隱、把角落收掉 → 縮小特效時無矩形硬邊、無縫融進背景。
  // uFeather：全螢幕=0（維持原樣）、縮小=1（套用暈影）
  float vig = smoothstep(1.0, 0.64, length((p - 0.5) * 2.0));
  a *= mix(1.0, vig, uFeather);
  o = vec4(col * a, a);
}`;

/* ───────── 5 支招牌 shader ───────── */

// 聲紋球（vizzy 招牌 hero）：中央漸層球被低頻撐大，外圈頻譜變形成平滑輪廓 + 強 bloom
const orb: GpuEffect = {
  id: "gv-orb", name: "聲紋球", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x);
  // 球半徑被低頻包絡撐大；外緣被頻譜平滑變形
  float base = 0.18 + uBass*0.12*uSens;
  float wobble = (specSym(a)*0.5 + specSym(a + 1.7)*0.3) * 0.10 * uSens;
  float edge = base + wobble;
  float d = sdCircle(p, edge);
  // 填充核心（中心亮、邊緣濃）+ 邊緣亮環 + 外圍 bloom 種子
  float core = fill(d);
  float rim = glow(d, 80.0);
  float halo = glow(d, 22.0)*0.35;
  float grad = smoothstep(edge, 0.0, r); // 由內而外
  vec3 c = mix(uC2, uC0, grad);
  c = mix(c, uC1, smoothstep(0.0, edge, r)*0.5);
  float inten = core*(0.6+grad*1.1) + rim*(1.1+uBeat*1.2) + halo;
  return vec4(c*inten, clamp(core + rim*0.6 + halo*0.4, 0.0, 1.0));
}` };

// 光環：放射狀頻譜刺 + 內圈亮環，全靠 bloom 暈開
const radialGlow: GpuEffect = {
  id: "gv-radial-glow", name: "光環", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0);
  float r = length(p), a = atan(p.y, p.x);
  float R = 0.17 + uBass*0.06*uSens;
  // 內圈亮環
  float ring = glow(sdRing(p, R), 70.0);
  // 放射刺：依角度取頻譜，畫從 R 往外的線段
  float ai = floor((a/6.28318 + 0.5)*72.0);
  float ang = (ai/72.0 - 0.5)*6.28318;
  float sp = pow(specSym(ang), 1.3);
  vec2 dir = vec2(cos(ang), sin(ang));
  float spike = glow(sdSegment(p, dir*R, dir*(R + sp*0.22*uSens)), 40.0)*sp;
  vec3 c = mix(uC0, uC2, sp);
  c = mix(c, cospal(a/6.28318 + uTime*0.03), 0.25);
  float inten = ring*(0.8+uBeat) + spike*1.2;
  return vec4(c*inten, clamp(ring*0.5 + spike*0.6, 0.0, 1.0));
}` };

// 聲波漣漪：節拍打出向外擴散的 SDF 同心環
const ripples: GpuEffect = {
  id: "gv-ripples", name: "聲波漣漪", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0);
  float r = length(p);
  float acc = 0.0; vec3 c = vec3(0.0);
  for(int i=0;i<5;i++){
    float fi = float(i);
    float phase = fract(uTime*0.16 + fi*0.21);
    float rr = phase*0.62;
    float band = spec(0.08 + fi*0.18);
    float ring = glow(sdRing(p, rr), 90.0) * (0.3+band) * (1.0-phase);
    acc += ring; c += ring * mix(uC0, uC2, fi/4.0);
  }
  float core = glow(sdCircle(p, 0.02 + uBass*0.04*uSens), 30.0)*(0.6+uBass);
  c += core*uC2;
  float inten = (acc + core)*(1.0+uBeat*0.3);
  return vec4(c*inten, clamp(acc*0.5 + core*0.5, 0.0, 1.0));
}` };

// 墨色星雲：fbm 流動雲團 + 餘弦調色盤，低頻撐亮、高頻細閃
const nebula: GpuEffect = {
  id: "gv-nebula", name: "墨色星雲", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y,1.0)*2.2;
  float t = uTime*0.06;
  vec2 q = vec2(fbm(p+vec2(t,0.0)), fbm(p+vec2(5.2,t*1.3)));
  float f = pow(fbm(p + q*1.8 + t*0.5), 1.6);
  float bass = uBass*uSens;
  float spk = spec(0.5 + 0.5*fract(f*3.0));
  float inten = f*(0.45+bass*1.4) + spk*uTreble*0.6 + uBeat*f*0.4;
  vec3 c = mix(uC0, uC1, f);
  c = mix(c, uC2, smoothstep(0.6, 1.0, f + bass*0.3));
  c = mix(c, cospal(f*0.6 + 0.1), 0.18);
  inten = clamp(inten*1.25, 0.0, 1.5);
  return vec4(c*inten, clamp(inten, 0.0, 1.0));
}` };

// 統一頻譜：一支可參數化的頻譜，吃 uShape(形狀)/uMirrorV(上下鏡像)/uMirrorH(左右鏡像)/uCap(峰頂上限)。
// 取代「霓虹/鏡像/鏡譜/簇譜」四支各自寫死 → 使用者自行勾選組合。高度共用 gamma 尖峰銳化(同霓虹)。
const spectrum: GpuEffect = {
  id: "gv-spectrum", name: "頻譜", category: "GPU 光效",
  frag: `
uniform float uShape;    // 0 Curve / 1 Bars / 2 Stepped Bars / 3 Level Meter / 4 Stepped Level Meter
uniform float uMirrorV;  // 上下鏡像（中心線往上下各長）
uniform float uMirrorH;  // 左右鏡像（中央低頻、兩側對稱）
uniform float uCap;      // 峰頂上限（半高，預設 0.55）
uniform sampler2D uFreqR; // 右聲道頻譜（立體聲分離用）
uniform float uStereo;    // 1=左右分離（畫面左半取左聲道 uFreq、右半取右聲道 uFreqR；自動走蝴蝶佈局）
uniform float uRadial;    // 1=環狀（圓形放射；低頻在中軸、左右鏡射對稱）
uniform float uSpin;      // 環狀旋轉速度（弧度/秒，可負）
uniform float uReflex;    // 水面倒影 0..1（>0 抬高基線、下方畫往下漸淡的鏡像）
uniform float uOutline;   // 1=長條鏤空描邊（只留邊框、中空透氣）
uniform float uPeakOn;    // 1=峰頂浮標（讀 uPeak 保持峰值、柱頂畫亮線、曲線畫 peak line）
uniform sampler2D uPeak, uPeakR; // 峰值保持頻譜（hold+重力，主/左、右）
float specRaw2(float t){  // 右聲道感知頻譜（同 spec 的刻度＋加權、改取 uFreqR）
  t = clamp(t, 0.0, 1.0); float dt = 0.009;
  float c0 = scaleCoord(t - dt), c1 = scaleCoord(t + dt);
  float v = 0.0; for (int i = 0; i < 5; i++) v = max(v, texture(uFreqR, vec2(mix(c0, c1, float(i)/4.0), 0.5)).r);
  return applyWeight(v, t);
}
float specPk(float t){  // 峰值保持頻譜（同刻度＋加權、改取 uPeak）— GLSL ES 不能傳 sampler，只好複寫取樣
  t = clamp(t, 0.0, 1.0); float dt = 0.009;
  float c0 = scaleCoord(t - dt), c1 = scaleCoord(t + dt);
  float v = 0.0; for (int i = 0; i < 5; i++) v = max(v, texture(uPeak, vec2(mix(c0, c1, float(i)/4.0), 0.5)).r);
  return applyWeight(v, t);
}
float specPkR(float t){  // 峰值保持頻譜（右聲道，改取 uPeakR）
  t = clamp(t, 0.0, 1.0); float dt = 0.009;
  float c0 = scaleCoord(t - dt), c1 = scaleCoord(t + dt);
  float v = 0.0; for (int i = 0; i < 5; i++) v = max(v, texture(uPeakR, vec2(mix(c0, c1, float(i)/4.0), 0.5)).r);
  return applyWeight(v, t);
}
// 高度映射：sens 當純增益(不預先 clamp 飽和→不會把整排夾成同高)，Reinhard 軟壓縮 cap·x/(x+k) 趨近 cap 但永不碰頂
// → 即使靈敏度拉滿(3×)，大聲的柱子之間仍保留高低差、不壓成一條平天花板。永遠 < cap 故必留餘量。
float toH(float s, float fx){ s = clamp(s, 0.0, 1.0); float x = pow(s, 2.2) * mix(1.1, 1.35, fx) * uSens * 2.4; float cap = max(uCap, 0.05); return cap * x / (x + 0.5); }
float specHeight(float fx, float sx){  // sx=畫面 x；立體聲分離時右半取右聲道
  fx = clamp(fx, 0.0, 1.0);
  return toH((uStereo > 0.5 && sx >= 0.5) ? specRaw2(fx) : spec(fx), fx);
}
float peakHeight(float fx, float sx){  // 同一套高度轉換、改吃保持峰值 → 浮標位置和柱頂對齊
  fx = clamp(fx, 0.0, 1.0);
  return toH((uStereo > 0.5 && sx >= 0.5) ? specPkR(fx) : specPk(fx), fx);
}
// 環狀頻譜：極座標放射，低頻在中軸、左右鏡射對稱，可隨 uSpin 慢轉
vec4 radialSpectrum(vec2 uv){
  vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);   // 修正長寬比 → 真圓
  float rad = length(q);
  float a01 = fract((atan(q.y, q.x) + uTime * uSpin) * 0.15915494 + 0.5); // 角度 0..1（含旋轉）
  bool stepped = (uShape > 1.5 && uShape < 2.5) || uShape > 3.5;
  bool curve = uShape < 0.5;
  float R0 = 0.11, ext = 0.30;                         // 內環半徑、徑向延伸
  float intensity = 0.0, alpha = 0.0, colT;
  if (curve) {
    float fx = abs(a01 * 2.0 - 1.0); colT = fx;
    float top = R0 + specHeight(fx, uv.x) * ext;
    float inside = step(rad, top) * step(R0, rad);
    float edge = glow(rad - top, 170.0);
    intensity = inside * 0.30 + edge * 0.85;
    alpha = clamp(inside * 0.38 + edge * 0.75, 0.0, 1.0);
    if (uPeakOn > 0.5) { float pk = glow(rad - (R0 + peakHeight(fx, uv.x) * ext), 220.0); intensity += pk * 0.8; alpha = clamp(alpha + pk * 0.6, 0.0, 1.0); }
  } else {
    float n = floor(72.0 / clamp(uSpacing, 0.4, 2.5));
    float fc = (floor(a01 * n) + 0.5) / n;
    float fx = abs(fc * 2.0 - 1.0); colT = fx;
    float top = R0 + specHeight(fx, uv.x) * ext;
    float ga = fract(a01 * n) - 0.5;
    float bw = 0.5 * clamp(uWidth, 0.25, 1.6);
    float inside = step(abs(ga), bw) * step(R0, rad) * step(rad, top);
    if (stepped) inside *= step(0.22, fract((rad - R0) * 46.0));
    float edge = glow(rad - top, 130.0) * step(abs(ga), bw);
    float body = inside;
    if (uOutline > 0.5) {  // 鏤空：徑向兩側細邊＋頂緣
      float side = smoothstep(bw, bw - 0.012, abs(ga)) - smoothstep(bw - 0.03, bw - 0.042, abs(ga));
      body = max(side * step(R0, rad) * step(rad, top), edge);
    }
    intensity = body * 0.42 + edge * 0.7;
    alpha = clamp(body * 0.5 + edge * 0.45, 0.0, 1.0);
    if (uPeakOn > 0.5) { float pk = glow(rad - (R0 + peakHeight(fx, uv.x) * ext), 200.0) * step(abs(ga), bw); intensity += pk * 0.9; alpha = clamp(alpha + pk * 0.7, 0.0, 1.0); }
  }
  float ring = glow(rad - R0, 240.0) * 0.16;            // 內環細線
  vec3 c = ramp(colT) * (1.0 + uBeat * 0.4);
  return vec4(c * intensity + mix(uC1, vec3(1.0), 0.3) * ring, clamp(alpha + ring * 0.5, 0.0, 1.0));
}
vec4 effect(vec2 uv){
  if (uRadial > 0.5) return radialSpectrum(uv);
  bool mh = uMirrorH > 0.5 || uStereo > 0.5, mv = uMirrorV > 0.5; // 立體聲分離 → 強制蝴蝶（中央低頻、左右各一聲道）
  bool meter   = uShape > 2.5;                                    // 3,4 = Level Meter 家族
  bool stepped = (uShape > 1.5 && uShape < 2.5) || uShape > 3.5;  // 2,4 = LED 分段
  bool curve   = uShape < 0.5;                                    // 0 = 連續曲線
  float xm = mh ? abs(uv.x - 0.5) * 2.0 : uv.x;                   // 左右鏡像 → 中央低頻、兩側對稱
  float B = mv ? 0.0 : mix(0.13, 0.34, clamp(uReflex, 0.0, 1.0)); // 倒影開→抬高基線、下方留空間
  float yLevel = mv ? abs(uv.y - 0.5) : (uv.y - B);              // 沿成長方向的距離
  float intensity = 0.0, alpha = 0.0, colT = xm;
  if (curve) {
    float h = specHeight(xm, uv.x);
    float hg = mv ? h * 0.55 : h;                                 // 鏡像時半高收斂、不超出畫布
    float inside = step(yLevel, hg) * (mv ? 1.0 : step(0.0, yLevel));
    float edge = glow(yLevel - hg, 210.0);                        // 頂緣亮線
    float fillGrad = inside * mix(0.5, 0.12, clamp(yLevel / max(hg, 1e-3), 0.0, 1.0)); // 線下漸層填色（近基線實、近頂淡）→ 有體積
    intensity = fillGrad + edge * 0.9;
    alpha = clamp(fillGrad * 1.1 + edge * 0.8, 0.0, 1.0);
    if (!mv && uReflex > 0.001) {                                 // 水面倒影
      float yb = B - uv.y;                                        // >0 = 基線下方
      float fade = clamp(1.0 - yb / max(B, 1e-3), 0.0, 1.0);
      float insR = step(0.0, yb) * step(yb, hg);
      float fR = insR * mix(0.4, 0.1, clamp(yb / max(hg, 1e-3), 0.0, 1.0)) * fade * uReflex * 0.7;
      float eR = glow(yb - hg, 210.0) * fade * uReflex * 0.6;
      intensity += fR + eR; alpha = clamp(alpha + fR * 1.1 + eR * 0.7, 0.0, 1.0);
    }
    if (uPeakOn > 0.5) {                                          // peak line（曲線：全幅峰值線）
      float phg = (mv ? 0.55 : 1.0) * peakHeight(xm, uv.x);
      float pm = glow(yLevel - phg, 230.0);
      intensity += pm * 0.8; alpha = clamp(alpha + pm * 0.6, 0.0, 1.0);
    }
  } else {
    float n = floor((meter ? 46.0 : 58.0) / clamp(uSpacing, 0.4, 2.5));
    float col = floor(xm * n);
    colT = (col + 0.5) / n;
    float h = specHeight(colT, uv.x);
    float hg = mv ? h * 0.55 : h;
    float bw = (meter ? 0.45 : 0.32) * clamp(uWidth, 0.25, 1.6); // 半寬（cell 0.5＝滿格；meter 較粗）
    float gx = fract(xm * n) - 0.5;
    float r = meter ? 0.0 : clamp(h * 0.1, 0.0025, 0.02);        // Bars 圓角、Meter 直角
    vec2 p = vec2(gx, mv ? (uv.y - 0.5) : (uv.y - (B + hg * 0.5)));
    vec2 bb = vec2(bw, mv ? max(hg, 0.0006) : max(hg * 0.5, 0.0006));
    float d = sdBox(p, bb) - r;
    float body;
    if (uOutline > 0.5 && !meter) {                              // 鏤空描邊：只留邊框
      float th = 0.004 + 0.003 * clamp(uWidth, 0.3, 1.6);
      body = (1.0 - smoothstep(th, th + fwidth(d) * 1.5, abs(d))) * (mv ? 1.0 : step(0.0, yLevel));
    } else {
      body = fill(d) * (mv ? 1.0 : step(0.0, yLevel));
      if (stepped) body *= step(0.2, fract(yLevel * 16.0));      // LED 分段（每塊 20% 空隙）
    }
    float g = glow(d, meter ? 70.0 : 120.0) * (meter ? 0.35 : 0.45);
    float capL = 0.0;
    if (meter) {                                                  // Level Meter 峰值橫線
      float capMask = smoothstep(bw + 0.02, bw - 0.01, abs(gx));
      capL = (mv ? (glow(uv.y - (0.5 + hg), 240.0) + glow(uv.y - (0.5 - hg), 240.0))
                 : glow(uv.y - (B + hg), 240.0)) * capMask;
    }
    intensity = body + g * (0.6 + uBeat * 0.5) + capL * 0.9;
    alpha = clamp(body + g * 0.3 + capL * 0.8, 0.0, 1.0);
    if (uPeakOn > 0.5 && !meter) {                               // 峰頂浮標（限在柱寬內）
      float phg = (mv ? 0.55 : 1.0) * peakHeight(colT, uv.x);
      float pm = glow(yLevel - phg, 200.0) * smoothstep(bw + 0.02, bw - 0.01, abs(gx));
      intensity += pm * 0.95; alpha = clamp(alpha + pm * 0.7, 0.0, 1.0);
    }
    if (!mv && !meter && uReflex > 0.001) {                      // 水面倒影（鏡像柱）
      float yb = B - uv.y;
      float dr = sdBox(vec2(gx, yb - hg * 0.5), vec2(bw, max(hg * 0.5, 0.0006))) - r;
      float bodyR = fill(dr) * step(0.0, yb);
      if (stepped) bodyR *= step(0.2, fract(yb * 16.0));
      float fade = clamp(1.0 - yb / max(B, 1e-3), 0.0, 1.0);
      float add = (bodyR * 0.55 + glow(dr, 120.0) * 0.4) * fade * uReflex;
      intensity += add; alpha = clamp(alpha + add * 0.9, 0.0, 1.0);
    }
  }
  float spine = mv ? glow(abs(uv.y - 0.5) - 0.0025, 300.0) * 0.22 : 0.0; // 上下鏡像中心脊
  vec3 c = ramp(colT) * (1.0 + uBeat * 0.4);
  vec3 spineC = mix(uC1, vec3(1.0), 0.3);
  return vec4(c * intensity + spineC * spine, clamp(alpha + spine * 0.55, 0.0, 1.0));
}` };

// 點狀頻譜：發光點陣，每行依頻譜高度由中線往上下亮起來
const dots: GpuEffect = {
  id: "gv-dots", name: "點狀頻譜", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  float nx = floor(60.0 / clamp(uSpacing, 0.4, 2.5)), ny = 22.0; // 間距大→點數少
  float h = softH(pow(spec(uv.x), 1.3) * uSens * 0.5, 0.36); // 軟上限（中央往上下各長，留邊距）
  vec2 g = vec2(uv.x*nx, (uv.y-0.5)*ny);
  vec2 cell = fract(g) - 0.5;
  vec2 id = floor(g);
  float rowY = abs((id.y+0.5)/ny);          // 距中線（0~0.5）
  float on = smoothstep(h+0.02, h-0.02, rowY); // 在高度內才亮
  float dot = glow(length(cell) - 0.06*clamp(uWidth, 0.3, 2.2), 60.0); // 粗細＝點大小
  vec3 c = ramp((id.x+0.5)/nx);
  float inten = dot*on*(0.7+uBeat*0.4);
  return vec4(c*inten, clamp(inten, 0.0, 1.0));
}` };

// 波形線：跟著頻譜起伏的發光曲線
const wave: GpuEffect = {
  id: "gv-wave", name: "波形線", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  float s = pow(spec(uv.x), 0.9);
  float disp = (s - 0.3) * 0.4 * uSens;
  disp = 0.24 * tanh(disp / 0.24);              // 軟上限 ±0.24 → 線最高 ~0.74、留 26% 空間不貼頂壓平
  float lineY = 0.5 + disp;
  float d = abs(uv.y - lineY);
  float line = glow(d, 110.0 / clamp(uWidth, 0.4, 2.8)); // 粗細＝線寬（k 越小線越粗）
  // 線下方漸層（往下淡出、不填滿整塊）→ 底部透出背景
  float under = smoothstep(lineY - 0.28, lineY, uv.y) * step(uv.y, lineY) * 0.28;
  vec3 c = mix(uC0, uC2, uv.x) * (1.0 + uBeat*0.4);
  float inten = line*(1.0+uBeat*0.5) + under;
  return vec4(c*inten, clamp(line + under*0.6, 0.0, 1.0));
}` };

// 粒子場：程序生成的發光粒子，密度/亮度隨低頻脈動、隨時間漂移
const particles: GpuEffect = {
  id: "gv-particles", name: "粒子場", category: "GPU 光效",
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0)*7.0;
  vec2 gp = floor(p);
  float acc = 0.0; vec3 c = vec3(0.0);
  for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++){
    vec2 cell = gp + vec2(float(i), float(j));
    float h1 = hash(cell), h2 = hash(cell+5.3), h3 = hash(cell+11.7);
    float exists = step(0.42, h3);              // 僅約六成 cell 有粒子 → 稀疏不成格
    // 位置隨機落在 cell 內任意處（非中心）→ 打散格線；再隨時間漂移
    vec2 pos = cell + vec2(h1, h2) + 0.16*vec2(sin(uTime*0.5 + h1*6.2832), cos(uTime*0.45 + h2*6.2832));
    float band = spec(fract(h1*2.0));
    float sz = 0.05 + 0.09*h2;
    // 緊湊衰減（smoothstep 在半徑外即為 0，不像 glow 1/(1+kd) 有無限長尾）→ 光點完整落在 3x3 鄰域、
    // 不被格邊裁切；亮芯＋柔光暈(sz*4，仍 <1 格)。每顆亮度再隨機(0.45~1)打散均勻感。
    float dl = length(p - pos);
    float pt = (smoothstep(sz, 0.0, dl) + smoothstep(sz*4.0, 0.0, dl)*0.35) * (0.06 + band*1.4 + uBass*uSens*0.8) * exists * (0.45 + 0.55*h2);
    acc += pt; c += pt * mix(uC0, uC2, h2);
  }
  float inten = acc*(0.85 + uBeat*0.4);
  return vec4(c*inten, clamp(acc*0.9, 0.0, 1.0));
}` };

/* ───────── 墨象 · 東方系列（九墨主題）─────────
   都走「深底＋亮墨痕」→ 完美吃 bloom 給氣韻。共用 spec()/fbm/SDF，零新接線。 */

// 枯山水音流漣漪：細耙紋同心圓 + 有機擾動 + 砂粒噪。頻段對應半徑、石子落水往外擴散
const zenGarden: GpuEffect = {
  id: "gv-zen-garden", name: "枯山水漣漪", category: "墨象 · 東方", ink: true,
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0);
  float bass = uBass*uSens;
  // 有機擾動半徑：破掉「完美同心圓」的數位感，像手耙的砂
  float warp = (fbm(p*2.4 + 11.0)-0.5)*0.05;
  float r = length(p) + warp;
  float band = spec(clamp(r/0.62, 0.0, 1.0));               // 該半徑對應頻段（內低外高）
  float ripple = band*(0.04 + bass*0.10);
  float rings = 40.0 / clamp(uSpacing, 0.5, 2.0);
  float phase = (r - uTime*0.045 - ripple)*rings;
  // 細耙紋：每週期一條細線（線寬可調），頻段越強線越深 → 漣漪感
  float fr = abs(fract(phase) - 0.5)*2.0;
  float lineW = 0.34 / clamp(uWidth, 0.4, 2.0);
  float line = smoothstep(lineW, 0.0, fr) * (0.45 + 0.55*band);
  // 石子落水：兩圈往外擴散的環
  float pulse = 0.0;
  for(int i=0;i<2;i++){
    float ph = fract(uTime*0.12 + float(i)*0.5);
    pulse += smoothstep(0.022, 0.0, abs(r - ph*0.6))*(1.0-ph)*(0.15 + bass*0.5);
  }
  float stone = smoothstep(0.058, 0.044, length(p));        // 中央石（實心量感）
  float amt = (line*0.5 + pulse + stone*0.85) * (0.8 + 0.35*fbm(p*70.0)); // 砂粒微噪
  vec3 dark = mix(uC0, vec3(0.12,0.12,0.14), 0.35);         // 宣紙上：深砂影墨
  vec3 bright = mix(uC1, vec3(0.86,0.89,0.96), 0.5);        // 夜色：月光銀砂
  return inkOut(amt, dark, bright);
}` };

// 煙雲霧隱：多層 fbm 山脊 + 空氣遠近（前濃後淡）+ domain-warp 霧。霧＝減墨露紙(留白)
const mistyMountain: GpuEffect = {
  id: "gv-misty-mountain", name: "煙雲霧隱", category: "墨象 · 東方", ink: true,
  frag: `
vec4 effect(vec2 uv){
  float aspect = uRes.x/uRes.y;
  float bass = uBass*uSens, treb = uTreble*uSens;
  // 霧：domain-warp fbm，集中上方；高頻游走更快
  vec2 mp = vec2(uv.x*aspect*1.3, uv.y*1.3);
  float mt = uTime*(0.04 + treb*0.10);
  vec2 wp = vec2(fbm(mp+vec2(mt,0.0)), fbm(mp+vec2(3.1, mt*0.7)));
  float mist = smoothstep(0.42, 0.95, fbm(mp*1.1 + wp*1.8)) * (0.35 + treb*0.55) * smoothstep(0.1, 0.9, uv.y);
  // 山：三層 fbm 山脊，遠層淡（空氣感）
  float amt = 0.0, tint = 0.0;
  for(int i=0;i<3;i++){
    float fi = float(i);
    float scale = 2.0 + fi*1.6;
    float ridge = 0.20 + fi*0.15 + fbm(vec2(uv.x*scale*aspect + uTime*(0.015+fi*0.01), fi*9.1))*0.14;
    float bleed = bass*0.05*fbm(vec2(uv.x*7.0+fi, uTime*0.25));   // bass → 脊邊墨暈外擴
    float a = smoothstep(ridge+0.015+bleed, ridge-0.06-bleed, uv.y) * (1.0 - fi*0.30);
    if(a > amt){ amt = a; tint = fi*0.5; }                         // 取最前景層的墨與色
    amt += exp(-pow((uv.y-ridge)/0.01, 2.0))*(1.0-fi*0.30)*(0.12+bass*0.45); // 脊線濃墨（bass 推）
  }
  amt *= (1.0 - mist*0.9);   // 霧/雲吃掉墨 → 露出紙(留白)
  vec3 dark = mix(mix(uC0, vec3(0.07,0.08,0.11), 0.35), uC1*0.55, tint); // 墨黑→花青(層次)
  vec3 bright = mix(uC1, uC2, tint*0.5) + 0.12;                          // 夜色：花青→硃砂亮墨
  return inkOut(amt, dark, bright);
}` };

// 狂草氣韻：抽象毛筆飛舞筆畫 + 筆壓變化 + 飛白枯筆，低頻震盪噴墨微粒
const cursive: GpuEffect = {
  id: "gv-cursive", name: "狂草氣韻", category: "墨象 · 東方", ink: true,
  frag: `
// 沿參數曲線取點求最短距離 → 一條會隨音樂抖動的草書線
float strokeDist(vec2 p, float seed, float wob){
  float best = 1e3; vec2 prev = vec2(0.0);
  for(int i=0;i<=12;i++){
    float s = float(i)/12.0;
    float x = (s-0.5)*1.5;
    float y = 0.17*sin(s*6.2831 + seed) + 0.11*sin(s*12.4 + seed*2.0) + wob*0.045*sin(s*20.0+uTime*3.0);
    vec2 cur = vec2(x, y);
    if(i>0) best = min(best, sdSegment(p, prev, cur));
    prev = cur;
  }
  return best;
}
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0);
  float bass = uBass*uSens, mid = uMid*uSens, treb = uTreble*uSens;
  float amt = 0.0;
  // 兩筆交疊
  for(int k=0;k<2;k++){
    float seed = float(k)*2.3 + 1.0;
    vec2 pp = p*1.1 + vec2(0.0, float(k)*0.18-0.09);
    float d = strokeDist(pp, seed, mid+treb);
    float pressure = 0.5 + 0.5*fbm(vec2(pp.x*2.6+seed, seed));  // 筆壓沿筆畫起伏（粗細不均）
    float w = 0.016 + 0.03*pressure + bass*0.018;               // bass 撐粗
    float hair = fbm(pp*vec2(38.0, 5.0) + seed*3.1);            // 飛白：沿筆畫枯筆條紋
    float dry = smoothstep(0.30, 0.66, hair);                   // 真的挖出飛白縫
    amt += fill(d - w) * dry;
  }
  // 低頻震盪噴墨微粒（中央筆畫帶、beat 才明顯、收很緊不結塊）
  float bandMask = exp(-pow(p.y/0.4, 2.0));
  vec2 gp = floor(p*28.0);
  for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++){
    vec2 cell = gp+vec2(float(i),float(j));
    float h1=hash(cell), h2=hash(cell+3.1), h3=hash(cell+7.7);
    vec2 pos = (cell+vec2(h1,h2)+0.22*vec2(sin(uTime*2.0+h1*6.28),cos(uTime*1.7+h2*6.28)))/28.0;
    amt += smoothstep(0.005, 0.0, length(p-pos))*step(0.66,h3)*(bass*0.7+uBeat*0.9)*bandMask;
  }
  vec3 dark = mix(uC0, vec3(0.05,0.05,0.06), 0.5);   // 宣紙上：濃墨黑
  vec3 bright = vec3(1.0,0.99,0.93);                  // 夜色：宣紙微黃白(發光)
  return inkOut(amt, dark, bright);
}` };

// 輪墨曼陀羅：放射對稱的頻譜筆畫(壇城/萬花筒)，每瓣對應一個頻段、慢轉。移植自 Codrops AudioVisualizers 的概念，改水墨。
const inkMandala: GpuEffect = {
  id: "gv-ink-mandala", name: "輪墨曼陀羅", category: "墨象 · 東方", ink: true,
  frag: `
vec4 effect(vec2 uv){
  vec2 p = (uv-0.5)*vec2(uRes.x/uRes.y, 1.0);
  float bass = uBass*uSens, treb = uTreble*uSens;
  float r = length(p);
  float a = atan(p.y, p.x);
  float pieces = floor(8.0 + 8.0*clamp(uSpacing, 0.4, 2.0)); // 對稱瓣數
  float seg = 6.28318530 / pieces;
  float amt = 0.0;
  // 兩層反向旋轉的放射筆畫 → 交織的壇城
  for(int Lr=0; Lr<2; Lr++){
    float dir = Lr==0 ? 1.0 : -1.0;
    float ang = a + uTime*0.13*dir;
    float wi = floor(ang/seg);
    float af = ang - (wi+0.5)*seg;                 // 該瓣內角度偏移（中心=0）
    float m = abs(fract(wi/pieces) - 0.5)*2.0;     // 左右鏡像對稱
    float band = spec(clamp(m, 0.0, 1.0));         // 該瓣對應頻段（萬花筒對稱）
    // 三段同心放射筆畫，長度＝頻段能量
    for(int L=0; L<3; L++){
      float fl = float(L);
      float r0 = 0.09 + fl*0.12 + float(Lr)*0.05;
      float len = (0.05 + band*(0.16 + bass*0.18)) * (1.0 - fl*0.18);
      float along = clamp((r - r0)/max(len,1e-3), 0.0, 1.0);
      float onR = smoothstep(r0-0.008, r0+0.008, r) * smoothstep(1.0, 0.72, along); // 起筆銳、收筆漸淡(筆鋒)
      float perp = abs(r * sin(af));               // 到放射線的垂直距
      float w = (0.0035 + 0.009*band)/clamp(uWidth,0.4,2.0);
      float dry = smoothstep(0.30, 0.72, fbm(vec2(r*40.0, af*10.0)+wi)); // 飛白枯筆
      amt += smoothstep(w, 0.0, perp) * onR * dry * (Lr==0 ? 1.0 : 0.55);
    }
  }
  // 中央墨核（低頻撐大）+ 一圈細點(高頻撒墨)
  amt += smoothstep(0.055, 0.03, r) * (0.55 + bass*0.5);
  float ringR = 0.40 + bass*0.04;
  amt += smoothstep(0.012, 0.0, abs(r-ringR)) * pow(spec(fract(a/6.2831*pieces)),1.5) * treb * 0.8;
  vec3 dark = mix(uC0, vec3(0.06,0.06,0.08), 0.45);  // 宣紙上：濃墨
  vec3 bright = mix(uC1, uC2, 0.4) + 0.1;            // 夜色：亮墨
  return inkOut(amt, dark, bright);
}` };

// ───────── 控制卡（貓神移植，GPU shader 版；震幅邏輯 1:1 照原版） ─────────
// ⚠️ WIP 未完成：待對真實音樂實測微調（震幅手感、文字焊進卡片、白框第二行文字）。「白框」＝原可夜卡二號（只改名、音效柱保留）。
// 重低音卡（drawDynamicControlCard）：低音整體放大 1~3 倍 + 山形柱(頻段0.05-0.35) + 中頻線(0.25-0.6) + 發光基準線。
// 震幅照原版：bassScale=1+bass*2；山形 pow(v-0.2,1.2)*maxH*2.4；中頻線 pow(v-0.3,1.15)*maxH*1.8。卡片文字走文字/歌名圖層。
const bassCard: GpuEffect = {
  id: "gv-bass-card", name: "重低音卡", category: "控制卡",
  frag: `
float lowAvg(){ float s=0.0; for(int i=0;i<6;i++) s+=texture(uFreq, vec2(0.031*float(i)/5.0,0.5)).r; return s/6.0; }
vec4 effect(vec2 uv){
  float bass = clamp(lowAvg()*(0.4+uSens*0.7), 0.0, 1.2);
  float scale = 1.0 + bass*1.2;            // 整卡隨低音放大（sens 也驅動）
  float baseY = 0.5;
  float halfW = 0.16*scale;               // 可視化半寬
  float maxH  = 0.28*scale;                // 柱高基準
  float t = (uv.x-(0.5-halfW))/(2.0*halfW);
  float inViz = step(0.0,t)*step(t,1.0);
  float yUp = uv.y-baseY;
  // 山形柱（64 根，頻段 0.05-0.35）— cardSamp 已含 sens/balance/多tap，反應強
  float n = 64.0; float ci = floor(t*n); float tb = clamp((ci+0.5)/n,0.0,1.0);
  float vb = cardSamp(0.05,0.35,tb);
  float hb = pow(vb,1.2)*maxH*0.9;
  float cf = fract(t*n);
  float barW = smoothstep(0.18,0.22,cf)*smoothstep(0.82,0.78,cf); // 中央 ~60% 寬
  float bar = inViz*barW*step(0.0,yUp)*step(yUp,hb);
  float barGrad = mix(0.15,0.85, clamp(yUp/max(hb,1e-4),0.0,1.0)); // 頂濃底淡
  float hl = inViz*barW*step(hb-0.004,yUp)*step(yUp,hb)*0.4;        // 頂部高光
  // 中頻線（頻段 0.25-0.6）
  float vl = cardSamp(0.25,0.6,clamp(t,0.0,1.0));
  float lineY = pow(vl,1.2)*maxH*0.7;
  float midLine = inViz*step(0.0,yUp)*(1.0-smoothstep(0.0,0.006,abs(yUp-lineY)));
  // 發光基準線
  float baseD = abs(uv.y-baseY);
  float baseLine = inViz*(1.0-smoothstep(0.003*scale,0.005*scale,baseD));
  float baseGlow = inViz*glow(baseD,90.0)*0.4;
  vec3 c = ramp(t)*(bar*barGrad*0.95+hl) + uC2*(midLine*0.92) + uC1*(baseLine+baseGlow);
  c *= (1.0+uBeat*0.3);
  float a = clamp(bar+midLine+baseLine+baseGlow*0.5, 0.0, 1.0);
  return vec4(c, a);
}` };

// 白框（原可夜卡二號，只改名）：白色藥丸框 + 底部 40 柱。震幅照原版 pow(amp,1.5)*maxH*sens*2、取 FFT[i/40*0.8]。文字（兩組）走文字圖層。
const keyeCardV2: GpuEffect = {
  id: "gv-keye-v2", name: "白框", category: "控制卡",
  frag: `
uniform float uProgress;   // 播放進度 0..1（外框第二層白線＝計時器，沿藥丸周長繞一圈）
// 藥丸外框的周長參數 [0,1)：從頂部中央順時針（右半→右帽→底邊→左帽→左半）。sx=直邊半長 rad=帽半徑
float pillParam(vec2 p, float sx, float rad){
  float cap = 3.14159265*rad, P = 4.0*sx + 2.0*cap, s;
  if (p.x > sx){                                  // 右半圓帽
    float phi = atan(p.y, p.x - sx);
    s = sx + (1.5707963 - phi)*rad;
  } else if (p.x < -sx){                           // 左半圓帽
    float phi = atan(p.y, p.x + sx);
    s = (3.0*sx + cap) + mod(-1.5707963 - phi, 6.2831853)*rad;
  } else if (p.y > 0.0){                            // 頂邊（右半 seg1 / 左半 seg5）
    s = p.x >= 0.0 ? p.x : (P + p.x);
  } else {                                         // 底邊
    s = (sx + cap) + (sx - p.x);
  }
  return s / P;
}
vec4 effect(vec2 uv){
  float aspect = uRes.x/uRes.y;
  vec2 q = vec2((uv.x-0.5)*aspect, uv.y);    // y: 0 底、1 頂
  // 白色藥丸框：寬0.8 高0.2、置中靠下（底邊 uv.y=0.05、頂邊 0.25）
  float boxCy = 0.15; float hw = 0.4*aspect, hh = 0.1, rad = 0.1;
  vec2 bp = vec2(q.x, q.y-boxCy);
  float boxD = sdBox(bp, vec2(hw-rad, hh-rad))-rad;
  float boxFill = fill(boxD);
  float innerB = (1.0-smoothstep(0.0,0.004,abs(boxD)));            // 內側深邊（永遠在）
  float outerD = sdBox(bp, vec2(hw-rad+0.008, hh-rad+0.008))-rad;
  float outerLine = (1.0-smoothstep(0.0,0.004,abs(outerD)));       // 外側白邊（第二層）
  // 外框第二層白線＝計時器：周長參數 < 進度才畫；一開始(prog=0)沒有、播完(prog=1)繞滿一圈
  float perim = pillParam(bp, hw-rad+0.008, rad);
  // 播完(>=0.999)直接整圈畫滿＝頭尾無縫接好；否則軟頭跟著進度跑
  float gate = uProgress >= 0.999 ? 1.0 : (1.0 - smoothstep(uProgress - 0.005, uProgress, perim)) * step(0.0015, uProgress);
  float outerB = outerLine * gate;
  // 底部細條（64 條、細，~26% cell）
  float pad = 0.04*aspect;
  float vxL = -hw+pad, vxR = hw-pad;
  float vt = (q.x-vxL)/(vxR-vxL);
  float inViz = step(0.0,vt)*step(vt,1.0);
  float n = 64.0; float ci = floor(vt*n); float tb = clamp((ci+0.5)/n,0.0,1.0);
  float amp = cardSamp(0.0,0.45,tb);                                // cardSamp 已含 sens/balance/多tap → 反應強
  float bh = max(0.003, pow(amp,1.1)*0.055);                        // 柱高（填滿框內可視化帶）
  float barBottom = 0.056;                                          // 框底略上
  float yUp = q.y-barBottom;
  float cf = fract(vt*n);
  float barW = smoothstep(0.30,0.44,cf)*smoothstep(0.70,0.56,cf);   // 細條（柱寬 ~26% cell）
  float bar = inViz*barW*step(0.0,yUp)*step(yUp,bh)*step(boxD,0.0); // 只在框內
  vec3 barCol = mix(uC1,uC2,tb);
  // 框外柔陰影（框外一圈淡墨）→ 純白框跟宣紙/夜紙都分得開、不糊在背景
  float shadow = (1.0 - smoothstep(0.012, 0.034, boxD)) * step(0.011, boxD) * 0.22;
  // 框內白底；有柱的地方「取代」成柱色（mix，不是加成）→ 柱子顯預設色、不被純白底洗白
  vec3 bodyCol = mix(vec3(1.0), barCol, bar);
  vec3 c = bodyCol*boxFill + vec3(1.0)*(outerB*0.6) - vec3(1.0)*innerB*0.22;
  float a = clamp(boxFill*0.9 + outerB*0.6 + innerB*0.30 + shadow, 0.0, 1.0);
  return vec4(max(c,0.0), a);
}` };

export const GPU_EFFECTS: GpuEffect[] = [zenGarden, mistyMountain, cursive, inkMandala, spectrum, dots, radialGlow, ripples, orb, wave, particles, nebula, bassCard, keyeCardV2];
export const GPU_CATEGORIES: { name: string; ids: string[] }[] = [
  // 墨象·東方（gv-zen-garden / gv-misty-mountain / gv-cursive / gv-ink-mandala）暫時從效果牆移除；
  // 程式與 GPU_EFFECTS 仍保留，要恢復就把這個分類加回來。
  { name: "條狀", ids: ["gv-spectrum", "gv-dots"] },
  { name: "環形", ids: ["gv-radial-glow", "gv-ripples", "gv-orb"] },
  { name: "波形", ids: ["gv-wave"] },
  { name: "粒子 · 抽象", ids: ["gv-particles", "gv-nebula"] },
  { name: "控制卡", ids: ["gv-bass-card", "gv-keye-v2"] },
];

// 只有「置中／瀰漫型」效果適合橢圓羽化（縮小時收成柔邊橢圓）。
// 橫向頻譜（頻譜條/鏡像條/點狀/波形）不套 → 不會切掉左右兩側內容；它們本來空白處就透明、不露框。
const VIGNETTE_IDS = new Set(["gv-radial-glow", "gv-ripples", "gv-orb", "gv-nebula", "gv-particles", "gv-zen-garden", "gv-cursive", "gv-ink-mandala"]);
// 舊頻譜（霓虹/鏡像條/鏡譜/簇譜）已合併進 gv-spectrum 並下架；殘留 id（舊存檔/preset）render 時 alias 成統一頻譜。
const LEGACY_SPECTRUM_IDS = new Set(["gv-neon-bars", "gv-mirror-bars", "gv-mirror-neon", "gv-cluster"]);

// 墨象·東方系列＝「真・墨上紙」：合成時宣紙走 multiply(深墨)、夜紙走 lighter(亮墨)，跟墨韻流體一致。
export const INK_GPU_IDS = new Set(GPU_EFFECTS.filter((e) => e.ink).map((e) => e.id));

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
};

export type GpuRenderParams = {
  time: number; sens: number; beat: number;
  palette: { primary: string; secondary: string; accent: string };
  bass: number; mid: number; treble: number;
  bloom?: number; // 泛光強度（預設 1.35）
  gain?: number;  // 整體亮度/增益（預設 1）
  feather?: number; // 橢圓羽化（0=全螢幕不暈影、1=縮小時暈影消框，預設 0）
  width?: number; // 粗細：條寬/線寬/點大小（預設 1）
  spacing?: number; // 間距：條/點疏密（預設 1）
  balance?: number; // 高低頻平衡：<0 抬低頻、>0 抬高頻（預設 0）
  beatPhase?: number; // 距上個重音多久（秒/RIPPLE_DUR 正規化；0=剛下、>1 淡出、預設 9=無重音）
  paper?: boolean; // 墨系列專用：true=宣紙(深墨,跳 bloom,給 multiply) false=暗底(亮墨,吃 bloom)
  shape?: number; // 統一頻譜形狀：0 Curve / 1 Bars / 2 Stepped Bars / 3 Level Meter / 4 Stepped Level Meter（預設 1）
  mirrorV?: boolean; // 統一頻譜：上下鏡像
  mirrorH?: boolean; // 統一頻譜：左右鏡像
  cap?: number; // 統一頻譜：峰頂上限（半高，預設 0.55）
  freqR?: Uint8Array | null; // 統一頻譜：右聲道頻譜（左右分離時與 freq=左聲道搭配）
  stereo?: boolean; // 統一頻譜：左右分離（畫面左半=freq、右半=freqR）
  radial?: boolean; // 統一頻譜：環狀（圓形放射）
  spin?: number;    // 統一頻譜：環狀旋轉速度（弧度/秒，預設 0）
  reflex?: number;  // 統一頻譜：水面倒影 0..1（預設 0=關）
  outline?: boolean;// 統一頻譜：長條鏤空描邊
  peakOn?: boolean; // 統一頻譜：峰頂浮標（峰值保持＋重力下落）
  scale?: number;   // 頻率刻度（X 分布）：0 log / 1 linear / 2 bark / 3 mel（gv-spectrum/dots/wave 通用）
  weight?: number;  // 加權（高低）：0 預設 / 1 A / 2 B / 3 C
  progress?: number; // 播放進度 0..1（白框外線計時器用）
};

const BLUR_SPREAD = 1.4;

export class GpuVisuals {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject | null = null;
  private freqTex: WebGLTexture | null = null;
  private freqTexR: WebGLTexture | null = null; // 右聲道頻譜（立體聲分離用）
  private peakTex: WebGLTexture | null = null;  // 峰值保持頻譜（主/左）
  private peakTexR: WebGLTexture | null = null; // 峰值保持頻譜（右）
  private peakBuf: Uint8Array | null = null;    // 峰值高度（0..255）
  private peakVel = new Float32Array(0);        // 峰值下落速度（重力累積）
  private peakBufR: Uint8Array | null = null;
  private peakVelR = new Float32Array(0);
  private progs = new Map<string, Prog | null>();
  private byId = new Map<string, GpuEffect>();
  private pBright!: Prog; private pBlur!: Prog; private pComp!: Prog;
  private scene: FBO | null = null;
  private bloomA: FBO | null = null;
  private bloomB: FBO | null = null;
  private hdr = false; // RGBA16F 浮點 FBO → 亮部超過 1 不裁切（避免去飽和變白）
  ok = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    for (const e of GPU_EFFECTS) this.byId.set(e.id, e);
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) { this.gl = gl as unknown as WebGL2RenderingContext; return; }
    this.gl = gl;
    this.hdr = !!gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear"); // 浮點貼圖線性過濾（給 bloom 模糊用）
    try {
      this.vao = gl.createVertexArray();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.freqTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.freqTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FREQ_BINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // 右聲道頻譜貼圖（立體聲分離用）
      this.freqTexR = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.freqTexR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FREQ_BINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // 峰值保持頻譜貼圖（主/左、右）— 給「峰頂浮標」用
      for (const which of ["L", "R"] as const) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FREQ_BINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (which === "L") this.peakTex = tex; else this.peakTexR = tex;
      }
      this.peakBuf = new Uint8Array(FREQ_BINS); this.peakVel = new Float32Array(FREQ_BINS);
      this.peakBufR = new Uint8Array(FREQ_BINS); this.peakVelR = new Float32Array(FREQ_BINS);
      this.pBright = this.link(POST_BRIGHT);
      this.pBlur = this.link(POST_BLUR);
      this.pComp = this.link(POST_COMP);
      this.ok = true;
    } catch (err) { console.error("[GpuVisuals] 初始化失敗", err); }
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl, s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
    return s;
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
  private programFor(id: string): Prog | null {
    if (this.progs.has(id)) return this.progs.get(id)!;
    const eff = this.byId.get(id);
    if (!eff) { this.progs.set(id, null); return null; }
    try { const prog = this.link(HEADER + eff.frag + MAIN); this.progs.set(id, prog); return prog; }
    catch (err) { console.error(`[GpuVisuals] ${id} 編譯失敗`, err); this.progs.set(id, null); return null; }
  }

  private makeFBO(w: number, h: number): FBO {
    const gl = this.gl, tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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
    if (this.scene && this.scene.w === w && this.scene.h === h) return;
    this.delFBO(this.scene); this.delFBO(this.bloomA); this.delFBO(this.bloomB);
    const bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    this.scene = this.makeFBO(w, h);
    this.bloomA = this.makeFBO(bw, bh);
    this.bloomB = this.makeFBO(bw, bh);
  }

  resize(w: number, h: number) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }

  private drawTo(target: FBO | null) {
    const gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 峰值保持：升立即跟上並重置速度（隱含 hold）；降則重力加速下落。每幀呼叫一次（即時/離線皆逐幀，確定）。
  private updatePeaks(buf: Uint8Array, vel: Float32Array, freq: Uint8Array) {
    const GRAV = 0.4, N = Math.min(buf.length, freq.length);
    for (let k = 0; k < N; k++) {
      const cur = freq[k];
      if (cur >= buf[k]) { buf[k] = cur; vel[k] = 0; }
      else { vel[k] += GRAV; buf[k] = Math.max(cur, buf[k] - vel[k]); }
    }
  }

  render(id: string, freq: Uint8Array | null, p: GpuRenderParams): boolean {
    if (!this.ok) return false;
    if (!this.byId.has(id) && LEGACY_SPECTRUM_IDS.has(id)) id = "gv-spectrum"; // 舊頻譜已下架 → 用統一頻譜畫，不變空白
    const gl = this.gl, prog = this.programFor(id);
    if (!prog) return false;
    const isInk = !!this.byId.get(id)?.ink;
    const inkPaper = isInk && !!p.paper; // 宣紙模式：純深墨直出（跳 bloom），給 ctx2d multiply 壓進紙
    const W = this.canvas.width, H = this.canvas.height;
    this.ensureFBO(W, H);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 上傳頻譜（左聲道/混合 → TEXTURE0）
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.freqTex);
    if (freq && freq.length >= FREQ_BINS) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FREQ_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, freq.subarray(0, FREQ_BINS));
    // 右聲道（立體聲分離）→ TEXTURE1
    const stereo = !!(p.stereo && p.freqR && p.freqR.length >= FREQ_BINS);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.freqTexR);
    if (stereo) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FREQ_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, p.freqR!.subarray(0, FREQ_BINS));
    // 峰值保持（峰頂浮標）→ TEXTURE2/3：維護 hold+重力緩衝、上傳貼圖（只在開啟時更新，省成本）。貼圖一律綁好讓 sampler 有效。
    const peakOn = !!p.peakOn && id === "gv-spectrum";
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.peakTex);
    if (peakOn && freq && this.peakBuf) { this.updatePeaks(this.peakBuf, this.peakVel, freq); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FREQ_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, this.peakBuf); }
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.peakTexR);
    if (peakOn && stereo && this.peakBufR) { this.updatePeaks(this.peakBufR, this.peakVelR, p.freqR!); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FREQ_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, this.peakBufR); }

    // 1) 特效 → sceneFBO
    gl.useProgram(prog.p);
    const u = prog.u;
    if (u.uFreq) gl.uniform1i(u.uFreq, 0);
    if (u.uRes) gl.uniform2f(u.uRes, W, H);
    if (u.uTime) gl.uniform1f(u.uTime, p.time);
    if (u.uSens) gl.uniform1f(u.uSens, p.sens);
    if (u.uBeat) gl.uniform1f(u.uBeat, p.beat);
    if (u.uBass) gl.uniform1f(u.uBass, p.bass);
    if (u.uMid) gl.uniform1f(u.uMid, p.mid);
    if (u.uTreble) gl.uniform1f(u.uTreble, p.treble);
    if (u.uWidth) gl.uniform1f(u.uWidth, p.width ?? 1);
    if (u.uSpacing) gl.uniform1f(u.uSpacing, p.spacing ?? 1);
    if (u.uBalance) gl.uniform1f(u.uBalance, p.balance ?? 0);
    if (u.uBeatPhase) gl.uniform1f(u.uBeatPhase, p.beatPhase ?? 9.0);
    if (u.uPaper) gl.uniform1f(u.uPaper, inkPaper ? 1 : 0);
    if (u.uShape) gl.uniform1f(u.uShape, p.shape ?? 1);
    if (u.uMirrorV) gl.uniform1f(u.uMirrorV, p.mirrorV ? 1 : 0);
    if (u.uMirrorH) gl.uniform1f(u.uMirrorH, p.mirrorH ? 1 : 0);
    if (u.uCap) gl.uniform1f(u.uCap, p.cap ?? 0.55);
    if (u.uFreqR) gl.uniform1i(u.uFreqR, 1);
    if (u.uStereo) gl.uniform1f(u.uStereo, stereo ? 1 : 0);
    if (u.uPeak) gl.uniform1i(u.uPeak, 2);
    if (u.uPeakR) gl.uniform1i(u.uPeakR, 3);
    if (u.uRadial) gl.uniform1f(u.uRadial, p.radial ? 1 : 0);
    if (u.uSpin) gl.uniform1f(u.uSpin, p.spin ?? 0);
    if (u.uReflex) gl.uniform1f(u.uReflex, p.reflex ?? 0);
    if (u.uOutline) gl.uniform1f(u.uOutline, p.outline ? 1 : 0);
    if (u.uPeakOn) gl.uniform1f(u.uPeakOn, peakOn ? 1 : 0);
    if (u.uScale) gl.uniform1f(u.uScale, p.scale ?? 0);
    if (u.uWeight) gl.uniform1f(u.uWeight, p.weight ?? 0);
    if (u.uProgress) gl.uniform1f(u.uProgress, p.progress ?? 0);
    const c0 = hexRgb(p.palette.primary), c1 = hexRgb(p.palette.secondary), c2 = hexRgb(p.palette.accent);
    if (u.uC0) gl.uniform3f(u.uC0, c0[0], c0[1], c0[2]);
    if (u.uC1) gl.uniform3f(u.uC1, c1[0], c1[1], c1[2]);
    if (u.uC2) gl.uniform3f(u.uC2, c2[0], c2[1], c2[2]);
    this.drawTo(this.scene);

    const bw = this.bloomA!.w, bh = this.bloomA!.h;
    if (!inkPaper) { // 宣紙墨模式跳過 bloom（深墨不發光）
      // 2) 亮部抽出 → bloomA
      gl.useProgram(this.pBright.p);
      gl.uniform2f(this.pBright.u.uRes!, bw, bh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene!.tex);
      gl.uniform1i(this.pBright.u.uTex!, 0);
      this.drawTo(this.bloomA);
      // 3) 模糊 H（bloomA→bloomB）、V（bloomB→bloomA）
      gl.useProgram(this.pBlur.p);
      gl.uniform2f(this.pBlur.u.uRes!, bw, bh);
      gl.uniform1i(this.pBlur.u.uTex!, 0);
      gl.uniform2f(this.pBlur.u.uDir!, BLUR_SPREAD / bw, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bloomA!.tex);
      this.drawTo(this.bloomB);
      gl.uniform2f(this.pBlur.u.uDir!, 0, BLUR_SPREAD / bh);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB!.tex);
      this.drawTo(this.bloomA);
    }
    // 4) 合成 → 畫布
    gl.useProgram(this.pComp.p);
    gl.uniform2f(this.pComp.u.uRes!, W, H);
    gl.uniform1f(this.pComp.u.uBloomStr!, p.bloom ?? 1.35);
    gl.uniform1f(this.pComp.u.uGain!, p.gain ?? 1);
    gl.uniform1f(this.pComp.u.uInk!, inkPaper ? 1 : 0); // 1=深墨直出(不過 bloom/tonemap)
    // 只有置中/瀰漫型效果在縮小時套羽化；橫向頻譜不套（保留全寬）
    const fade = (VIGNETTE_IDS.has(id) && (p.feather ?? 0) > 0) ? 1 : 0;
    gl.uniform1f(this.pComp.u.uFeather!, fade);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene!.tex); gl.uniform1i(this.pComp.u.uScene!, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomA!.tex); gl.uniform1i(this.pComp.u.uBloom!, 1);
    this.drawTo(null);
    return true;
  }

  destroy() {
    if (!this.ok) return;
    const gl = this.gl;
    for (const pr of this.progs.values()) if (pr) gl.deleteProgram(pr.p);
    gl.deleteProgram(this.pBright.p); gl.deleteProgram(this.pBlur.p); gl.deleteProgram(this.pComp.p);
    this.delFBO(this.scene); this.delFBO(this.bloomA); this.delFBO(this.bloomB);
    if (this.freqTex) gl.deleteTexture(this.freqTex);
    if (this.freqTexR) gl.deleteTexture(this.freqTexR);
    if (this.peakTex) gl.deleteTexture(this.peakTex);
    if (this.peakTexR) gl.deleteTexture(this.peakTexR);
    if (this.vao) gl.deleteVertexArray(this.vao);
  }
}

// 縮圖用：模組級共用一個離屏引擎，合成「像音樂」的頻譜 → 渲染單幀
let thumbEngine: GpuVisuals | null = null;
let thumbFreq: Uint8Array | null = null;
export function renderGpuThumb(id: string, dst: HTMLCanvasElement, palette: { primary: string; secondary: string; accent: string }) {
  if (!thumbEngine) {
    const c = document.createElement("canvas"); c.width = 480; c.height = 200;
    thumbEngine = new GpuVisuals(c);
    thumbFreq = new Uint8Array(FREQ_BINS);
    for (let i = 0; i < FREQ_BINS; i++) thumbFreq[i] = Math.round(255 * Math.pow(1 - i / FREQ_BINS, 1.35) * (0.5 + 0.5 * Math.abs(Math.sin(i * 0.18 + 1))));
  }
  if (!thumbEngine.ok) return false;
  thumbEngine.resize(480, 200);
  thumbEngine.render(id, thumbFreq, { time: 1.4, sens: 1.15, beat: 0.7, palette, bass: 0.6, mid: 0.45, treble: 0.4 });
  const ctx = dst.getContext("2d"); if (!ctx) return false;
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.drawImage(thumbEngine.canvas, 0, 0, dst.width, dst.height);
  return true;
}
