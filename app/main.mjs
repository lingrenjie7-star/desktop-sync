/**
 * 图形界面主进程：按软件原生层级、一个软件可绑多个仓库。
 */

import electron from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = electron;

import { Engine, ENGINE_VERSION, normalizeRepo } from './lib/engine.mjs';
import { browseRemote, compareFile, deleteRemoteFiles, pushLocal, takeRemote, writeRemoteFile } from './lib/browser.mjs';
import { backfillMarkers, claimRepo, discoverRemoteRepos } from './lib/discover.mjs';
import { MARKER_FILE } from './lib/identity.mjs';
import { describeSources, SOURCE_PRESETS } from './lib/sources/index.mjs';
import {
  createRepo,
  createRepoWithMarker,
  deleteRepo,
  GITIGNORE_TEMPLATES,
  getRepo,
  LICENSE_KEYS,
  listRepos,
  probeTransport,
  updateRepo,
  verifyToken,
} from './lib/github.mjs';
import {
  bootstrapConfig,
  clearToken,
  loadConfig,
  loadToken,
  paths,
  saveConfig,
  saveToken,
  tokenMode,
} from './lib/storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow;
let busy = false;
let cachedConfig;
let lastTokenError = '';

function cryptoBridge() {
  return {
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function currentConfig() {
  if (cachedConfig) return cachedConfig;
  cachedConfig = loadConfig();
  return cachedConfig;
}

function persist(config) {
  cachedConfig = saveConfig(config);
  return cachedConfig;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function readToken() {
  try {
    const token = loadToken(cryptoBridge());
    if (token) lastTokenError = '';
    return token;
  } catch (error) {
    lastTokenError = error.message;
    return undefined;
  }
}

function buildEngine(config) {
  return new Engine({
    config,
    token: readToken(),
    stateDir: paths.home,
    onProgress: (event) => send('sync:progress', event),
  });
}

function newRepoId() {
  return `repo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ───────────────────────────────────────────── 窗口

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1115',
    title: '跨电脑同步',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (process.env.DSHWB_SHOT) runSelfShot(process.env.DSHWB_SHOT).catch(() => app.quit());
  if (process.env.DSHWB_LOGIN) runSelfLogin(process.env.DSHWB_LOGIN).catch(() => app.quit());
  if (process.env.DSHWB_PROBE) runSelfProbe(process.env.DSHWB_PROBE).catch(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function runSelfLogin(token) {
  const result = await verifyToken(token);
  if (!result.ok) {
    console.log('登录失败：' + result.error);
    return app.quit();
  }
  saveToken(token, encryptionAvailable() ? cryptoBridge() : undefined);
  const config = currentConfig();
  if (config) {
    config.github = { login: result.login, avatar: result.avatar };
    persist(config);
  }
  console.log(`已登录 ${result.login}`);
  app.quit();
}

/**
 * 自检：把「令牌能不能读、建仓为什么失败」查清楚并落盘。
 *
 * 存在的理由：403 的原因只写在 GitHub 的响应头/响应体里，
 * 而用户能给我的只有一句「创建失败（GitHub 返回 403）」。
 * 这个入口走的是**和界面完全一样**的 readToken() / createRepo() 路径，
 * 所以它给出的结论就是界面会遇到的情况。
 */
async function runSelfProbe(outPath) {
  const lines = [];
  const log = (s) => {
    lines.push(String(s));
    console.log(s);
  };
  const flush = () => {
    try {
      fs.writeFileSync(path.resolve(outPath), lines.join('\n'), 'utf8');
    } catch {}
  };

  try {
    log('=== 令牌 ===');
    log('tokenMode = ' + tokenMode());
    log('encryptionAvailable = ' + encryptionAvailable());
    const token = readToken();
    log('readToken() = ' + (token ? `成功（长度 ${token.length}，前缀 ${token.slice(0, 4)}…）` : '失败'));
    if (!token) {
      log('lastTokenError = ' + (lastTokenError || '(空)'));
      flush();
      app.quit();
      return;
    }

    log('\n=== GET /user ===');
    const me = await verifyToken(token);
    log('ok = ' + me.ok + (me.ok ? `, login = ${me.login}, scopes = ${(me.scopes ?? []).join(',') || '(未返回)'}` : `, error = ${me.error}`));

    log('\n=== 建仓探测 ===');
    const name = 'dshwb-probe-' + Date.now().toString(36);
    const created = await createRepo(token, {
      name,
      private: true,
      autoInit: true,
      description: '自动探针，稍后删除',
      source: 'dsh',
      sourceLabel: 'DeepSeek Harness',
    });
    log('ok = ' + created.ok);
    if (!created.ok) {
      log('error = ' + created.error);
      log('forbidden = ' + (created.forbidden ?? false));
      log('unauthorized = ' + (created.unauthorized ?? false));
      log('exists = ' + (created.exists ?? false));
    } else {
      log('创建成功: ' + created.fullName);
      const del = await deleteRepo(token, created.owner, created.name);
      log('清理: ' + (del.ok ? '已删除探测仓库' : '删除失败 ' + del.error));
    }
  } catch (error) {
    log('EXCEPTION: ' + (error?.stack ?? error));
  } finally {
    flush();
    app.quit();
  }
}

// ───────────────────────────────────────────── IPC：启动

ipcMain.handle('app:bootstrap', async () => {
  const config = currentConfig();
  const token = readToken();
  return {
    hasConfig: config !== undefined,
    config,
    hasToken: typeof token === 'string' && token.length > 0,
    tokenProblem: lastTokenError,
    tokenMode: tokenMode(),
    encryptionAvailable: encryptionAvailable(),
    paths,
    platform: process.platform,
    hostname: os.hostname(),
    engineVersion: ENGINE_VERSION,
    presets: SOURCE_PRESETS,
    gitignoreTemplates: GITIGNORE_TEMPLATES,
    licenseKeys: LICENSE_KEYS,
  };
});

ipcMain.handle('app:initConfig', async (_event, options = {}) => {
  const config = bootstrapConfig(options.machine ?? os.hostname());
  return persist(config);
});

// ───────────────────────────────────────────── IPC：账号

ipcMain.handle('github:verifyToken', async (_event, token) => {
  const result = await verifyToken(token);
  if (!result.ok) return result;
  saveToken(token, encryptionAvailable() ? cryptoBridge() : undefined);
  lastTokenError = '';
  const config = currentConfig();
  if (config) {
    config.github = { login: result.login, avatar: result.avatar };
    persist(config);
  }
  return result;
});

ipcMain.handle('github:signOut', async () => {
  clearToken();
  const config = currentConfig();
  if (config) {
    config.github = { login: '', avatar: '' };
    persist(config);
  }
  return { ok: true };
});

/**
 * 在系统浏览器里打开链接。
 *
 * 早先这里无条件 `return { ok: true }`，有三个后果：
 *   · URL 拼错（比如 https://github.com/undefined）时打开失败，界面完全无感；
 *   · 非 http(s) 协议也会被交给系统，有安全风险；
 *   · 用户只能看到「点了没反应」，没有任何线索。
 * 现在校验 + 捕获 + 如实返回，前端据此提示。
 */
ipcMain.handle('github:openUrl', async (_event, url) => {
  const target = String(url ?? '').trim();
  if (!target) return { ok: false, error: '没有可打开的地址' };
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: `不是有效的网页地址：${target}` };
  }
  // 明确拦掉拼装失败的典型产物，别把坏地址丢给系统
  if (/undefined|null|\[object/i.test(target)) {
    return { ok: false, error: `这个仓库还没有可用的 GitHub 地址（${target}）` };
  }
  try {
    await shell.openExternal(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `系统没能打开浏览器：${error.message}` };
  }
});

ipcMain.handle('github:probe', async () => {
  const result = await probeTransport();
  const config = currentConfig();
  if (config && result.ok) {
    config.proxy = result.proxy;
    persist(config);
  }
  return result;
});

// ───────────────────────────────────────────── IPC：仓库

function dirSize(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  }
  return total;
}

ipcMain.handle('repos:list', async () => {
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  const token = readToken();
  const out = [];
  for (const repo of config.repos ?? []) {
    let remote;
    if (token && repo.owner && repo.repoName) {
      try {
        remote = await getRepo(token, repo.owner, repo.repoName);
      } catch (error) {
        remote = { exists: false, error: error.message };
      }
    }
    out.push({
      ...repo,
      remote,
      cloned: fs.existsSync(path.join(repo.cacheDir, '.git')),
      sizeOnDisk: dirSize(repo.cacheDir),
    });
  }
  return { ok: true, repos: out, sources: describeSources(config) };
});

ipcMain.handle('repos:available', async () => {
  const token = readToken();
  if (!token) return { ok: false, error: '还没有登录' };
  return listRepos(token);
});

/**
 * 「账号里已经有哪些同步仓库」——按软件归类，标出本机是否已登记。
 *
 * 之前仓库页只读本机配置，换一台机器就显示「还没有仓库」，
 * 其实 GitHub 上那个仓库一直都在。这里直接把线上的仓库认回来。
 */
ipcMain.handle('repos:discover', async () => {
  const token = readToken();
  if (!token) return { ok: false, error: lastTokenError || '还没有登录' };
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };

  try {
    const found = await discoverRemoteRepos({
      token,
      sources: describeSources(config),
      registered: config.repos ?? [],
    });
    if (!found.ok) return found;

    /**
     * 自动登记：仓库页一打开就该看到「GitHub 上已经标识好的仓库」，
     * 而不是还要用户一个个点「加入本机」。
     *
     * 只自动收「有硬证据」的：
     *   marker / topic / description / legacy —— 这些都是仓库里真写着的东西；
     * 不收：
     *   marker-unknown（指向本机没装的软件）、未识别（没有标识）、
     *   local（已经登记过）。
     *
     * 这样既省掉手工步骤，又不会把「猜出来的」东西塞进本机配置。
     */
    const EVIDENCE = new Set(['marker', 'topic', 'description', 'legacy']);
    const adopted = [];
    for (const [sourceId, list] of Object.entries(found.bySource ?? {})) {
      const source = describeSources(config).find((s) => s.id === sourceId);
      if (!source) continue;

      for (const repo of list) {
        if (repo.registered) continue;
        if (!EVIDENCE.has(repo.confidence)) continue;

        const duplicated = config.repos.some(
          (r) => r.owner === repo.owner && r.repoName.toLowerCase() === String(repo.name).toLowerCase(),
        );
        if (duplicated) continue;

        const id = newRepoId();
        const record = normalizeRepo({
          id,
          // 优先用仓库自己记着的名字（manifest 里的），其次用 GitHub 仓库名
          name: repo.manifestName || repo.name,
          owner: repo.owner,
          repoName: repo.name,
          branch: repo.defaultBranch || 'main',
          private: repo.private !== false,
          description: repo.description ?? '',
          source: source.id,
          topics: Array.isArray(repo.topics) ? repo.topics : [],
          cacheDir: path.join(paths.repos, id),
          htmlUrl: `https://github.com/${repo.owner}/${repo.name}`,
          createdAt: new Date().toISOString(),
        });
        config.repos.push(record);
        repo.registered = true;
        repo.localId = id;
        repo.localName = record.name;
        adopted.push({ owner: repo.owner, name: repo.name, source: source.id, label: source.label });
      }
    }

    if (adopted.length > 0) {
      persist(config);
      // 登记之后再跑一次，让 counts / registered 标记以线上为准
      const refreshed = await discoverRemoteRepos({
        token,
        sources: describeSources(config),
        registered: config.repos ?? [],
      });
      if (refreshed.ok) Object.assign(found, refreshed);
    }

    // 本机登记过的仓库，把显示名也带上，卡片上就不用再猜
    const byKey = new Map(
      (config.repos ?? []).map((repo) => [`${String(repo.owner).toLowerCase()}/${repo.repoName.toLowerCase()}`, repo]),
    );
    const decorate = (repo) => {
      const local = byKey.get(`${String(repo.owner).toLowerCase()}/${String(repo.name).toLowerCase()}`);
      return local ? { ...repo, localId: local.id, localName: local.name, localSource: local.source, branch: local.branch } : repo;
    };

    const bySource = {};
    for (const [id, list] of Object.entries(found.bySource ?? {})) bySource[id] = list.map(decorate);

    return {
      ...found,
      bySource,
      unknown: (found.unknown ?? []).map(decorate),
      adopted,
      login: config.github?.login ?? '',
      markerFile: MARKER_FILE,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/**
 * 「加入已有仓库」：换机时不用重新建仓，填地址就能接管。
 *
 * 三个入口共用这里：
 *   · 手填 owner/repoName（不知道归属时才会去克隆，从标识文件认）
 *   · 仓库页上一键加入（归属已经由 discover 认出来了，直接登记）
 *   · 「未识别的仓库」里手动指定软件（认领，会顺手补写标识）
 *
 * 传了 `source` 就不再克隆——认一个仓库要拉几百 MB 太浪费，
 * 真正的克隆留到第一次同步时按需做。
 *
 * 不管从哪个入口进来，只要归属确定，都会把 `dshwb-sync.json` 写进仓库：
 * 这样这台的登记结果对下一台机器就是可读的事实，而不是又一份「谁也没写下来」的约定。
 */
ipcMain.handle('repos:adopt', async (_event, payload = {}) => {
  const { owner, repoName, source, name, branch, description } = payload;
  const token = readToken();
  if (!token) return { ok: false, error: '还没有登录' };
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  if (!owner || !repoName) return { ok: false, error: '所有者和仓库名都要填' };

  const duplicated = config.repos.find(
    (repo) => repo.owner === owner && repo.repoName.toLowerCase() === String(repoName).toLowerCase(),
  );
  if (duplicated) return { ok: false, error: `本机已经登记过这个仓库：${duplicated.name}` };

  const id = newRepoId();
  const probe = normalizeRepo({
    id,
    name: name || repoName,
    owner,
    repoName,
    branch: branch || 'main',
    private: payload.private !== false,
    description: description ?? '',
    source: '',
    cacheDir: path.join(paths.repos, id),
    createdAt: new Date().toISOString(),
  });

  // ── 归属已知（discover 认出来了，或用户手动指定）：直接登记，不克隆
  const knownSource = source ? describeSources(config).find((s) => s.id === source) : undefined;
  if (knownSource) {
    return adoptRepoRecord(config, token, {
      owner,
      repoName,
      source: knownSource.id,
      sourceLabel: knownSource.label,
      // 没给显示名就用 GitHub 仓库名：同一软件下挂多个仓库时，
      // 全叫「XX 同步」根本分不清哪个是哪个
      name: name || repoName,
      branch,
      private: payload.private,
      description,
      claim: payload.claim !== false,
    });
  }

  let identified;
  try {
    identified = await buildEngine(config).identifyRepo(probe);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!identified.ok) {
    fs.rmSync(probe.cacheDir, { recursive: true, force: true });
    return { ok: false, error: identified.error };
  }

  const known = describeSources(config).find((s) => s.id === identified.source);
  if (!known) {
    fs.rmSync(probe.cacheDir, { recursive: true, force: true });
    return {
      ok: false,
      // 认不出来时把「手动指定软件」的入口指给用户，而不是让他对着错误发呆
      undetermined: Boolean(identified.unidentified),
      error: identified.unidentified
        ? `这个仓库里没有标识文件，认不出属于哪个软件。\n可以回到仓库页，在「未识别的仓库」里手动指定它属于哪个软件。`
        : `仓库标识指向「${identified.source}」，但本机没有这个软件`,
    };
  }

  const repo = normalizeRepo({
    ...probe,
    name: name || identified.name || `${known.label} 同步`,
    source: known.id,
    htmlUrl: `https://github.com/${owner}/${repoName}`,
  });
  config.repos.push(repo);
  persist(config);

  // 老仓库只有 manifest.json：顺手补上标识文件，下次换机就不用再整仓克隆一次
  const claimed = await claimRepo(token, {
    owner,
    repoName,
    sourceId: known.id,
    sourceLabel: known.label,
    machine: config.machine,
    version: ENGINE_VERSION,
  });

  return {
    ok: true,
    repo,
    sourceLabel: known.label,
    identified: !identified.unidentified,
    stamp: { ok: Boolean(claimed.ok), error: claimed.ok ? undefined : claimed.error },
  };
});

ipcMain.handle('repos:createRemote', async (_event, options) => {
  const token = readToken();
  if (!token) {
    // 区分「没登录」和「登录过但令牌读不出来」——后者最常见的原因是
    // 换了 Windows 用户/系统密钥变了，用户看到「还没有登录」会以为自己没登过
    return { ok: false, error: lastTokenError || '还没有登录' };
  }
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };

  const sameName = config.repos.find(
    (repo) => repo.repoName.toLowerCase() === String(options.name).toLowerCase() && repo.owner === (config.github?.login ?? ''),
  );
  if (sameName) return { ok: false, error: `本机已经登记过同名仓库「${sameName.name}」` };

  // 建仓 + 立刻写标识：这样「软件建的仓库」天生带记号，
  // 换一台机器扫一遍就能认出来，不用等到第一次同步。
  const result = await createRepoWithMarker(token, {
    ...options,
    machine: config.machine,
    version: ENGINE_VERSION,
  });
  if (!result.ok) return result;

  const id = newRepoId();
  const repo = normalizeRepo({
    id,
    name: options.localName || result.name,
    owner: result.owner,
    repoName: result.name,
    branch: result.defaultBranch ?? 'main',
    private: result.private,
    description: result.description ?? options.description ?? '',
    homepage: options.homepage ?? '',
    gitignoreTemplate: options.gitignoreTemplate ?? '',
    licenseTemplate: options.licenseTemplate ?? '',
    hasIssues: options.hasIssues,
    hasWiki: options.hasWiki,
    hasProjects: options.hasProjects,
    topics: result.topics ?? [],
    source: options.source,
    cacheDir: path.join(paths.repos, id),
    htmlUrl: result.htmlUrl,
    createdAt: new Date().toISOString(),
  });
  config.repos.push(repo);
  persist(config);

  return { ...result, localRepo: repo };
});

