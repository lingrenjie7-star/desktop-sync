/**
 * DSH 插件的宿主半边（Cordis 插件，跑在 Node 进程里）。
 *
 * 职责：
 *   · 持有一份 createSyncCore() 实例（真正的同步引擎）；
 *   · 通过 `ctx.webServer.register()` 挂一条 HTTP 路由，把同步能力暴露给浏览器半边；
 *   · 不碰任何 UI。
 *
 * 为什么用 HTTP 路由而不是 ctx.remote / Typert：
 *   ctx.remote 需要 Typert 代码生成（schema → 生成的 /remote 产物），
 *   对第三方插件来说是一条很重的构建链。而 dsh-host-webserver 是
 *   「注册一条 named route」这么简单，handler 就是 node:http 的 (req, res)。
 *   插件因此不依赖任何代码生成，也能被别的插件复用。
 *
 * 安全：
 *   路由挂在 DSH 自己的 webserver 上，默认只监听 loopback（127.0.0.1），
 *   并且由 DSH 的 Connection 层负责鉴权。我们额外做两件事：
 *     1. 只接受 POST /api/dshwb-sync，GET 一律 405；
 *     2. 校验 Content-Type，并要求一个进程内随机 token（见下），
 *        避免同机其它网页用 CSRF 方式打到这个端点。
 *
 * 令牌：
 *   DSH 宿主是普通 Node 进程，没有 Electron 的 safeStorage。
 *   所以这里不传 crypto 后端，令牌以明文落在 ~/.dshwb-sync/credentials.json，
 *   tokenMode 会是 'plain' —— 界面必须如实提示用户，不能假装已加密。
 */

import { randomBytes } from 'node:crypto';
import { createSyncCore } from '../shared/core.mjs';

export const name = 'dsh-dntb';

/**
 * 注入的服务。
 *
 * Cordis 的 inject 是**纯字符串数组**（不是 { required, optional } 对象）——
 * 写成对象会让 Loader 把它当成永远无法满足的依赖，插件停在 pending：
 *   实测报错：dshwb-sync: pending (waiting for services: required, optional)
 * logger 不在这里声明：拿不到时下面的代码有 console 兜底，不影响工作。
 */
export const inject = ['webServer'];

/** 路由前缀；前端用同一个常量拼地址。 */
export const ROUTE_PATH = '/api/dsh-dntb';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB：同步请求报文不可能这么大

/**
 * 把核心方法包成「不 throw」的形状。
 *
 * 跨 HTTP 边界抛异常只会变成 500 + 一段堆栈，调用方真正需要的
 * 只是 { ok:false, error }。所有分支都收敛到这里。
 */
function createApi(core, log) {
  const wrap = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      log?.warn?.(`[跨电脑同步] ${error?.message ?? error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
  };

  return {
    ping: wrap(async () => ({ ok: true, at: new Date().toISOString() })),
    bootstrap: wrap(async () => core.bootstrap()),
    inspectSources: wrap(async () => core.inspectSources()),
    listRepos: wrap(async () => core.listRepos()),
    discover: wrap(async () => core.discover()),
    connect: wrap(async (input) => {
      // 前端可能传字符串，也可能传 { token }：两种都收，避免调用方踩坑
      const token = typeof input === 'string' ? input : String(input?.token ?? '');
      return core.connect(token);
    }),
    disconnect: wrap(async () => core.disconnect()),
    createRepo: wrap(async (input) => core.createRepo(input ?? {})),
    adopt: wrap(async (input) => core.adopt(input ?? {})),
    stampAll: wrap(async () => core.stampAll()),
    removeRepo: wrap(async (input) => core.removeRepo(input ?? {})),
    deleteRemote: wrap(async (input) => core.deleteRemote(input ?? {})),
    sync: wrap(async (input) => core.sync(input ?? {})),
    probe: wrap(async () => core.probe()),
    updateRemote: wrap(async (input) => core.updateRemote(input ?? {})),
    updateRepo: wrap(async (input) => core.updateLocalRepo(input ?? {})),

    // 远端内容
    browseList: wrap(async (input) => core.browseList(input ?? {})),
    browseCompare: wrap(async (input) => core.browseCompare(input ?? {})),
    browseTakeRemote: wrap(async (input) => core.browseTakeRemote(input ?? {})),
    browsePushLocal: wrap(async (input) => core.browsePushLocal(input ?? {})),
    browseWriteRemote: wrap(async (input) => core.browseWriteRemote(input ?? {})),
    browseDeleteRemote: wrap(async (input) => core.browseDeleteRemote(input ?? {})),
    availableRepos: wrap(async () => core.availableRepos()),
    diagnostics: wrap(async () => core.diagnostics()),

    // 选项页
    setPath: wrap(async (input) => core.setPath(input ?? {})),
    browseDir: wrap(async (input) => core.browseDir(input ?? {})),
    sourcePresets: wrap(async () => core.sourcePresets()),
    addCustomSource: wrap(async (input) => core.addCustomSource(input ?? {})),
    removeCustomSource: wrap(async (input) => core.removeCustomSource(input?.id)),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // 插件端点只给自己页面用，明确禁止被缓存
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx, config) {
  const log = ctx.get?.('logger') ?? console;
  const webServer = ctx.get?.('webServer') ?? ctx.webServer;

  if (!webServer || typeof webServer.register !== 'function') {
    log?.warn?.('[跨电脑同步] 没有 webServer 服务，插件无法工作（需要在 Web 组合下运行）');
    return;
  }

  const core = createSyncCore({
    platform: 'dsh-plugin',
    home: config?.syncHome || undefined,
    // 刻意不传 crypto：宿主进程没有 safeStorage，tokenMode 会如实变成 'plain'
    onProgress: () => {},
  });

  const api = createApi(core, log);

  // 进程内随机口令：页面从 bootstrap 里拿到，之后每个请求都带上。
  // 作用是拦住「同一个浏览器里另一个网页」对本端点的 CSRF 调用。
  const token = randomBytes(24).toString('hex');

  const handle = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '只接受 POST' });
      return;
    }
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '需要 application/json' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error.message}` });
      return;
    }

    const method = String(payload.method ?? '');

    // bootstrap 是引导请求：它负责把会话口令下发出去，所以自己不能要求口令。
    // （之前的顺序写反了，导致页面永远拿不到口令 —— 整个插件不可用。）
    if (method === 'bootstrap') {
      const result = await api.bootstrap();
      sendJson(res, 200, { ...result, token });
      return;
    }

    // 其它方法都要正确口令，拦住同机其它网页的 CSRF 调用
    if (req.headers['x-dshwb-token'] !== token) {
      sendJson(res, 403, { ok: false, error: '口令不对' });
      return;
    }

    const fn = api[method];
    if (typeof fn !== 'function') {
      sendJson(res, 404, { ok: false, error: `没有这个方法：${method}` });
      return;
    }

    const result = await fn(payload.args ?? {});
    sendJson(res, 200, result);
  };

  // 注册路由；dispose 由 Cordis 的 effect 负责
  const disposeRoute = webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: handle,
  });

  log?.info?.(`[跨电脑同步] 宿主半边已加载，路由 ${ROUTE_PATH}`);

  ctx.effect?.(() => () => {
    disposeRoute?.();
  }, 'dshwb-sync: route');

  return () => {
    disposeRoute?.();
    log?.info?.('[跨电脑同步] 宿主半边已卸载');
  };
}
