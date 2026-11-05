// 插入到页面上的照片 / LOGO：只在当前页面会话里保存（不进打印方案）。
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from './sources.js';

const store = new Map(); // id → { bitmap, w, h }
let seq = 0;

/** 读入一张图片，返回 { id, w, h }（像素尺寸）。 */
export async function addImage(file) {
  if (!IMAGE_TYPES.includes(file?.type)) throw Object.assign(new Error('unsupported image'), { kind: 'image-type' });
  if (file.size > MAX_IMAGE_BYTES) throw Object.assign(new Error('image too large'), { kind: 'image-size' });
  const bitmap = await createImageBitmap(file);
  const id = `img${Date.now().toString(36)}${++seq}`;
  store.set(id, Object.freeze({ bitmap, w: bitmap.width, h: bitmap.height }));
  return { id, w: bitmap.width, h: bitmap.height };
}

export function getImage(id) {
  return store.get(id) ?? null;
}

/** 换文件时清掉（释放内存）。 */
export function clearImages() {
  for (const { bitmap } of store.values()) bitmap.close();
  store.clear();
}