ipcMain.handle('repos:update', async (_event, { id, patch }) => {
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  const index = config.repos.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: '仓库不存在' };

  config.repos[index] = normalizeRepo({ ...config.repos[index], ...patch, id });
  persist(config);
  return { ok: true, repo: config.repos[index] };
});

ipcMain.handle('repos:remove', async (_event, { id, deleteCache }) => {
  const config = currentConfig();
  if (!config) return { ok: false };
  const repo = config.repos.find((item) => item.id === id);
  config.repos = config.repos.filter((item) => item.id !== id);
  persist(config);
  if (deleteCache && repo?.cacheDir && fs.existsSync(repo.cacheDir)) {
    fs.rmSync(repo.cacheDir, { recursive: true, force: true });
  }
  return { ok: true };
});

ipcMain.handle('repos:updateRemote', async (_event, { owner, repoName, patch }) => {
  const token = readToken();
  if (!token) return { ok: false, error: '还没有登录' };
  return updateRepo(token, owner, repoName, patch);
});

ipcMain.handle('repos:deleteRemote', async (_event, { owner, repoName }) => {
  const token = readToken();
  if (!token) return { ok: false, error: '还没有登录' };
  return deleteRepo(token, owner, repoName);
});

/**
 * 给已登记但 GitHub 上还没标识的仓库补写标识。
 *
 * 旧版本只写 topics + 描述前缀，标识文件是新加的，
 * 所以「以前建的仓库」需要跑一次这个；新版本建的仓库天生就有，跑也是空转。
 */
