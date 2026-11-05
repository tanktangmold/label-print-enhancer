// 像素/文字排版的纯函数（马赛克、文字换行），不依赖 DOM，Node 单测可直接跑。

/**
 * 马赛克：把 RGBA 像素按 block×block 分块，每块填成平均色。原地写回（data 是调用方独占的副本）。
 * 输出本来就是整页图像，马赛克后原内容就真的没了（不像叠加层那样还能复制出底下的字）。
 */
export function pixelate(data, width, height, block) {
  const size = Math.max(1, Math.round(block));
  for (let by = 0; by < height; by += size) {
    for (let bx = 0; bx < width; bx += size) {
      const w = Math.min(size, width - bx);
      const h = Math.min(size, height - by);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = by; y < by + h; y++) {
        for (let x = bx; x < bx + w; x++) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
        }
      }
      const n = w * h;
      for (let y = by; y < by + h; y++) {
        for (let x = bx; x < bx + w; x++) {
          const i = (y * width + x) * 4;
          data[i] = r / n;
          data[i + 1] = g / n;
          data[i + 2] = b / n;
          data[i + 3] = a / n;
        }
      }
    }
  }
  return data;
}

// 中日韩文字可以在任意字之间换行；拉丁文按单词换行
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

function tokens(paragraph) {
  const out = [];
  let word = '';
  for (const ch of paragraph) {
    if (CJK.test(ch)) {
      if (word) out.push(word);
      word = '';
      out.push(ch);
    } else if (ch === ' ') {
      out.push(`${word} `);
      word = '';
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

/**
 * 按宽度换行。measure(text) 返回文字宽度（与 maxWidth 同单位）。
 * 显式换行符保留；单个单词比一行还宽时按字拆开。返回行数组。
 */
export function wrapLines(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const tok of tokens(paragraph)) {
      // 行尾空格不占宽度
      if (measure((line + tok).trimEnd()) <= maxWidth || !line) {
        if (measure(tok) > maxWidth && !line) {
          // 单个超长单词：按字拆
          for (const ch of tok) {
            if (line && measure(line + ch) > maxWidth) {
              lines.push(line);
              line = '';
            }
            line += ch;
          }
        } else {
          line += tok;
        }
      } else {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
