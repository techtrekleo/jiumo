// 液態玻璃 WebGL pass —— 把「控制卡下方已合成的畫面」當貼圖，在卡形狀（左圓角矩形 ∪ 右半圓）內做
//   邊緣折射放大 + 色散(chromatic aberration) + 可調霜面模糊 + 邊緣鏡面高光。
// 模組級單例（預覽即時迴圈與離線匯出共用、永不並發），WebGL2；純函數 shader、uniform 驅動 → 預覽=匯出、逐幀決定性。
// 技術源頭：研究 rdev/liquid-glass-react（SVG feDisplacementMap）→ 移植成 GPU shader（背景當紋理 + SDF 折射 + 三通道色散）。
// Canvas2D 做不出 per-pixel 折射/色散，所以這層一定要走 WebGL；無 WebGL 時 caller 退回 Canvas2D 霜面。

export interface GlassParams {
  rectCx: number; rectCy: number; rectHx: number; rectHy: number; // 矩形中心 / 半寬高（2D top-down px）
  rrL: number;                                   // 左側圓角半徑 px（右側直角＝0）
  semiCx: number; semiCy: number; semiR: number; // 右半圓 圓心 / 半徑
  refract: number;     // 折射強度 px（邊緣往外推取樣的最大量）
  aberration: number;  // 色散 0..1
  frost: number;       // 霜面模糊半徑 px（播放器模糊）
  tint: [number, number, number];   // 染色 0..1
  tintAmt: number;     // 染色強度 0..1
  glow: [number, number, number];   // 邊緣霓虹色 0..1
}

let _canvas: HTMLCanvasElement | null = null;
let _gl: WebGL2RenderingContext | null = null;
let _tex: WebGLTexture | null = null;
let _u: Record<string, WebGLUniformLocation | null> = {};
let _failed = false;

const VS = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec2 rectC, rectB; uniform float rrL;
uniform vec2 semiC; uniform float semiR;
uniform float uRefract, uAberr, uFrost, uTintAmt;
uniform vec3 uTint, uGlow;