ipcMain.handle('repos:stampAll', async () => {
  const token = readToken();
  if (!token) return { ok: false, error: '还没有登录' };
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };

  const result = await backfillMarkers(token, {
    sources: describeSources(config),
    registered: config.repos ?? [],
    machine: config.machine,
    version: ENGINE_VERSION,
  });

  // 描述改了就同步回本地配置，否则界面上还是旧的那串
  for (const item of result.results ?? []) {
    const repo = config.repos.find((entry) => `${entry.owner}/${entry.repoName}` === item.repo);
    if (!repo) continue;
    const labels = describeSources(config).find((source) => source.id === repo.source);
    if (labels && !String(repo.description ?? '').startsWith(`[${labels.label}]`)) {
      repo.description = repo.description ? `[${labels.label}] ${repo.description}` : `[${labels.label}] 跨电脑同步`;
    }
  }
  persist(config);

  return result;
});

/**
 * 认领一个仓库：用户在「未识别的仓库」里指定它属于哪个软件。
 *
 * 写入标识 → 登记到本机。之后任何一台机器扫一遍都能认出它，
 * 不用每台都人工点一次。
 */
ipcMain.handle('repos:claim', async (_event, payload = {}) => {
  const { owner, repoName, source, name, branch, private: isPrivate, description } = payload;
  const token = readToken();
  if (!token) return { ok: false, error: '还没有登录' };
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  if (!owner || !repoName) return { ok: false, error: '缺少仓库地址' };

  const known = describeSources(config).find((s) => s.id === source);
  if (!known) return { ok: false, error: `本机没有「${source}」这个软件` };

  return adoptRepoRecord(config, token, {
    owner,
    repoName,
    source: known.id,
    sourceLabel: known.label,
    name,
    branch,
    private: isPrivate,
    description,
    claim: true,
  });
});

