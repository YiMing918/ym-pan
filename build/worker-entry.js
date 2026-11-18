// build/worker-entry.js — 「_worker.js 高级模式包」的构建入口（本文件不要直接部署）
//
// 为什么需要它：Cloudflare 控制台的「上传资产 / 拖拽」部署**不会编译 functions/
// 文件夹**（官方文档明示），把普通部署包直传上去会得到一个页面能开、但全部
// 解析/登录功能都坏死的站。官方确认根目录的单个 `_worker.js` 在拖拽上传下受
// 支持，所以打包时用 esbuild 把 functions/ 的原处理函数合成一个 _worker.js，
// 原函数源码一字不改，逻辑还是同一套。
//
// 构建命令（release-pack 工作流里执行，本地复现也是这一条）：
//   esbuild build/worker-entry.js --bundle --format=esm \
//     --platform=neutral --target=es2022 --outfile=_worker.js
//
// 路由语义与 functions 文件路由对齐：本仓 6 个接口文件都导出通用 onRequest
// （方法在函数内部分发），故入口按精确路径分发、不限方法；路径匹配前去掉
// 一个尾斜杠（与原版文件路由的尾斜杠等价口径一致）。未命中走 env.ASSETS.fetch；
// 资产未命中且是 GET/HEAD 时，按 Pages 在无 404.html 时的单页回退口径回
// /index.html（原版线上即如此）。
// _headers：高级模式下平台不再应用 _headers。原版口径是「_headers 只管静态
// 层响应、不管函数响应」（函数响应里的 no-store 都是函数自己设的，线上实测），
// 故本入口只给资产层出来的响应按 _headers 的两条规则补头（/api/* 的
// Cache-Control: no-store 与 /* 的两个安全头），函数响应原样返回。

import { onRequest as owner } from '../functions/api/owner.js';
import { onRequest as parse } from '../functions/api/parse.js';
import { onRequest as patrol } from '../functions/api/patrol.js';
import { onRequest as qr } from '../functions/api/qr.js';
import { onRequest as qrlogin } from '../functions/api/qrlogin.js';
import { onRequest as video } from '../functions/api/video.js';

const ROUTES = {
  '/api/owner': owner,
  '/api/parse': parse,
  '/api/patrol': patrol,
  '/api/qr': qr,
  '/api/qrlogin': qrlogin,
  '/api/video': video,
};

// 与仓库根 _headers 一致（改 _headers 时同步改这里）：[路径前缀, 要补的头]
const HEADER_RULES = [
  ['/api/', [['Cache-Control', 'no-store']]],
  ['/', [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'no-referrer'],
  ]],
];

async function serveAsset(request, env, url) {
  let resp = await env.ASSETS.fetch(request);
  if (resp.status === 404 && (request.method === 'GET' || request.method === 'HEAD')) {
    const idx = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
    if (idx.ok) {
      resp = new Response(request.method === 'HEAD' ? null : idx.body, {
        status: 200,
        headers: idx.headers,
      });
    }
  }
  const headers = new Headers(resp.headers);
  for (const [prefix, hs] of HEADER_RULES) {
    if (url.pathname.startsWith(prefix)) {
      for (const [k, v] of hs) headers.set(k, v);
    }
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const handler = ROUTES[path];
    if (handler) {
      return handler({
        request,
        env,
        params: {},
        waitUntil: ctx.waitUntil.bind(ctx),
        next: () => serveAsset(request, env, url),
      });
    }
    return serveAsset(request, env, url);
  },
};
