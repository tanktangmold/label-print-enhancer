// 网页版（GitHub Pages）用的 service worker：按同源地址提供排版后的 PDF，好让隐藏 iframe 调打印。
import { handleGeneratedFetch } from './core/output.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', handleGeneratedFetch);