/** adopt 的共用实现（两个 IPC 入口都走这里，避免规则分叉）。 */
async function adoptRepoRecord(config, token, payload) {
  const duplicated = config.repos.find(
    (repo) => repo.owner === payload.owner && repo.repoName.toLowerCase() === String(payload.repoName).toLowerCase(),
  );
  if (duplicated) return { ok: false, error: `本机已经登记过这个仓库：${duplicated.name}` };

  const id = newRepoId();
  const repo = normalizeRepo({
    id,
    name: payload.name || payload.repoName,
    owner: payload.owner,
    repoName: payload.repoName,
    branch: payload.branch || 'main',
    private: payload.private !== false,
    description: payload.description ?? '',
    source: payload.source,
    cacheDir: path.join(paths.repos, id),
    htmlUrl: `https://github.com/${payload.owner}/${payload.repoName}`,
    createdAt: new Date().toISOString(),
  });
  config.repos.push(repo);
  persist(config);

  const claimed = await claimRepo(token, {
    owner: payload.owner,
    repoName: payload.repoName,
    sourceId: payload.source,
    sourceLabel: payload.sourceLabel,
    machine: config.machine,
    version: ENGINE_VERSION,
  });

  return {
    ok: true,
    repo,
    sourceLabel: payload.sourceLabel,
    identified: true,
    fast: true,
    stamp: { ok: Boolean(claimed.ok), error: claimed.ok ? undefined : claimed.error },
  };
}

