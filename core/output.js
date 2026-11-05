// 排版后 PDF 的临时存放：IndexedDB + service worker 按同源地址提供（扩展是 background.js，网页版是 sw.js）。
// 不用 blob: 地址，是因为 blob: 的 PDF 放进 iframe 算跨源，没法直接调打印；Cache API 又不支持 chrome-extension 协议。
// 地址都是相对站点根目录的 generated/…，扩展和 GitHub Pages 子目录都能用。
export const GENERATED_DIR = 'generated/';

const DB_NAME = 'lpe-output';
const STORE = 'files';
const KEEP_MS = 10 * 60_000; // 保留 10 分钟：多个排版页同时打印时不会删掉别人的文件

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let req;
    let tx;
    try {
      tx = db.transaction(STORE, mode);
      req = action(tx.objectStore(STORE));
    } catch (err) {
      db.close();
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve(req?.result);
    };
    // onerror 里 tx.error 可能还是 null，要取事件目标上的错误；提交阶段失败只会触发 onabort
    tx.onerror = (e) => {
      db.close();
      reject(e.target?.error ?? tx.error ?? new Error('IndexedDB write failed'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
  });
}

function stampOf(key) {
  const m = /label-(\d+)-/.exec(String(key));
  return m ? Number(m[1]) : 0;
}

/** 存入排版后的 PDF，顺手清掉 10 分钟前的旧文件，返回相对地址（相对站点根目录）。 */
export async function stageOutput(bytes) {
  const now = Date.now();
  const path = `${GENERATED_DIR}label-${now}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  await run('readwrite', (store) => {
    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) if (now - stampOf(key) > KEEP_MS) store.delete(key);
    };
    return store.put(new Blob([bytes], { type: 'application/pdf' }), path);
  });
  return path;
}

/** 按地址取出存好的 PDF，没有则返回 undefined。 */
export function readOutput(path) {
  return run('readonly', (store) => store.get(path));
}

const TEXT = { 'Content-Type': 'text/plain; charset=utf-8' };

/** service worker 的 fetch 处理：把 generated/… 请求换成 IndexedDB 里存的 PDF。 */
export function handleGeneratedFetch(event) {
  const url = new URL(event.request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath + GENERATED_DIR)) return;
  const key = url.pathname.slice(scopePath.length);
  event.respondWith(
    readOutput(key)
      .then((blob) =>
        blob
          ? new Response(blob, { headers: { 'Content-Type': 'application/pdf' } })
          : new Response('Label file expired. Go back and press Print again.', { status: 404, headers: TEXT }),
      )
      .catch((err) => new Response(`Failed to read the label file: ${err?.message ?? err}`, { status: 500, headers: TEXT })),
  );
}