// iq 圓角矩形 SDF，每角獨立半徑 r=(右上,右下,左上,左下)
float sdRoundBox(vec2 p, vec2 b, vec4 r){
  r.xy = (p.x > 0.0) ? r.xy : r.zw;
  r.x  = (p.y > 0.0) ? r.x  : r.y;
  vec2 q = abs(p) - b + r.x;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r.x;
}
// 卡外形＝左圓角矩形 ∪ 右半圓（右側直角，被半圓蓋住）
float scene(vec2 fc){
  float dR = sdRoundBox(fc - rectC, rectB, vec4(0.0, 0.0, rrL, rrL));
  float dC = length(fc - semiC) - semiR;
  return min(dR, dC);
}
vec3 samp(vec2 fc){ return texture(uTex, clamp(fc / uRes, 0.0012, 0.9988)).rgb; }
// 3x3 高斯近似的霜面模糊（rad 太小直接單取樣省成本）
vec3 blurSamp(vec2 fc, float rad){
  if(rad < 0.7) return samp(fc);
  vec3 s = vec3(0.0); float w = 0.0;
  for(int i = -1; i <= 1; i++) for(int j = -1; j <= 1; j++){
    vec2 dd = vec2(float(i), float(j)) * rad;
    float wt = (i == 0 && j == 0) ? 1.0 : 0.55;
    s += samp(fc + dd) * wt; w += wt;
  }
  return s / w;
}
void main(){
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); // → 2D top-down 像素（對齊上傳的畫面貼圖）
  float d = scene(fc);
  float aa = max(fwidth(d), 0.8);
  float inside = smoothstep(aa, -aa, d);                  // 1=卡內、0=卡外、邊緣抗鋸齒
  if(inside <= 0.002){ o = vec4(0.0); return; }           // 卡外＝透明（露出底下模糊背景）
  // SDF 梯度＝指向外的法線
  float e = 1.0;
  vec2 n = normalize(vec2(
    scene(fc + vec2(e, 0.0)) - scene(fc - vec2(e, 0.0)),
    scene(fc + vec2(0.0, e)) - scene(fc - vec2(0.0, e))) + 1e-6);
  float edgeDist = -d;                                    // 0=邊緣 → 內部增大
  float band = max(rectB.y, semiR);                       // 折射作用帶（半個卡高）
  float edge = 1.0 - smoothstep(0.0, band, edgeDist);     // 1=貼邊 → 0=中心
  float bend = edge * edge;                               // 邊緣彎最多、中心幾乎不折射
  vec2 off = n * bend * uRefract;                         // 沿法線往外推取樣 = 邊緣放大折射
  vec2 base = fc - off;
  // 色散：R/G/B 沿法線略不同位移（只在邊緣明顯），各自帶霜面模糊
  float ab = uAberr * 6.0 * (0.25 + 0.75 * edge);
  vec3 col = vec3(
    blurSamp(base - n * ab, uFrost).r,
    blurSamp(base,          uFrost).g,
    blurSamp(base + n * ab, uFrost).b);
  col = mix(col, uTint, uTintAmt * 0.22);                 // 玻璃染色
  col = col * 1.04 + 0.02;                                // 微提亮
  col += edge * clamp(-n.y, 0.0, 1.0) * 0.18;             // 上緣鏡面高光（法線朝上＝top）
  float border = smoothstep(1.8, 0.0, abs(d));            // 最外一圈
  col = mix(col, vec3(1.0), border * 0.32);               // 白色細框
  col += uGlow * border * 0.18;                           // 一點 glow 色暈
  o = vec4(col * inside, inside);                         // premultiplied → drawImage source-over 正確
}`;

function init(): boolean {
  if (_failed) return false;
  if (_gl) return true;
  try {
    _canvas = document.createElement("canvas");
    const gl = _canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true });
    if (!gl) { _failed = true; return false; }
    const cs = (type: number, src: string) => {
      const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader compile");
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, cs(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, cs(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "program link");
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    _tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(prog);
    _u = {};
    for (const n of ["uTex", "uRes", "rectC", "rectB", "rrL", "semiC", "semiR", "uRefract", "uAberr", "uFrost", "uTintAmt", "uTint", "uGlow"]) {
      _u[n] = gl.getUniformLocation(prog, n);
    }
    gl.uniform1i(_u.uTex, 0);
    _gl = gl;
    return true;
  } catch (e) {
    console.warn("[GlassFx] WebGL 初始化失敗，控制卡改用 Canvas2D 霜面：", e);
    _failed = true; return false;
  }
}

// 把 source（卡下方畫面快照）當折射來源，回傳一張 W×H 的玻璃圖（卡外透明）。無 WebGL → null。
export function renderGlass(source: CanvasImageSource, W: number, H: number, p: GlassParams): HTMLCanvasElement | null {
  if (!init() || !_gl || !_canvas) return null;
  const gl = _gl;
  if (_canvas.width !== W || _canvas.height !== H) { _canvas.width = W; _canvas.height = H; }
  gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, _tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
  gl.uniform2f(_u.uRes, W, H);
  gl.uniform2f(_u.rectC, p.rectCx, p.rectCy);
  gl.uniform2f(_u.rectB, p.rectHx, p.rectHy);
  gl.uniform1f(_u.rrL, p.rrL);
  gl.uniform2f(_u.semiC, p.semiCx, p.semiCy);
  gl.uniform1f(_u.semiR, p.semiR);
  gl.uniform1f(_u.uRefract, p.refract);
  gl.uniform1f(_u.uAberr, p.aberration);
  gl.uniform1f(_u.uFrost, p.frost);
  gl.uniform1f(_u.uTintAmt, p.tintAmt);
  gl.uniform3f(_u.uTint, p.tint[0], p.tint[1], p.tint[2]);
  gl.uniform3f(_u.uGlow, p.glow[0], p.glow[1], p.glow[2]);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return _canvas;
}