// ───────────────────────────────────────────── IPC：数据源

ipcMain.handle('sources:inspect', async () => {
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  try {
    const sources = await buildEngine(config).inspect();
    return { ok: true, sources, config };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('sources:addCustom', async (_event, input) => {
  const config = currentConfig();
  if (!config) return { ok: false };
  const homeKey = input.homeKey || `${input.id}`;
  config.softwareHome[homeKey] = input.home;
  const list = config.customSources.filter((item) => item.id !== input.id);
  list.push({
    id: input.id,
    label: input.label,
    description: input.description ?? '',
    icon: input.icon ?? '▣',
    homeKey,
    enabled: true,
  });
  config.customSources = list;
  persist(config);
  return { ok: true, homeKey };
});

ipcMain.handle('sources:removeCustom', async (_event, id) => {
  const config = currentConfig();
  if (!config) return { ok: false };
  config.customSources = config.customSources.filter((item) => item.id !== id);
  config.repos = config.repos.filter((repo) => repo.source !== id);
  persist(config);
  return { ok: true };
});

// ───────────────────────────────────────────── IPC：同步

ipcMain.handle('sync:run', async (_event, { repoId, mode, keys }) => {
  if (busy) return { ok: false, error: '已有任务在运行' };
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  const repo = config.repos.find((item) => item.id === repoId);
  if (!repo) return { ok: false, error: '找不到这个仓库' };
  if (!readToken()) return { ok: false, error: lastTokenError || '还没有登录 GitHub' };

  busy = true;
  const engine = buildEngine(config);
  try {
    const result = await engine.runRepo({ repo, mode, selection: { keys } });

    const index = config.repos.findIndex((item) => item.id === repoId);
    if (index >= 0) {
      config.repos[index] = {
        ...config.repos[index],
        lastSyncAt: new Date().toISOString(),
        lastSyncResult: result.ok ? 'ok' : 'error',
      };
      persist(config);
    }
    return { ...result, canRestore: engine.hasBackup() };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    busy = false;
  }
});

// ───────────────────────────────────────────── IPC：远端浏览

function repoFor(id) {
  const config = currentConfig();
  if (!config) return { error: '还没有配置' };
  const repo = config.repos.find((item) => item.id === id);
  if (!repo) return { error: '找不到这个仓库' };
  const token = readToken();
  if (!token) return { error: lastTokenError || '还没有登录 GitHub（到「账号」页贴一个令牌）' };
  return { repo, engine: buildEngine(config) };
}

function persistProxy(engine) {
  const config = currentConfig();
  if (config && engine.config.proxy !== config.proxy) {
    config.proxy = engine.config.proxy;
    persist(config);
  }
}

ipcMain.handle('browse:list', async (_event, { repoId, query }) => {
  const resolved = repoFor(repoId);
  if (resolved.error) return { ok: false, error: resolved.error };
  try {
    const result = await browseRemote({ engine: resolved.engine, repo: resolved.repo, query });
    persistProxy(resolved.engine);
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browse:compare', async (_event, { repoId, relPath }) => {
  const resolved = repoFor(repoId);
  if (resolved.error) return { ok: false, error: resolved.error };
  try {
    const result = await compareFile({ engine: resolved.engine, repo: resolved.repo, relPath });
    persistProxy(resolved.engine);
    if (result.ok && result.hunks && result.hunks.length > 4000) {
      result.hunks = result.hunks.slice(0, 4000);
      result.truncated = true;
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browse:takeRemote', async (_event, { repoId, relPath }) => {
  const resolved = repoFor(repoId);
  if (resolved.error) return { ok: false, error: resolved.error };
  try {
    const result = await takeRemote({ engine: resolved.engine, repo: resolved.repo, relPath });
    persistProxy(resolved.engine);
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browse:pushLocal', async (_event, { repoId, relPath }) => {
  const resolved = repoFor(repoId);
  if (resolved.error) return { ok: false, error: resolved.error };
  try {
    return await pushLocal({ engine: resolved.engine, repo: resolved.repo, relPath });
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browse:writeRemote', async (_event, { repoId, relPath, content }) => {
  const resolved = repoFor(repoId);
  if (resolved.error) return { ok: false, error: resolved.error };
  try {
    return await writeRemoteFile({ engine: resolved.engine, repo: resolved.repo, relPath, content });
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('browse:deleteRemote', async (_event, { repoId, relPath, relPaths }) => {
  const resolved = repoFor(repoId);
  if (resolved.error) return { ok: false, error: resolved.error };
  try {
    const paths = Array.isArray(relPaths) ? relPaths : [relPath];
    return await deleteRemoteFiles({ engine: resolved.engine, repo: resolved.repo, relPaths: paths });
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ───────────────────────────────────────────── IPC：配置

ipcMain.handle('config:get', async () => currentConfig());

ipcMain.handle('config:update', async (_event, patch) => {
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  const next = persist({ ...config, ...patch });
  return { ok: true, config: next };
});

ipcMain.handle('config:setWorkspaceRoot', async (_event, { sourceId, path: rootPath }) => {
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  config.workspaceRoot[sourceId] = rootPath ?? '';
  persist(config);
  return { ok: true, config };
});

ipcMain.handle('config:setSoftwareHome', async (_event, { sourceId, path: homePath }) => {
  const config = currentConfig();
  if (!config) return { ok: false, error: '还没有配置' };
  config.softwareHome[sourceId] = homePath ?? '';
  persist(config);
  return { ok: true, config };
});

ipcMain.handle('config:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择目录' });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

// ───────────────────────────────────────────── IPC：诊断

ipcMain.handle('diag:info', async () => {
  const config = currentConfig();
  const token = readToken();
  return {
    engineVersion: ENGINE_VERSION,
    node: process.versions.node,
    electron: process.versions.electron,
    platform: process.platform,
    hostname: os.hostname(),
    hasToken: Boolean(token),
    tokenProblem: lastTokenError,
    tokenMode: tokenMode(),
    encryptionAvailable: encryptionAvailable(),
    paths,
    proxy: config?.proxy ?? '',
    softwareHome: config?.softwareHome ?? {},
    workspaceRoot: config?.workspaceRoot ?? {},
    repos: (config?.repos ?? []).map((repo) => ({
      name: repo.name,
      target: `${repo.owner}/${repo.repoName}`,
      source: repo.source,
      cloned: fs.existsSync(path.join(repo.cacheDir, '.git')),
    })),
    git: await detectGit(),
  };
});

function detectGit() {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => resolve(code === 0 ? out.trim() : undefined));
      child.on('error', () => resolve(undefined));
    });
  });
}

ipcMain.handle('diag:openStateFolder', async () => {
  await shell.openPath(paths.home);
  return { ok: true };
});

// ───────────────────────────────────────────── 自检截图

async function runSelfShot(dir) {
  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errors = [];
  mainWindow.webContents.on('console-message', (event) => {
    if (event?.level === 'error') errors.push(String(event.message));
  });

  try {
    await runSelfShotBody(target, wait, errors);
  } catch (error) {
    console.log('自检失败：' + (error?.stack ?? error));
    fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify({ fatal: String(error?.stack ?? error), errors }, null, 2));
    app.quit();
  }
}

async function runSelfShotBody(target, wait, errors) {
  await wait(5000);

  const health = await mainWindow.webContents.executeJavaScript(`({
    failed: document.body.innerText.startsWith('启动失败'),
    text: document.body.innerText.slice(0, 200),
    navItems: document.querySelectorAll('.nav-item').length,
  })`);
  if (health.failed) {
    fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify({ startupFailed: health, errors }, null, 2));
    console.log('页面启动失败：' + health.text);
    app.quit();
    return;
  }

  fs.writeFileSync(path.join(target, 'shot-sync.png'), (await mainWindow.webContents.capturePage()).toPNG());
  const syncState = await mainWindow.webContents.executeJavaScript(`({
    activeView: document.querySelector('.view.active')?.id,
    tabs: [...document.querySelectorAll('#source-tabs .tab')].map(t => t.textContent.trim()),
    containers: document.querySelectorAll('.container-card').length,
  })`);

  await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="repos"]').click(); 1`);
  await wait(2500);
  fs.writeFileSync(path.join(target, 'shot-repos.png'), (await mainWindow.webContents.capturePage()).toPNG());
  const repoView = await mainWindow.webContents.executeJavaScript(`({
    tabs: [...document.querySelectorAll('#repo-tabs .tab')].map(t => t.textContent.trim()),
    cards: document.querySelectorAll('.repo-card').length,
    hasAddButton: Boolean(document.getElementById('add-repo-tab')),
  })`);

  // 导航记忆验证：进远端内容 → 切到选项 → 点侧栏「仓库」应回到远端内容（且已刷新）
  const navMemory = await mainWindow.webContents.executeJavaScript(`(async () => {
    const btn = [...document.querySelectorAll('.repo-card .btn')].find(b => b.textContent === '远端内容');
    if (!btn) return { skipped: '没有仓库卡片' };
    btn.click();
    await new Promise(r => setTimeout(r, 4000));
    const inBrowser = document.getElementById('view-browser').classList.contains('active');
    const status1 = document.getElementById('browser-status')?.textContent ?? '';

    document.querySelector('[data-view="options"]').click();
    await new Promise(r => setTimeout(r, 500));
    const inOptions = document.getElementById('view-options').classList.contains('active');

    document.querySelector('[data-view="repos"]').click();
    await new Promise(r => setTimeout(r, 4000));
    const backToBrowser = document.getElementById('view-browser').classList.contains('active');
    const backToRepos = document.getElementById('view-repos').classList.contains('active');
    const status2 = document.getElementById('browser-status')?.textContent ?? '';

    return { inBrowser, inOptions, backToBrowser, backToRepos, status1, status2 };
  })()`);
  fs.writeFileSync(path.join(target, 'shot-browser.png'), (await mainWindow.webContents.capturePage()).toPNG());

  fs.writeFileSync(
    path.join(target, 'state.json'),
    JSON.stringify({ syncState, repoView, navMemory, errors }, null, 2),
  );
  console.log(JSON.stringify({ syncState, repoView, navMemory, errors }, null, 2));
  app.quit();
}
