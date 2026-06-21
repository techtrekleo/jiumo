// 九墨合成疊層：右側歌詞保護遮罩 + 左下落款印章（studio 即時與離線渲染共用）

export function drawMask(ctx: CanvasRenderingContext2D, W: number, H: number, dark: boolean) {
  const g = ctx.createLinearGradient(W * 0.58, 0, W * 0.95, 0);
  const c = dark ? "6,4,3" : "243,236,220";
  g.addColorStop(0, `rgba(${c},0)`);
  g.addColorStop(0.55, `rgba(${c},0.55)`);
  g.addColorStop(1, `rgba(${c},0.8)`);
  ctx.fillStyle = g;
  ctx.fillRect(W * 0.58, 0, W * 0.42, H);
}

export function drawSeal(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  dark: boolean, sealOn: boolean, title: string,
) {
  if (!sealOn) return;
  const s = Math.min(W, H) * 0.024;
  const x = W * 0.045;
  const sealW = s * 1.9, sealH = s * 4.6;
  const sealY = H * 0.93 - sealH;
  ctx.save();
  ctx.fillStyle = "#9e2b25";
  ctx.fillRect(x, sealY, sealW, sealH);
  ctx.font = `${s * 1.15}px 'Bakudai-Medium', serif`;
  ctx.fillStyle = "#f3ece4";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const chars = "九黎月";
  for (let i = 0; i < 3; i++) ctx.fillText(chars[i], x + sealW / 2, sealY + s * 0.35 + i * s * 1.38);
  if (title) {
    ctx.font = `${s}px 'Bakudai-Light', serif`;
    ctx.fillStyle = dark ? "rgba(232,228,222,0.55)" : "rgba(58,46,38,0.6)";
    for (let i = 0; i < title.length && i < 10; i++) {
      ctx.fillText(title[i], x + sealW + s * 1.2, sealY + i * s * 1.25);
    }
  }
  ctx.restore();
}
