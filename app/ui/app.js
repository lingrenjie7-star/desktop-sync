// 渲染层：按软件原生层级（工作区 → 对话），一对一仓库绑定。

const state = {
  bootstrap: null,
  config: null,
  sources: [],
  repos: [],
  selected: new Set(),
  allKeys: [],
  busy: false,
  activeTab: '',
  activeRepoSource: '',
  targetRepo: '',
  /** GitHub 上扫到的仓库（本机登记与否都在里面），按软件分组 */
  remote: null,
  remoteBusy: false,
  remoteError: '',
  browsing: null,
  browseCache: undefined,
  lastInRepoSection: 'repos',
  diff: null,
  modal: null,
};

/** 「未识别」标签页的伪 source id：账号里有仓库认不出归属时用它当标签。 */
const UNKNOWN_TAB = '__unknown__';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ───────────────────────────────── 提示

let toastTimer;
function toast(message, kind = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = 'toast ' + kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'bad' ? 6500 : 3200);
}

const setHint = (id, message, kind = '') => {
  const node = $(id);
  if (!node) return;
  node.textContent = message ?? '';
  node.className = 'hint ' + kind;
};

const setStatus = (id, message, kind = '') => {
  const node = $(id);
  if (!node) return;
  node.textContent = message;
  node.className = 'card-status ' + kind;
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/**
 * 算出仓库在 GitHub 上的地址。
 *
 * 之前三处按钮各写各的，其中两处写成
 *   `repo.htmlUrl || \`https://github.com/${repo.fullName}\``
 * 但本机登记的仓库对象**没有 fullName 字段**（normalizeRepo 不产出它），
 * 于是拼出 https://github.com/undefined —— shell.openExternal 打不开，
 * 用户看到的就是「点了没反应」。
 *
 * 这里按「哪个字段真的有」依次回退，并保证永远不拼出 undefined。
 */
function repoUrl(repo) {
  if (!repo) return '';
  if (repo.htmlUrl) return repo.htmlUrl;
  const owner = repo.owner;
  const name = repo.repoName || repo.name;
  if (owner && name) return `https://github.com/${owner}/${name}`;
  if (repo.fullName) return `https://github.com/${repo.fullName}`;
  return '';
}

/**
 * 打开仓库页。统一走这里，失败要告诉用户，而不是静默什么都不发生。
 */
async function openRepoUrl(repo) {
  const url = typeof repo === 'string' ? repo : repoUrl(repo);
  if (!url) {
    toast('这个仓库还没有 GitHub 地址', 'bad');
    return;
  }
  const result = await window.api.openUrl(url);
  if (result && result.ok === false) {
    toast(result.error ?? '没能打开浏览器', 'bad');
  }
}

const formatBytes = (bytes) => {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

// ───────────────────────────────── 视图

function showView(name) {
  for (const button of document.querySelectorAll('.nav-item')) {
    // 「远端内容」属于「仓库」这一栏，侧栏高亮跟随
    const nav = button.dataset.view;
    const active = nav === name || (nav === 'repos' && name === 'browser');
    button.classList.toggle('active', active);
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('active', view.id === `view-${name}`);
  }

  // 记住「仓库」栏里最后停在哪一页：列表还是某个远端内容
  if (name === 'repos') state.lastInRepoSection = 'repos';
  if (name === 'browser') state.lastInRepoSection = 'browser';

  if (name === 'options') refreshDiagnostics();
  if (name === 'repos') {
    renderRepoView();
    /**
     * 每次进仓库页都重新核对 GitHub。
     *
     * 之前的条件里有个 `!state.remote` —— 意思是「已经扫过就不再扫」，
     * 于是这个会话里第一次之后永远不再刷新：
     *   · 你删了云端仓库，界面上那张卡片一直留着；
     *   · 另一台机器新加的仓库看不到；
     *   · 在别的页面改了东西，回到仓库页还是旧数据。
     * 现在改成「每次进来都刷」，并且总是静默（不弹 toast 打断你）。
     */
    if (state.bootstrap?.hasToken) refreshRemote({ silent: true });
  }
  // 「远端内容」页由 openBrowser 自己负责加载，这里不重复请求
}

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => {
    const target = button.dataset.view;

    // 「仓库」这一栏包含两个页面：仓库列表和远端内容。
    // 用户上次停在远端内容，再点侧栏就该回到远端内容，而不是被踢回列表。
    if (target === 'repos' && state.browsing && state.lastInRepoSection === 'browser') {
      // 回到远端内容页，但仍然重新加载一次：删了/上传了之后旧数据会骗人
      showView('browser');
      loadBrowser($('browser-search').value || '', { silent: Boolean(state.browsing.data) });
      return;
    }

    showView(target);
  });
}

// ───────────────────────────────── 启动

async function boot() {
  state.bootstrap = await window.api.bootstrap();
  state.config = state.bootstrap.config;

  $('machine-label').textContent = state.config?.machine ?? state.bootstrap.hostname;
  $('machine-sub').textContent = `${state.bootstrap.hostname} · ${state.bootstrap.platform}`;

  if (!state.bootstrap.hasConfig) {
    await window.api.initConfig({ machine: state.bootstrap.hostname });
    state.bootstrap = await window.api.bootstrap();
    state.config = state.bootstrap.config;
  }

  if (state.bootstrap.hasToken) {
    $('auth-body').hidden = true;
    $('auth-signed').hidden = false;
    $('account-name').textContent = state.config?.github?.login || '已保存令牌';
    $('account-scopes').textContent = `存储方式：${state.bootstrap.tokenMode === 'safeStorage' ? '系统加密' : '明文文件'}`;
    if (state.config?.github?.avatar) {
      $('account-avatar').style.backgroundImage = `url(${state.config.github.avatar})`;
    }
    setStatus('auth-status', '已连接', 'ok');
  } else if (state.bootstrap.tokenProblem) {
    $('auth-body').hidden = false;
    $('auth-signed').hidden = true;
    setStatus('auth-status', '需要重新登录', 'bad');
    setHint('token-hint', state.bootstrap.tokenProblem, 'bad');
  } else {
    setStatus('auth-status', '未连接', 'bad');
  }

  setStatus('net-status', state.config?.proxy ? '走代理' : '直连', '');
  $('net-detail').textContent = state.config?.proxy ? `当前代理：${state.config.proxy}` : '当前直连（连不上就点自动检测）';

  populatePresets();
  // 先读软件清单：仓库页的标签页按软件分组，依赖它
  await refreshSources();
  await refreshRepos();
  wireProgress();
  refreshDiagnostics();
}

function populatePresets() {
  const preset = $('preset-select');
  preset.innerHTML = '';
  for (const item of state.bootstrap.presets ?? []) {
    const option = el('option', '', `${item.icon} ${item.label} — ${item.description}`);
    option.value = item.id;
    preset.appendChild(option);
  }
}

function wireProgress() {
  window.api.onProgress((event) => {
    if (event.type === 'stage') {
      $('busy-title').textContent = event.message ?? '正在同步…';
      $('busy-detail').textContent = '';
      $('busy-bar').classList.add('indeterminate');
    } else if (event.type === 'warning') {
      $('busy-detail').textContent = event.message;
    }
  });
}

// ───────────────────────────────── 数据源（层级）

async function refreshSources() {
  $('sources').innerHTML = '<div class="loading">正在扫描本机…</div>';
  const result = await window.api.inspectSources();
  if (!result.ok) {
    $('sources').innerHTML = `<div class="empty-state">扫描失败：${escapeHtml(result.error)}</div>`;
    return;
  }
  state.sources = result.sources;
  state.allKeys = result.sources.flatMap((s) => s.containers.flatMap((c) => [c.key, ...c.items.map((i) => i.key)]));

  if (state.selected.size === 0) {
    // 默认勾选「对话」层级，配置类先不选
    for (const source of result.sources) {
      for (const container of source.containers) {
        if (!container.global) state.selected.add(container.key);
      }
    }
  }

  renderTabs();
  renderSources();
  syncTargetSelect();
}

function renderTabs() {
  const tabs = $('source-tabs');
  tabs.innerHTML = '';
  const installed = state.sources.filter((s) => s.installed);

  if (installed.length === 0) {
    state.activeTab = '';
    renderSources();
    return;
  }
  if (!installed.some((s) => s.id === state.activeTab)) state.activeTab = installed[0].id;

  for (const source of installed) {
    const chosen = source.containers.filter((c) => state.selected.has(c.key)).length;
    const tab = el('button', 'tab' + (source.id === state.activeTab ? ' active' : ''));
    tab.dataset.tab = source.id;
    tab.appendChild(el('span', 'tab-icon', source.icon ?? '▣'));
    tab.appendChild(el('span', 'tab-label', source.label));
    tab.appendChild(el('span', 'tab-count', `${chosen}/${source.containers.length}`));
    // 这个软件有几个仓库；0 个时给个提示色
    const repoCount = (source.repos ?? []).length;
    const dot = el('span', 'tab-dot' + (repoCount === 0 ? ' warn' : ''));
    dot.title = repoCount === 0 ? '还没有仓库' : `${repoCount} 个仓库`;
    tab.appendChild(dot);
    tabs.appendChild(tab);

    tab.addEventListener('click', () => {
      state.activeTab = source.id;
      state.targetRepo = ''; // 换软件后重选仓库
      renderTabs();
      renderSources();
      syncTargetSelect();
    });
  }
}

function activeSource() {
  return state.sources.find((s) => s.id === state.activeTab);
}

function renderSources() {
  const container = $('sources');
  container.innerHTML = '';

  const source = activeSource();
  if (!source) {
    container.innerHTML =
      '<div class="empty-state"><h3>没发现可同步的软件</h3><p>到「选项 → 追加软件」里手动添加目录</p></div>';
    $('tab-hint').textContent = '';
    $('sync-subtitle').textContent = '按软件自己的层级组织。';
    updateActions();
    return;
  }

  const tier = source.tier ?? { containerLabel: '分组', itemLabel: '条目' };
  $('sync-subtitle').textContent = `${source.label}：${tier.containerLabel} → ${tier.itemLabel}。勾一个${tier.containerLabel}就等于勾它下面全部${tier.itemLabel}。`;

  if (source.containers.length === 0) {
    container.appendChild(el('div', 'empty-state', '这个软件里没有可同步的内容'));
    updateTabHint();
    updateActions();
    return;
  }

  for (const item of source.containers) {
    container.appendChild(renderContainer(source, item, tier));
  }

  updateTabHint();
  updateActions();
}

/** 一个容器卡片 = 一个工作区 / 项目。 */
function renderContainer(source, container, tier) {
  const card = el('div', 'container-card' + (container.global ? ' global' : ''));

  const head = el('div', 'container-head');
  const master = el('input', 'check');
  master.type = 'checkbox';
  master.dataset.container = container.key;
  master.checked = state.selected.has(container.key);

  const icon = el('div', 'container-icon', container.global ? '⚙' : source.icon ?? '▣');

  const info = el('div', 'container-info');
  const titleRow = el('div', 'container-title-row');
  titleRow.appendChild(el('span', 'container-title', container.label));
  titleRow.appendChild(el('span', 'container-kind', container.global ? '全局' : tier.containerLabel));
  info.appendChild(titleRow);
  info.appendChild(el('div', 'container-detail', container.detail ?? ''));

  const stats = el('div', 'container-stats');
  stats.appendChild(el('div', '', `${container.items.length} 个${tier.itemLabel}`));
  if (container.bytes) stats.appendChild(el('div', '', formatBytes(container.bytes)));

  const toggle = el('span', 'container-toggle', '▾');

  head.append(master, icon, info, stats, toggle);
  card.appendChild(head);

  master.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleContainer(container, master.checked);
    renderTabs();
    refreshChecks();
  });

  head.addEventListener('click', (event) => {
    if (event.target === master) return;
    card.classList.toggle('open');
  });

  const body = el('div', 'container-body');
  body.style.display = container.items.length > 0 ? '' : 'none';
  for (const item of container.items) {
    body.appendChild(renderItem(container, item, master));
  }
  card.appendChild(body);

  // 默认展开第一个
  if (!container.global) card.classList.add('open');

  if (container.items.length === 0) {
    toggle.style.visibility = 'hidden';
  }

  return card;
}

function toggleContainer(container, checked) {
  if (checked) {
    state.selected.add(container.key);
    for (const item of container.items) {
      if (!item.blocked) state.selected.add(item.key);
    }
  } else {
    state.selected.delete(container.key);
    for (const item of container.items) state.selected.delete(item.key);
  }
  syncContainerCheck(container);
}

function renderItem(container, item, master) {
  const row = el('label', 'item' + (item.blocked ? ' blocked' : ''));

  const check = el('input', 'check');
  check.type = 'checkbox';
  check.dataset.key = item.key;
  check.checked = state.selected.has(item.key) || state.selected.has(container.key);
  check.disabled = Boolean(item.blocked);
  if (item.blocked) check.title = item.detail ?? '不会同步';

  const main = el('div', 'item-main');
  main.appendChild(el('div', 'item-label', item.label));
  if (item.detail) main.appendChild(el('div', 'item-detail', item.detail));

  const meta = el('div', 'item-meta', item.meta ?? '');

  row.append(check, main, meta);

  check.addEventListener('change', () => {
    if (check.checked) state.selected.add(item.key);
    else state.selected.delete(item.key);
    syncContainerCheck(container);
    refreshChecks();
  });

  return row;
}

function syncContainerCheck(container) {
  const master = document.querySelector(`.check[data-container="${CSS.escape(container.key)}"]`);
  if (!master) return;
  const selectedCount = container.items.filter(
    (item) => state.selected.has(item.key) || state.selected.has(container.key),
  ).length;
  master.checked = state.selected.has(container.key) || (selectedCount === container.items.length && container.items.length > 0);
  master.indeterminate = !master.checked && selectedCount > 0;
}

function refreshChecks() {
  const source = activeSource();
  if (!source) return;

  for (const check of document.querySelectorAll('.check[data-key]')) {
    check.checked = state.selected.has(check.dataset.key);
  }
  for (const container of source.containers) {
    const master = document.querySelector(`.check[data-container="${CSS.escape(container.key)}"]`);
    if (!master) continue;
    const covered = state.selected.has(container.key);
    const count = container.items.filter((i) => state.selected.has(i.key)).length;
    master.checked = covered || (count === container.items.length && container.items.length > 0);
    master.indeterminate = !master.checked && count > 0;

    // 勾了容器时，把子项也显示为勾上
    for (const item of container.items) {
      const node = document.querySelector(`.check[data-key="${CSS.escape(item.key)}"]`);
      if (node) node.checked = covered || state.selected.has(item.key);
    }
  }
  updateTabHint();
  updateActions();
}

function updateTabHint() {
  const source = activeSource();
  if (!source) {
    $('tab-hint').textContent = '';
    return;
  }
  const tier = source.tier ?? { containerLabel: '分组', itemLabel: '条目' };
  const containers = source.containers.filter((c) => state.selected.has(c.key)).length;
  $('tab-hint').textContent = `${source.label}：已选 ${containers} / ${source.containers.length} 个${tier.containerLabel}`;
}

function updateActions() {
  const source = activeSource();
  const hasRepo = Boolean(state.targetRepo);
  const canRun = hasRepo && state.selected.size > 0 && !state.busy;
  for (const id of ['act-upload', 'act-download']) {
    $(id).disabled = !canRun;
  }
}

// 工具栏
for (const button of document.querySelectorAll('[data-self]')) {
  button.addEventListener('click', () => {
    const source = activeSource();
    if (!source) return;
    const mode = button.dataset.self;
    if (mode === 'all') {
      for (const container of source.containers) {
        state.selected.add(container.key);
        for (const item of container.items) if (!item.blocked) state.selected.add(item.key);
      }
    } else if (mode === 'none') {
      state.selected.clear();
    }
    renderTabs();
    renderSources();
  });
}

$('refresh').addEventListener('click', async () => {
  await refreshSources();
  toast('已重新扫描');
});

// ───────────────────────────────── 仓库（分标签页）

/**
 * 同步页的仓库下拉：只列当前软件能用的仓库。
 * 一个软件可以有多个仓库，这里选这次推给哪个。
 */
function syncTargetSelect() {
  const select = $('repo-target');
  if (!select) return;
  select.innerHTML = '';

  const source = activeSource();
  const usable = source ? state.repos.filter((repo) => repo.source === source.id) : [];

  if (usable.length === 0) {
    const option = el('option', '', source ? `${source.label} 还没有仓库` : '没有仓库');
    option.value = '';
    select.appendChild(option);
    select.disabled = true;
    state.targetRepo = '';
    updateActions();
    return;
  }

  select.disabled = false;
  if (!usable.some((repo) => repo.id === state.targetRepo)) state.targetRepo = usable[0].id;

  for (const repo of usable) {
    const option = el('option', '', `${repo.name} · ${repo.repoName}${repo.private ? '' : '（公开）'}`);
    option.value = repo.id;
    if (repo.id === state.targetRepo) option.selected = true;
    select.appendChild(option);
  }
  updateActions();
}

$('repo-target').addEventListener('change', (event) => {
  state.targetRepo = event.target.value;
  updateActions();
});

async function refreshRepos(options = {}) {
  const result = await window.api.listRepos();
  if (!result.ok) return;
  state.repos = result.repos;
  $('repo-count').textContent = String(state.repos.length);
  renderRepoView();
  syncTargetSelect();

  // 顺带把 GitHub 上的仓库也认一遍：换台机器打开这一页，
  // 不该只看到「本机建过的」，账号里早就有的仓库也应该列出来。
  if (options.remote !== false) refreshRemote({ silent: true });
}

/**
 * 读账号下的仓库并归类。
 *
 * silent 用于后台刷新（失败就安静地不显示，别打断用户）；
 * 手动点「扫描 GitHub」时把错误摆出来，否则用户不知道是没仓库还是没连上。
 */
async function refreshRemote({ silent = false } = {}) {
  if (!state.bootstrap?.hasToken || state.remoteBusy) {
    renderRepoView();
    return;
  }

  state.remoteBusy = true;
  state.remoteError = '';
  renderRepoScanState();

  const result = await window.api.discoverRepos();
  state.remoteBusy = false;

  if (!result.ok) {
    state.remoteError = result.error ?? '读取失败';
    state.remote = null;
    renderRepoView();
    if (!silent) toast(state.remoteError, 'bad');
    return;
  }

  state.remote = result;

  // 后台会把「GitHub 上已标识的仓库」自动登记进本机配置。
  // 这里必须重新读一次本机仓库列表，否则界面还显示旧的（0 个）。
  if (Array.isArray(result.adopted) && result.adopted.length > 0) {
    await refreshRepos({ remote: false });
    await refreshSources();
    syncTargetSelect();
    if (!silent) {
      const names = result.adopted.map((r) => r.name).join('、');
      toast(`已自动接入 ${result.adopted.length} 个仓库：${names}`, 'ok');
      renderRepoView();
      return;
    }
  }

  renderRepoView();

  if (!silent) {
    const joinable = Object.values(result.counts ?? {}).reduce((sum, item) => sum + item.joinable, 0);
    const unknownCount = (result.unknown ?? []).filter((repo) => !repo.registered).length;
    const bits = [];
    if (joinable > 0) bits.push(`${joinable} 个还没加入本机`);
    if (unknownCount > 0) bits.push(`${unknownCount} 个认不出归属`);
    toast(
      bits.length > 0
        ? `在 GitHub 上找到 ${bits.join('、')}`
        : `账号下 ${result.total} 个仓库，没有新的同步仓库`,
      'ok',
    );
  }
}

/** 扫描按钮旁边的状态文字。 */
function renderRepoScanState() {
  const node = $('scan-remote');
  if (!node) return;
  if (!state.bootstrap?.hasToken) {
    node.textContent = '扫描 GitHub';
    node.disabled = true;
    node.title = '先在「账号」页连接 GitHub';
    return;
  }
  node.disabled = state.remoteBusy;
  node.textContent = state.remoteBusy ? '刷新中…' : '刷新';
  node.title = '重新读取 GitHub 上的仓库（每次进入这个页面也会自动刷新）';
}

/** 页面右上角的小状态：让用户知道数据是什么时候拿的。 */
function renderRepoFreshness() {
  const node = $('repo-freshness');
  if (!node) return;
  if (state.remoteError) {
    node.textContent = `刷新失败：${state.remoteError}`;
    node.className = 'card-status bad';
    return;
  }
  if (state.remoteBusy) {
    node.textContent = '刷新中…';
    node.className = 'card-status';
    return;
  }
  const at = state.remote?.fetchedAt;
  if (!at) {
    node.textContent = '';
    node.className = 'card-status';
    return;
  }
  const d = new Date(at);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  node.textContent = `已刷新 ${clock}`;
  node.className = 'card-status ok';
}

/** 仓库页的软件标签页，和同步页保持一致的顺序。 */
function renderRepoTabs() {
  const tabs = $('repo-tabs');
  tabs.innerHTML = '';
  const installed = state.sources.filter((s) => s.installed);
  if (installed.length === 0) {
    state.activeRepoSource = '';
    return;
  }
  // 认领完最后一个未识别仓库后，别把用户留在空标签页上
  if (state.activeRepoSource === UNKNOWN_TAB && (state.remote?.unknown ?? []).length === 0 && installed.length > 0) {
    state.activeRepoSource = installed[0].id;
  }
  if (!installed.some((s) => s.id === state.activeRepoSource) && state.activeRepoSource !== UNKNOWN_TAB) {
    state.activeRepoSource = installed[0].id;
  }

  for (const source of installed) {
    const count = state.repos.filter((repo) => repo.source === source.id).length;
    const tab = el('button', 'tab' + (source.id === state.activeRepoSource ? ' active' : ''));

    const remoteInfo = state.remote?.counts?.[source.id];
    tab.appendChild(el('span', 'tab-icon', source.icon ?? '▣'));
    tab.appendChild(el('span', 'tab-label', source.label));
    tab.appendChild(el('span', 'tab-count', `${count}`));

    // 本机没有、但 GitHub 上有的：标签上给个提醒，别让人停在空白页上
    if (remoteInfo && remoteInfo.joinable > 0) {
      const dot = el('span', 'tab-dot warn');
      dot.title = `GitHub 上还有 ${remoteInfo.joinable} 个没加入本机`;
      tab.appendChild(dot);
    }

    tab.addEventListener('click', () => {
      state.activeRepoSource = source.id;
      renderRepoView();
    });
    tabs.appendChild(tab);
  }

  // 账号里认不出归属的仓库：给一个独立标签页，
  // 否则它们会永远消失在界面上——而这正是「网页端建的仓库识别不到」的那种情况。
  const unknown = state.remote?.unknown ?? [];
  if (unknown.length > 0) {
    const unregistered = unknown.filter((repo) => !repo.registered).length;
    const tab = el('button', 'tab unknown' + (state.activeRepoSource === UNKNOWN_TAB ? ' active' : ''));
    tab.appendChild(el('span', 'tab-icon', '?'));
    tab.appendChild(el('span', 'tab-label', '未识别'));
    tab.appendChild(el('span', 'tab-count', `${unknown.length}`));
    if (unregistered > 0) {
      const dot = el('span', 'tab-dot warn');
      dot.title = `${unregistered} 个仓库没有标识，认不出属于哪个软件`;
      tab.appendChild(dot);
    }
    tab.title = '这些仓库里没有标识文件，也没写标签——多半是网页端建的，或者别的工具建的';
    tab.addEventListener('click', () => {
      state.activeRepoSource = UNKNOWN_TAB;
      renderRepoView();
    });
    tabs.appendChild(tab);
  }
}

function activeRepoSource() {
  return state.sources.find((s) => s.id === state.activeRepoSource);
}
function renderRepoView() {
  renderRepoTabs();
  renderRepoList();
  renderRepoFreshness();
}

/** 当前软件在 GitHub 上、本机还没登记的仓库。 */
function joinableFor(sourceId) {
  const list = state.remote?.bySource?.[sourceId] ?? [];
  return list.filter((repo) => !repo.registered);
}
function renderRepoList() {
  const list = $('repo-list');
  list.innerHTML = '';
  renderRepoScanState();

  // 「未识别」是独立标签页：账号里有仓库但认不出归属，全都停在这里等用户指定
  if (state.activeRepoSource === UNKNOWN_TAB) {
    renderUnknownList(list);
    return;
  }

  const source = activeRepoSource();
  if (!source) {
    list.innerHTML = '<div class="empty-state"><h3>还没有可同步的软件</h3><p>到「选项 → 追加软件」里添加</p></div>';
    $('repo-tab-hint').textContent = '';
    return;
  }

  const repos = state.repos.filter((repo) => repo.source === source.id);
  const joinable = joinableFor(source.id);

  const parts = [`${source.label}：${repos.length} 个仓库`];
  if (joinable.length > 0) parts.push(`GitHub 上还有 ${joinable.length} 个未加入`);
  $('repo-tab-hint').textContent = parts.join(' · ');

  if (repos.length === 0 && joinable.length === 0) {
    const empty = el('div', 'empty-state');
    empty.appendChild(el('h3', '', `还没有 ${source.label} 的仓库`));

    if (!state.bootstrap?.hasToken) {
      empty.appendChild(el('p', '', '先到「账号」页连接 GitHub'));
    } else if (state.remoteBusy) {
      empty.appendChild(el('p', '', '正在读取 GitHub 上的仓库…'));
    } else if (state.remoteError) {
      empty.appendChild(el('p', '', `读取 GitHub 失败：${state.remoteError}`));
    } else if (state.remote) {
      empty.appendChild(el('p', '', `账号下没有带 ${source.label} 标识的仓库，点右上角「＋ 给这个软件新建仓库」`));
      // 只有「未识别」里有东西时才提它，否则等于让人白跑一趟
      if ((state.remote.unknown ?? []).length > 0) {
        empty.appendChild(el('p', '', '如果是网页端建的老仓库，到「未识别」标签页里指定它属于这个软件即可。'));
      }
    } else {
      empty.appendChild(el('p', '', '点右上角「＋ 给这个软件新建仓库」'));
    }

    list.appendChild(empty);
    return;
  }

  for (const repo of repos) list.appendChild(renderRepoCard(source, repo));

  // 本机没有、GitHub 上有的：单独一段，点一下就接管
  if (joinable.length > 0) {
    const section = el('div', 'remote-section');
    const head = el('div', 'remote-section-head');
    head.appendChild(el('span', 'remote-section-title', 'GitHub 上已有，本机还没加入'));
    const all = el('button', 'btn ghost xs', `全部加入（${joinable.length}）`);
    all.addEventListener('click', () => adoptAll(source, joinable));
    head.appendChild(all);
    section.appendChild(head);

    for (const repo of joinable) section.appendChild(renderRemoteRepoCard(source, repo));
    list.appendChild(section);
  }
}

/**
 * 「未识别」标签页：账号里认不出归属的仓库。
 *
 * 这些仓库以前是直接被丢掉的——界面上根本看不到，
 * 用户只知道「我 GitHub 上明明有仓库，这里却没有」。
 * 现在把它们列出来，并给出唯一的出路：指定它属于哪个软件。
 * 指定之后会把标识写进仓库，下一台机器就不用再指定了。
 */
function renderUnknownList(list) {
  const unknown = state.remote?.unknown ?? [];
  const unregistered = unknown.filter((repo) => !repo.registered);

  if (unregistered.length === 0) {
    list.innerHTML =
      '<div class="empty-state"><h3>没有未识别的仓库</h3><p>账号下看得见的仓库都认出来了。</p></div>';
    $('repo-tab-hint').textContent = '未识别：0 个';
    return;
  }

  $('repo-tab-hint').textContent = `未识别：${unregistered.length} 个仓库 · 指定归属后会自动写入标识`;

  const hint = el('div', 'unknown-hint');
  hint.appendChild(
    el('div', '', '这些仓库里既没有标识文件，也没有同步标签——多半是在网页端建的，或者用别的工具建的。'),
  );
  hint.appendChild(
    el('div', '', '选一个软件把它认领下来：程序会把标识写进仓库，以后在任何一台机器上都能自动认出来。'),
  );
  list.appendChild(hint);

  for (const repo of unregistered) list.appendChild(renderUnknownCard(repo));
}

function renderUnknownCard(repo) {
  const card = el('div', 'repo-card remote unknown');
  const belongsElsewhere = repo.confidence === 'marker-unknown';

  const main = el('div', 'repo-main');
  const titleRow = el('div', 'repo-title-row');
  titleRow.appendChild(el('span', 'repo-name', repo.manifestName || repo.name));
  titleRow.appendChild(el('span', 'repo-target', repo.fullName));
  titleRow.appendChild(el('span', `pill ${repo.private ? '' : 'public'}`, repo.private ? '私有' : '公开'));

  if (belongsElsewhere) {
    // 仓库自己说了它属于谁，只是那个软件本机没装——别把它和「完全没标识」混为一谈
    const pill = el('span', 'pill warn', `属于 ${repo.manifestSource}`);
    pill.title = `仓库里写着它属于「${repo.manifestSource}」，但本机没有这个软件`;
    titleRow.appendChild(pill);
  } else {
    titleRow.appendChild(el('span', 'pill warn', '未识别'));
  }
  main.appendChild(titleRow);

  if (repo.description) main.appendChild(el('div', 'repo-meta', repo.description));

  if (belongsElsewhere) {
    main.appendChild(
      el('div', 'repo-meta', `仓库标识指向「${repo.manifestSource}」，本机没有这个软件。认领会改掉仓库里的标识。`),
    );
  } else if (repo.identityHint) {
    main.appendChild(el('div', 'repo-meta', repo.identityHint));
  }

  const meta = el('div', 'repo-meta');
  if (repo.lastCommit) {
    const when = new Date(repo.lastCommit);
    if (!Number.isNaN(when.getTime())) {
      meta.appendChild(el('span', '', `更新于 ${when.getFullYear()}/${when.getMonth() + 1}/${when.getDate()}`));
    }
  }
  if (repo.manifestMachine) meta.appendChild(el('span', '', `来自 ${repo.manifestMachine}`));
  if (repo.hasMarker) meta.appendChild(el('span', '', '有标识文件，但指向本机没有的软件'));
  else if (repo.hasManifest) meta.appendChild(el('span', '', '只有旧的 manifest.json'));
  else meta.appendChild(el('span', '', `没有 ${state.remote?.markerFile ?? 'dshwb-sync.json'}`));
  main.appendChild(meta);

  // 让用户直接说「它是谁的」，而不是让他自己回去填地址
  const actions = el('div', 'repo-actions');
  const picker = document.createElement('select');
  picker.className = 'select';
  const placeholder = el('option', '', '当作…的仓库');
  placeholder.value = '';
  picker.appendChild(placeholder);
  for (const source of state.sources.filter((s) => s.installed)) {
    const option = el('option', '', `${source.icon ?? '▣'} ${source.label}`);
    option.value = source.id;
    picker.appendChild(option);
  }

  const claim = el('button', 'btn primary xs', '认领');
  claim.disabled = true;
  picker.addEventListener('change', () => {
    claim.disabled = !picker.value;
  });
  claim.addEventListener('click', () => claimUnknownRepo(repo, picker.value, claim));

  actions.append(picker, claim);
  const open = el('button', 'btn ghost xs', '打开');
  open.addEventListener('click', () => openRepoUrl(repo));
  actions.appendChild(open);

  card.append(main, actions);
  return card;
}

/** 认领：写入标识 + 登记到本机。 */
async function claimUnknownRepo(repo, sourceId, button) {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) return;

  const ok = await askConfirm({
    title: `认领为 ${source.label} 的仓库`,
    message:
      `${repo.fullName}\n\n` +
      (repo.confidence === 'marker-unknown'
        ? `注意：仓库里写着它属于「${repo.manifestSource}」。认领会把标识改成「${source.label}」。\n\n`
        : '') +
      `会把标识写进这个仓库（${state.remote?.markerFile ?? 'dshwb-sync.json'} + 标签 + 描述前缀），` +
      `并登记到本机。之后任何一台机器都能自动认出它。\n\n` +
      `只写标识，不会改动仓库里的其它内容。`,
    okText: '认领',
    danger: repo.confidence === 'marker-unknown',
  });
  if (!ok) return;

  if (button) {
    button.disabled = true;
    button.textContent = '认领中…';
  }

  const result = await window.api.claimRepo({
    owner: repo.owner,
    repoName: repo.name,
    source: source.id,
    name: repo.name,
    branch: repo.defaultBranch,
    private: repo.private,
    description: repo.description,
  });

  if (!result.ok) {
    if (button) {
      button.disabled = false;
      button.textContent = '认领';
    }
    toast(result.error ?? '认领失败', 'bad');
    return;
  }

  if (result.stamp && result.stamp.ok === false) {
    // 登记成功了，但标识没写进去：必须说清楚，否则用户以为「下次就能认出来」了
    toast(`已登记到本机，但标识没写进 GitHub：${result.stamp.error ?? '未知原因'}`, 'bad');
  } else {
    toast(`已认领为 ${source.label} 的仓库，标识已写入`, 'ok');
  }

  await refreshRepos({ remote: false });
  await refreshSources();
  await refreshRemote({ silent: true });
  syncTargetSelect();
}

function markRemoteUnknownRegistered(repo) {
  if (!state.remote) return;
  const hit = (state.remote.unknown ?? []).find((item) => item.fullName === repo.fullName);
  if (hit) hit.registered = true;
}

/** 远端仓库卡片：说明「靠什么认出来的」+ 一键加入。 */function renderRemoteRepoCard(source, repo) {
  const card = el('div', 'repo-card remote');

  const main = el('div', 'repo-main');
  const titleRow = el('div', 'repo-title-row');
  titleRow.appendChild(el('span', 'repo-name', repo.manifestName || repo.name));
  titleRow.appendChild(el('span', 'repo-target', repo.fullName));
  titleRow.appendChild(el('span', `pill ${repo.private ? '' : 'public'}`, repo.private ? '私有' : '公开'));

  // 归属是「认出来的」还是「猜出来的」，必须让用户看得见。
  // 这一版已经不再按名字猜：显示的都是仓库里实打实写着的证据。
  const confidence = {
    local: ['', '本机已登记'],
    marker: ['ok', '标识文件'],
    legacy: ['ok', '旧版标记'],
    topic: ['ok', '标签识别'],
    description: ['ok', '描述识别'],
    'marker-unknown': ['warn', '本机没这个软件'],
  }[repo.confidence];
  if (confidence) titleRow.appendChild(el('span', `pill ${confidence[0]}`, confidence[1]));

  main.appendChild(titleRow);

  if (repo.description) main.appendChild(el('div', 'repo-meta', repo.description));

  const meta = el('div', 'repo-meta');
  if (repo.manifestMachine) meta.appendChild(el('span', '', `来自 ${repo.manifestMachine}`));
  if (repo.lastCommit) {
    const when = new Date(repo.lastCommit);
    if (!Number.isNaN(when.getTime())) {
      meta.appendChild(
        el('span', '', `更新于 ${when.getFullYear()}/${when.getMonth() + 1}/${when.getDate()}`),
      );
    }
  }
  if (repo.hasMarker) meta.appendChild(el('span', '', `含 ${state.remote?.markerFile ?? 'dshwb-sync.json'}`));
  else if (repo.hasManifest) meta.appendChild(el('span', '', '含 manifest.json'));
  main.appendChild(meta);

  const actions = el('div', 'repo-actions');
  const join = el('button', 'btn primary xs', '加入本机');
  join.addEventListener('click', () => adoptRemoteRepo(source, repo, join));
  const open = el('button', 'btn ghost xs', '打开');
  open.addEventListener('click', () => {
    openRepoUrl(repo);
  });
  actions.append(join, open);

  card.append(main, actions);
  return card;
}

/** 一键加入：归属已经认出来了，直接登记，不克隆整个仓库。 */
async function adoptRemoteRepo(source, repo, button) {
  if (button) {
    button.disabled = true;
    button.textContent = '加入中…';
  }

  const result = await window.api.adoptRepo({
    owner: repo.owner,
    repoName: repo.name,
    source: source.id,
    // 显示名优先用仓库自己记着的名字，其次用 GitHub 仓库名：
    // 一个软件下挂多个仓库时，都叫「XX 同步」会分不清是哪个。
    name: repo.manifestName || repo.name,
    branch: repo.defaultBranch,
    private: repo.private,
    description: repo.description,
  });

  if (!result.ok) {
    if (button) {
      button.disabled = false;
      button.textContent = '加入本机';
    }
    toast(result.error ?? '加入失败', 'bad');
    return false;
  }

  // 登记成功 ≠ 标识写成功。后者决定「下一台机器能不能自动认出来」，
  // 所以不能把它和登记一起含糊地报「成功」。
  if (result.stamp && result.stamp.ok === false) {
    toast(`已加入「${result.repo.name}」，但标识没写进 GitHub：${result.stamp.error ?? '未知原因'}`, 'bad');
  } else {
    toast(`已加入「${result.repo.name}」→ ${source.label}`, 'ok');
  }
  markRemoteRegistered(repo);
  await refreshRepos({ remote: false });
  await refreshSources();
  syncTargetSelect();
  return true;
}

/**
 * 刚加入的仓库立刻从「未登记」里划掉。
 *
 * 不重新扫一遍 GitHub：那要再跑一整套请求，而结果我们已经知道了。
 * 只在内存里改状态，下次真正扫描时以线上为准。
 */
function markRemoteRegistered(repo) {
  if (!state.remote) return;
  const list = state.remote.bySource?.[repo.sourceId] ?? [];
  const hit = list.find((item) => item.fullName === repo.fullName);
  if (hit) hit.registered = true;

  const counts = state.remote.counts?.[repo.sourceId];
  if (counts) {
    counts.registered = Math.min(counts.total, counts.registered + 1);
    counts.joinable = Math.max(0, counts.total - counts.registered);
  }
}

async function adoptAll(source, repos) {
  const ok = await askConfirm({
    title: '全部加入本机',
    message: `把 ${source.label} 的 ${repos.length} 个仓库都登记到本机？\n\n只登记归属，第一次同步时才会真正下载内容。`,
    okText: `加入 ${repos.length} 个`,
  });
  if (!ok) return;

  let done = 0;
  for (const repo of repos) {
    const payload = {
      owner: repo.owner,
      repoName: repo.name,
      source: source.id,
      name: repo.manifestName || repo.name,
      branch: repo.defaultBranch,
      private: repo.private,
      description: repo.description,
    };
    const result = await window.api.adoptRepo(payload);
    if (result.ok) {
      done++;
      markRemoteRegistered(repo);
    }
  }

  toast(
    done === repos.length ? `已加入 ${done} 个仓库` : `加入了 ${done} / ${repos.length} 个`,
    done === repos.length ? 'ok' : 'bad',
  );
  await refreshRepos({ remote: false });
  await refreshSources();
  syncTargetSelect();
}

function renderRepoCard(source, repo) {
  const card = el('div', 'repo-card');

  const main = el('div', 'repo-main');
  const titleRow = el('div', 'repo-title-row');
  titleRow.appendChild(el('span', 'repo-name', repo.name));
  titleRow.appendChild(el('span', 'repo-target', `${repo.owner}/${repo.repoName}`));
  titleRow.appendChild(el('span', `pill ${repo.private ? '' : 'public'}`, repo.private ? '私有' : '公开'));

  if (repo.remote?.exists) titleRow.appendChild(el('span', 'pill ok', '已建好'));
  else if (repo.remote === undefined) titleRow.appendChild(el('span', 'pill', '未检查'));
  else if (repo.remote?.error) titleRow.appendChild(el('span', 'pill warn', '远端未确认'));
  else titleRow.appendChild(el('span', 'pill warn', '仓库不存在'));

  if (repo.cloned) titleRow.appendChild(el('span', 'pill ok', '已克隆'));
  main.appendChild(titleRow);

  if (repo.description) main.appendChild(el('div', 'repo-meta', repo.description));

  const meta = el('div', 'repo-meta');
  meta.appendChild(el('span', '', `分支 ${repo.branch}`));
  meta.appendChild(el('span', '', `本地 ${formatBytes(repo.sizeOnDisk)}`));
  if (repo.lastSyncAt) {
    const when = new Date(repo.lastSyncAt);
    meta.appendChild(
      el('span', '', `上次同步 ${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`),
    );
  }
  main.appendChild(meta);

  const actions = el('div', 'repo-actions');
  const browse = el('button', 'btn ghost xs', '远端内容');
  browse.addEventListener('click', () => openBrowser(repo));
  const edit = el('button', 'btn ghost xs', '编辑');
  edit.addEventListener('click', () => openRepoModal(source, repo));
  const open = el('button', 'btn ghost xs', '打开');
  open.addEventListener('click', () => openRepoUrl(repo));
  const remove = el('button', 'btn ghost xs', '移除');
  remove.addEventListener('click', () => removeRepo(repo));
  actions.append(browse, edit, open, remove);

  card.append(main, actions);
  return card;
}

$('add-repo-tab').addEventListener('click', () => {
  const source = activeRepoSource();
  if (!source) {
    toast('没有可同步的软件', 'bad');
    return;
  }
  openRepoModal(source, null);
});

/** 「加入已有仓库」：换机时接手一个已经存在的仓库。 */
$('adopt-repo').addEventListener('click', () => openAdoptModal());

/** 手动重扫 GitHub：后台那次是静默的，这里要能把结果/错误明确摆出来。 */
$('scan-remote').addEventListener('click', async () => {
  if (!state.bootstrap?.hasToken) {
    toast('先在「账号」页连接 GitHub', 'bad');
    showView('account');
    return;
  }
  state.remote = null;
  await refreshRemote({ silent: false });
});

/**
 * 给本机已登记的仓库补写标识。
 *
 * 主要给「以前用旧版本建的仓库」用：旧版本只写了 topics + 描述，
 * 标识文件是新加的。补一次以后，换机器、重装都能直接认出来。
 */
$('stamp-all').addEventListener('click', async () => {
  if (!state.bootstrap?.hasToken) {
    toast('先在「账号」页连接 GitHub', 'bad');
    showView('account');
    return;
  }
  if (state.repos.length === 0) {
    toast('本机还没有登记仓库，没有要补的', 'bad');
    return;
  }

  const ok = await askConfirm({
    title: '补写标识',
    message:
      `给本机已登记的 ${state.repos.length} 个仓库补写标识？\n\n` +
      `每个仓库会写一次 ${state.remote?.markerFile ?? 'dshwb-sync.json'}、追加标签、` +
      `并在描述前加软件前缀。已有标识的会跳过。`,
    okText: '开始',
  });
  if (!ok) return;

  const button = $('stamp-all');
  button.disabled = true;
  button.textContent = '补写中…';

  const result = await window.api.stampAllRepos();
  button.disabled = false;
  button.textContent = '补写标识';

  if (!result.ok) {
    toast(result.error ?? '补写失败', 'bad');
    return;
  }

  const stamped = result.stamped ?? 0;
  const failed = result.failed ?? 0;
  if (failed > 0) {
    const first = (result.results ?? []).find((item) => !item.ok);
    toast(`补写了 ${stamped} 个，${failed} 个失败：${first?.error ?? '未知原因'}`, 'bad');
  } else if (stamped === 0) {
    toast('所有仓库都已经有标识了', 'ok');
  } else {
    toast(`已给 ${stamped} 个仓库补写标识`, 'ok');
  }

  await refreshRepos({ remote: false });
  await refreshRemote({ silent: true });
});

function openAdoptModal() {
  const modal = $('modal');
  const body = $('modal-body');
  modal.hidden = false;
  body.innerHTML = '';
  setHint('modal-hint', '');

  $('modal-title').textContent = '加入已有仓库';
  $('modal-subtitle').textContent = '另一台机器建过的仓库，这里填地址就能接管，不用重建。';
  $('modal-save').textContent = '加入';

  const ownerField = el('div', 'field');
  ownerField.appendChild(el('label', '', 'GitHub 所有者'));
  const ownerInput = document.createElement('input');
  ownerInput.type = 'text';
  ownerInput.value = state.config?.github?.login ?? '';
  ownerField.appendChild(ownerInput);
  body.appendChild(ownerField);

  const repoField = el('div', 'field');
  repoField.appendChild(el('label', '', '仓库名'));
  const repoInput = document.createElement('input');
  repoInput.type = 'text';
  repoInput.placeholder = 'dsh-private-sync';
  repoField.appendChild(repoInput);
  repoField.appendChild(el('div', 'hint', '程序会读取仓库里的标识文件，自动认出它属于哪个软件'));
  body.appendChild(repoField);

  // 列出账号下还没登记的仓库，点一下直接填
  const listField = el('div', 'field');
  listField.appendChild(el('label', '', '或者从账号下的仓库里选'));
  const listBox = el('div', 'adopt-list');
  listBox.innerHTML = '<div class="loading">正在读取…</div>';
  listField.appendChild(listBox);
  body.appendChild(listField);

  window.api.availableRepos().then((result) => {
    listBox.innerHTML = '';
    if (!result.ok) {
      listBox.innerHTML = `<div class="empty-state">${escapeHtml(result.error ?? '读取失败')}</div>`;
      return;
    }
    const registered = new Set(state.repos.map((repo) => `${repo.owner}/${repo.repoName}`));
    const candidates = result.repos.filter((repo) => !registered.has(repo.fullName));
    if (candidates.length === 0) {
      listBox.innerHTML = '<div class="empty-state">账号下的仓库都已经登记过了</div>';
      return;
    }
    for (const repo of candidates) {
      const row = el('div', 'adopt-row');
      row.appendChild(el('span', 'repo-target', repo.fullName));
      row.appendChild(el('span', `pill ${repo.private ? '' : 'public'}`, repo.private ? '私有' : '公开'));
      if (repo.description) row.appendChild(el('span', 'muted sm', repo.description.slice(0, 40)));
      row.addEventListener('click', () => {
        ownerInput.value = repo.owner;
        repoInput.value = repo.name;
      });
      listBox.appendChild(row);
    }
  });

  state.modal = { adopt: true };
}

async function saveAdoptModal() {
  const body = $('modal-body');
  const inputs = body.querySelectorAll('input[type="text"]');
  const owner = inputs[0].value.trim();
  const repoName = inputs[1].value.trim();
  if (!owner || !repoName) {
    setHint('modal-hint', '所有者和仓库名都要填', 'bad');
    return;
  }

  setHint('modal-hint', '正在读取仓库标识…');
  const result = await window.api.adoptRepo({ owner, repoName });
  if (!result.ok) {
    setHint('modal-hint', result.error ?? '加入失败', 'bad');
    // 认不出归属：给一条明确的出路，而不是让用户反复试同一个地址
    if (result.undetermined) {
      closeModal();
      state.activeRepoSource = UNKNOWN_TAB;
      showView('repos');
      await refreshRemote({ silent: true });
      toast('这个仓库没有标识，已放到「未识别」里，指定归属即可', 'bad');
    }
    return;
  }

  toast(
    result.stamp && result.stamp.ok === false
      ? `已加入「${result.repo.name}」，但标识没写进 GitHub：${result.stamp.error ?? '未知原因'}`
      : `已加入「${result.repo.name}」，归属：${result.sourceLabel}`,
    result.stamp && result.stamp.ok === false ? 'bad' : 'ok',
  );
  closeModal();
  await refreshRepos();
  await refreshSources();
  syncTargetSelect();
}

// ───────────────────────────────── 仓库弹窗

function openRepoModal(source, repo) {
  const modal = $('modal');
  const body = $('modal-body');
  modal.hidden = false;
  body.innerHTML = '';
  setHint('modal-hint', '');

  $('modal-title').textContent = repo ? `编辑「${repo.name}」` : `为 ${source.label} 建仓库`;
  $('modal-subtitle').textContent = repo
    ? '改动会同步到 GitHub 上。'
    : `这个仓库只收 ${source.label} 的内容。`;

  state.modal = { source, repo };

  // 显示名 + 仓库名
  const grid = el('div', 'grid-2');

  const nameField = el('div', 'field');
  nameField.appendChild(el('label', '', '显示名'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = repo?.name ?? `${source.label} 同步`;
  nameInput.placeholder = `${source.label} 同步`;
  nameField.appendChild(nameInput);
  nameField.appendChild(el('div', 'hint', '只在你自己的界面里显示'));
  grid.appendChild(nameField);

  const repoField = el('div', 'field');
  repoField.appendChild(el('label', '', 'GitHub 仓库名'));
  const repoInput = document.createElement('input');
  repoInput.type = 'text';
  repoInput.value = repo?.repoName ?? `${source.id}-sync`;
  repoInput.placeholder = `${source.id}-sync`;
  repoField.appendChild(repoInput);
  repoField.appendChild(el('div', 'hint', '对方看到的仓库名'));
  grid.appendChild(repoField);
  body.appendChild(grid);

  // 可见性
  const visField = el('div', 'field');
  visField.appendChild(el('label', '', '可见性'));
  const seg = el('div', 'segmented');
  const initial = repo ? (repo.private ? 'private' : 'public') : 'private';
  for (const [value, title, sub] of [
    ['private', '私有', '只有你能看'],
    ['public', '公开', '可分享给别人'],
  ]) {
    const button = el('button', 'seg' + (value === initial ? ' active' : ''));
    button.dataset.value = value;
    button.appendChild(el('span', 'seg-title', title));
    button.appendChild(el('span', 'seg-sub', sub));
    button.addEventListener('click', () => {
      for (const other of seg.querySelectorAll('.seg')) other.classList.remove('active');
      button.classList.add('active');
    });
    seg.appendChild(button);
  }
  visField.appendChild(seg);
  body.appendChild(visField);

  // 描述
  const descField = el('div', 'field');
  descField.appendChild(el('label', '', '描述'));
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.value = repo?.description ?? '';
  descInput.placeholder = `${source.label} 跨电脑同步`;
  descField.appendChild(descInput);
  descField.appendChild(el('div', 'hint', '显示在 GitHub 上，自动加软件标识'));
  body.appendChild(descField);

  // 更多属性
  const advanced = el('details', 'advanced');
  advanced.appendChild(el('summary', '', '更多属性（.gitignore、许可证、主页、议题 / 维基 / 项目）'));
  const advBody = el('div', 'advanced-body');

  const advGrid = el('div', 'grid-2');

  const giField = el('div', 'field');
  giField.appendChild(el('label', '', '.gitignore 模板'));
  const giSelect = el('select', 'select wide');
  for (const name of state.bootstrap.gitignoreTemplates ?? []) {
    const option = el('option', '', name || '（不生成）');
    option.value = name;
    giSelect.appendChild(option);
  }
  giSelect.value = repo?.gitignoreTemplate ?? '';
  giField.appendChild(giSelect);
  giField.appendChild(el('div', 'hint', repo ? '仅建仓时生效' : '由 GitHub 生成'));
  advGrid.appendChild(giField);

  const licField = el('div', 'field');
  licField.appendChild(el('label', '', '许可证'));
  const licSelect = el('select', 'select wide');
  for (const key of state.bootstrap.licenseKeys ?? []) {
    const option = el('option', '', key || '（不添加）');
    option.value = key;
    licSelect.appendChild(option);
  }
  licSelect.value = repo?.licenseTemplate ?? '';
  licField.appendChild(licSelect);
  licField.appendChild(el('div', 'hint', repo ? '仅建仓时生效' : '公开仓库建议选一个'));
  advGrid.appendChild(licField);

  advBody.appendChild(advGrid);

  const homeField = el('div', 'field');
  homeField.appendChild(el('label', '', '主页网址'));
  const homeInput = document.createElement('input');
  homeInput.type = 'text';
  homeInput.value = repo?.homepage ?? '';
  homeInput.placeholder = 'https://（可留空）';
  homeField.appendChild(homeInput);
  advBody.appendChild(homeField);

  const toggleField = el('div', 'field');
  toggleField.appendChild(el('label', '', '附加功能'));
  const toggles = el('div', 'toggles');
  const toggleInputs = {};
  for (const [key, label] of [
    ['hasIssues', '议题 Issues'],
    ['hasWiki', '维基 Wiki'],
    ['hasProjects', '项目 Projects'],
  ]) {
    const wrap = el('label', 'toggle');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(repo?.[key]);
    toggleInputs[key] = input;
    wrap.append(input, el('span', '', label));
    toggles.appendChild(wrap);
  }
  toggleField.appendChild(toggles);
  advBody.appendChild(toggleField);

  advanced.appendChild(advBody);
  body.appendChild(advanced);

  // 标识（仅编辑时显示）
  if (repo) {
    const idField = el('div', 'field');
    idField.appendChild(el('label', '', 'GitHub 上的标识'));
    const idRow = el('div', 'row');
    idRow.appendChild(el('span', 'source-chip', `[${source.label}]`));
    idRow.appendChild(el('span', 'source-chip', `dshwb-${source.id}`));
    idRow.appendChild(el('span', 'source-chip', state.remote?.markerFile ?? 'dshwb-sync.json'));
    const fix = el('button', 'btn ghost xs', '重新写入');
    fix.title = '写一次标识文件 + 标签 + 描述前缀；别的机器靠它认出这个仓库';
    fix.addEventListener('click', async () => {
      fix.disabled = true;
      const result = await window.api.claimRepo({
        owner: repo.owner,
        repoName: repo.repoName,
        source: source.id,
        name: repo.name,
        branch: repo.branch,
        private: repo.private,
      });
      fix.disabled = false;
      setHint(
        'modal-hint',
        result.ok
          ? '标识已写入 GitHub（标识文件 + 标签 + 描述）'
          : (result.error ?? '写入失败'),
        result.ok ? 'ok' : 'bad',
      );
      if (result.ok) await refreshRemote({ silent: true });
    });
    idRow.appendChild(fix);
    idField.appendChild(idRow);
    idField.appendChild(
      el('div', 'hint', '标识写在仓库里，不在本机配置里——所以换一台机器、重装之后也能认出来。'),
    );
    body.appendChild(idField);
  }

  $('modal-save').textContent = repo ? '保存' : '创建仓库';
}

/** 弹窗保存。 */
async function saveRepoModal() {
  if (state.modal?.adopt) return saveAdoptModal();

  const { source, repo } = state.modal ?? {};
  if (!source) return;

  const modal = $('modal');
  const inputs = modal.querySelectorAll('input[type="text"], select');
  const nameInput = inputs[0];
  const repoInput = inputs[1];
  const descInput = modal.querySelectorAll('input[type="text"]')[2];
  const gitignoreSelect = modal.querySelectorAll('select')[0];
  const licenseSelect = modal.querySelectorAll('select')[1];
  const homepageInput = modal.querySelector('[placeholder*="https"]');
  const seg = modal.querySelector('.seg.active');
  const isPublic = seg?.dataset.value === 'public';
  const toggles = modal.querySelectorAll('.toggle input');

  const name = nameInput.value.trim();
  const repoName = repoInput.value.trim();
  if (!name || !repoName) {
    setHint('modal-hint', '显示名和仓库名都要填', 'bad');
    return;
  }

  setHint('modal-hint', '正在保存…');

  if (repo) {
    const local = await window.api.updateRepo({
      id: repo.id,
      patch: {
        name,
        repoName,
        private: !isPublic,
        description: descInput?.value.trim() ?? '',
        homepage: homepageInput?.value.trim() ?? '',
        hasIssues: toggles[0]?.checked,
        hasWiki: toggles[1]?.checked,
        hasProjects: toggles[2]?.checked,
      },
    });
    if (!local.ok) {
      setHint('modal-hint', local.error ?? '保存失败', 'bad');
      return;
    }

    const remote = await window.api.updateRemoteRepo({
      owner: repo.owner,
      repoName: repo.repoName,
      patch: {
        private: !isPublic,
        description: descInput?.value.trim(),
        homepage: homepageInput?.value.trim() || undefined,
        hasIssues: toggles[0]?.checked,
        hasWiki: toggles[1]?.checked,
        hasProjects: toggles[2]?.checked,
      },
    });

    if (!remote.ok) {
      setHint('modal-hint', `本地已保存，但 GitHub 那边没改成：${remote.error}`, 'bad');
      await refreshRepos();
      return;
    }
    toast('已保存，GitHub 上的属性也更新了', 'ok');
  } else {
    const result = await window.api.createRemoteRepo({
      name: repoName,
      private: !isPublic,
      description: descInput?.value.trim() ?? '',
      homepage: homepageInput?.value.trim() ?? '',
      gitignoreTemplate: gitignoreSelect?.value ?? '',
      licenseTemplate: licenseSelect?.value ?? '',
      hasIssues: toggles[0]?.checked,
      hasWiki: toggles[1]?.checked,
      hasProjects: toggles[2]?.checked,
      source: source.id,
      sourceLabel: source.label,
      localName: name,
    });
    if (!result.ok) {
      setHint('modal-hint', result.error ?? '创建失败', 'bad');
      return;
    }
    if (result.marker && result.marker.ok === false) {
      // 仓库建好了、标识没写上：换机时就得手动认领。
      // 这句话必须说出来，否则用户以为「软件建的仓库一定能被认出来」。
      toast(`仓库已创建，但标识没写进 GitHub：${result.marker.error ?? '未知原因'}`, 'bad');
    } else {
      toast(`${isPublic ? '公开' : '私有'}仓库已创建，已打上「${source.label}」标识`, 'ok');
    }
  }

  closeModal();
  await refreshRepos();
  await refreshSources();
  syncTargetSelect();
}

function closeModal() {
  $('modal').hidden = true;
  state.modal = null;
}

$('modal-close').addEventListener('click', closeModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-save').addEventListener('click', saveRepoModal);
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});

// ───────────────────────────────── 应用内确认框

/**
 * 替代 window.confirm。
 * 原生 confirm 是浏览器/系统画风，在这个深色界面里非常突兀，
 * 而且中文按钮排版也不受控。
 */
function askConfirm({ title = '确认', message, okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message ?? '';

    const okBtn = $('confirm-ok');
    okBtn.textContent = okText;
    okBtn.className = danger ? 'btn danger' : 'btn primary';

    const cleanup = () => {
      modal.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
    };
    const onOk = () => {
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onBackdrop = (event) => {
      if (event.target === modal) onCancel();
    };

    const cancelBtn = $('confirm-cancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    modal.hidden = false;
  });
}

/**
 * 移除仓库。
 *
 * 仓库卡片上显示的就是 GitHub 上的东西，所以「移除」默认应该把它从云端也删掉，
 * 否则用户会以为删了、实际上云端还在。
 * 但也留一条「只从本机移除」的路：换机时误加的仓库不该顺手删掉别人的数据。
 */
async function removeRepo(repo) {
  const target = `${repo.owner}/${repo.repoName}`;

  const alsoRemote = await askConfirm({
    title: '移除仓库',
    message: `${target}\n\n要连 GitHub 上的仓库一起删掉吗？\n删掉后本机和云端都没有了，无法恢复。`,
    okText: '两端都删',
    danger: true,
  });

  if (alsoRemote) {
    const result = await window.api.deleteRemoteRepo({ owner: repo.owner, repoName: repo.repoName });
    if (!result.ok) {
      // 云端删不掉（比如令牌没 delete_repo 权限），就不要假装成功
      const localOnly = await askConfirm({
        title: '云端删除失败',
        message: `${result.error ?? '未知错误'}\n\n要只从本机移除吗？GitHub 上的仓库会保留。`,
        okText: '只移除本机',
        danger: false,
      });
      if (!localOnly) return;
      await window.api.removeRepo({ id: repo.id, deleteCache: true });
      await afterRepoRemoved(false);
      toast('已从本机移除，GitHub 上的仓库保留', 'bad');
      return;
    }

    await window.api.removeRepo({ id: repo.id, deleteCache: true });
    await afterRepoRemoved(true);
    toast(
      result.alreadyGone
        ? 'GitHub 上已经没有这个仓库了，已从本机移除'
        : '已删除，本机和 GitHub 上都没有了',
      'ok',
    );
    return;
  }

  // 再问一次：确认只移除本机
  const localOnly = await askConfirm({
    title: '只从本机移除？',
    message: `${target}\n\nGitHub 上的仓库会保留，之后可以用「加入已有仓库」重新接回来。`,
    okText: '只移除本机',
    danger: false,
  });
  if (!localOnly) return;

  await window.api.removeRepo({ id: repo.id, deleteCache: true });
  await afterRepoRemoved(false);
  toast('已从本机移除，GitHub 上的仓库保留');
}

/**
 * 仓库被移除之后的刷新。
 *
 * 关键点：这里**不能**重新扫描 GitHub 并自动登记。
 * 因为 repos:discover 现在会自动把「GitHub 上已标识的仓库」收进本机，
 * 如果删除后立刻重扫，云端还在的仓库会马上又被加回来，
 * 用户看到的就是「删了还在」。
 *
 * 所以：
 *   · 云端已删 → 把远端扫描结果整个作废，下次进页面重新拉
 *   · 只删本机 → 只刷新本机列表，不动远端结果（那条还在「GitHub 上已有」里，可以再加回来）
 */
async function afterRepoRemoved(alsoDeletedRemote) {
  if (alsoDeletedRemote) {
    // 远端已经没有了，缓存的扫描结果必须作废，否则卡片还挂着
    state.remote = null;
  }
  await refreshRepos({ remote: false });
  await refreshSources();
  syncTargetSelect();
  renderRepoView();
}

// ───────────────────────────────── 远端内容（独立页面）

/**
 * 打开远端内容页。
 *
 * 之前每次切回来都重新拉一遍，网络一动就得等；现在改成
 * 「有缓存就先渲染，再后台刷新」——切页面几乎瞬间出内容。
 */
/**
 * 打开远端内容页。
 *
 * 每次都重新拉，不看缓存——这个页面反映的是「GitHub 上现在是什么」，
 * 上传或删除之后还显示上一份快照，用户会以为操作没生效。
 * 先渲染缓存再后台刷新也不行：旧数据会先闪一下，看起来像「删了还在」。
 */
async function openBrowser(repo) {
  state.browsing = { repoId: repo.id, repo, data: null };
  state.browseCache?.delete(repo.id);
  $('diff-panel').hidden = true;
  $('browser-title').textContent = `远端内容 · ${repo.name}`;
  $('browser-subtitle').textContent = `${repo.owner}/${repo.repoName} · 按软件自己的层级展示`;
  showView('browser');
  // 每次进入都重新拉：删除/上传之后，缓存里的旧内容会骗人
  await loadBrowser($('browser-search').value || '');
}


async function loadBrowser(query, options = {}) {
  if (!state.browsing) return;
  if (!options.silent) {
    setStatus('browser-status', '读取中…', '');
    $('remote-tree').innerHTML = '<div class="loading">正在读取 GitHub 上的内容…</div>';
    $('browser-stats').textContent = '';
  }

  const result = await window.api.browseList({ repoId: state.browsing.repoId, query });
  if (!result.ok) {
    setStatus('browser-status', '刷新失败，下面的内容可能已过期', 'bad');
    // 静默刷新失败时清掉旧内容——留着会让人以为「删了还在」
    if (!options.silent) {
      $('remote-tree').innerHTML = `<div class="empty-state">${escapeHtml(result.error ?? '读取失败')}</div>`;
    } else {
      $('remote-tree').innerHTML = `<div class="empty-state">刷新失败：${escapeHtml(result.error ?? '未知错误')}<br><br>点「刷新」重试</div>`;
      $('browser-stats').textContent = '';
      state.browsing.data = null;
      state.browseCache?.delete(state.browsing.repoId);
    }
    toast(result.error ?? '刷新失败', 'bad');
    return;
  }

  state.browsing.data = result;
  state.browseCache ??= new Map();
  state.browseCache.set(state.browsing.repoId, result);
  renderBrowsed(result);

  if (result.empty) {
    setStatus('browser-status', '仓库里没有内容', '');
  } else {
    setStatus('browser-status', `${result.containers.length} 个分组`, 'ok');
  }
}

function renderBrowsed(result) {
  let same = 0;
  let differs = 0;
  let remoteOnly = 0;
  let unmapped = 0;
  for (const container of result.containers) {
    for (const item of container.items) {
      if (item.state === 'same') same++;
      else if (item.state === 'differs') differs++;
      else if (item.state === 'unmapped') unmapped++;
      else remoteOnly++;
    }
  }
  $('browser-stats').innerHTML =
    `<span class="stat ok">一致 ${same}</span>` +
    `<span class="stat warn">有差异 ${differs}</span>` +
    `<span class="stat">仅远端 ${remoteOnly}</span>` +
    (unmapped > 0 ? `<span class="stat">路径未映射 ${unmapped}</span>` : '');

  renderRemoteTree(result);
}

function renderRemoteTree(result) {
  const container = $('remote-tree');
  container.innerHTML = '';

  if (!result.containers || result.containers.length === 0) {
    container.innerHTML = '<div class="empty-state">仓库里还没有内容，先上传一次</div>';
    return;
  }

  const tier = result.tier ?? { containerLabel: '分组', itemLabel: '条目' };

  for (const group of result.containers) {
    const card = el('div', 'remote-container' + (group.global ? ' global' : ''));
    const head = el('div', 'remote-container-head');
    head.appendChild(el('div', 'container-icon', group.global ? '⚙' : '▣'));

    const info = el('div', 'container-info');
    const titleRow = el('div', 'container-title-row');
    titleRow.appendChild(el('span', 'remote-container-title', group.label));
    titleRow.appendChild(el('span', 'container-kind', group.global ? '全局' : tier.containerLabel));
    info.appendChild(titleRow);
    info.appendChild(el('div', 'container-detail', group.detail ?? ''));

    const stats = el('div', 'container-stats');
    stats.appendChild(el('div', '', `${group.items.length} 个${tier.itemLabel}`));

    // 整组删除
    const delGroup = el('button', 'btn ghost xs', '删除整组');
    delGroup.title = '把这一组下的所有对话从远端删除';
    delGroup.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteRemoteGroup(group);
    });

    head.append(info, stats, delGroup, el('span', 'container-toggle', '▾'));
    card.appendChild(head);

    const body = el('div', 'container-body');
    for (const item of group.items) {
      body.appendChild(renderRemoteItem(item));
    }
    card.appendChild(body);
    card.classList.add('open');

    head.addEventListener('click', (event) => {
      if (event.target === delGroup) return;
      card.classList.toggle('open');
    });
    container.appendChild(card);
  }
}

function renderRemoteItem(item) {
  const row = el('div', 'remote-item');

  const badge = el('span', `state-badge ${item.state}`);
  badge.textContent =
    item.state === 'same'
      ? '一致'
      : item.state === 'differs'
        ? '差异'
        : item.state === 'unmapped'
          ? '路径未映射'
          : '仅远端';
  if (item.state === 'unmapped') badge.title = '检查「选项 → 目录」里的工作区根目录';
  row.appendChild(badge);

  const main = el('div', 'item-main');
  main.appendChild(el('div', 'item-label', item.label));
  const detail = el('div', 'item-detail');
  if (item.state === 'same') detail.textContent = '内容与本地相同';
  else if (item.state === 'unmapped') detail.textContent = '仓库里记录的工作目录在本机没有对应位置';
  else if (item.localExists) detail.textContent = `远端 ${formatBytes(item.size)} · 本地 ${formatBytes(item.localSize ?? 0)}`;
  else detail.textContent = `远端 ${formatBytes(item.size)} · 本机没有`;
  main.appendChild(detail);
  row.appendChild(main);

  const compare = el('button', 'btn ghost xs', '对比');
  compare.addEventListener('click', (event) => {
    event.stopPropagation();
    openDiff(item.path);
  });

  const del = el('button', 'btn ghost xs danger-text', '删除');
  del.title = '从远端删除这一条';
  del.addEventListener('click', async (event) => {
    event.stopPropagation();
    await deleteRemoteItem(item.path, item.label);
  });

  row.append(compare, del);
  row.addEventListener('click', () => openDiff(item.path));
  return row;
}

/** 删除单条远端记录。 */
async function deleteRemoteItem(relPath, label) {
  if (!state.browsing) return;
  const ok = await askConfirm({
    title: '从 GitHub 删除',
    message: `「${label}」\n\n会提交一次删除，本地文件不受影响。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;

  const result = await window.api.browseDeleteRemote({ repoId: state.browsing.repoId, relPath });
  if (!result.ok) {
    toast(result.error ?? '删除失败', 'bad');
    return;
  }
  toast('已从远端删除', 'ok');
  await loadBrowser($('browser-search').value, { silent: true });
}

/** 删除整组（一个工作区/项目下的全部对话）。 */
async function deleteRemoteGroup(group) {
  if (!state.browsing) return;

  // 直接展开到文件：普通条目是 item.path，聚合条目（配置/技能）是 item.multi
  const paths = [];
  for (const item of group.items) {
    if (Array.isArray(item.multi) && item.multi.length > 0) paths.push(...item.multi);
    else if (item.path) paths.push(item.path);
  }

  if (paths.length === 0) {
    // 真正为空才提示；同时把可能有用的线索说清楚，别让用户对着空白猜
    const hint =
      group.items.length === 0
        ? '这一组在远端没有文件'
        : '这一组里的条目没有可删除的远端文件（可能是聚合显示）';
    toast(hint, 'bad');
    return;
  }

  const ok = await askConfirm({
    title: '删除整组',
    message: `「${group.label}」下的 ${paths.length} 个文件\n\n会逐条提交，本地文件不受影响。`,
    okText: `删除 ${paths.length} 个`,
    danger: true,
  });
  if (!ok) return;

  let done = 0;
  // 一次调用删完再提交一次，不要逐条往返
  const result = await window.api.browseDeleteRemote({
    repoId: state.browsing.repoId,
    relPaths: paths,
  });

  if (result.ok) {
    done = result.removed ?? paths.length;
    toast(`已删除 ${done} 个文件`, 'ok');
  } else {
    toast(result.error ?? '删除失败', 'bad');
  }
  await loadBrowser($('browser-search').value, { silent: true });
}

$('browser-back').addEventListener('click', () => {
  $('diff-panel').hidden = true;
  state.browsing = null;
  state.lastInRepoSection = 'repos';
  showView('repos');
});

$('browser-reload').addEventListener('click', () => loadBrowser($('browser-search').value));

let searchTimer;
$('browser-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => loadBrowser(value), 400);
});

// ───────────────────────────────── 对比

async function openDiff(relPath) {
  if (!state.browsing) return;
  const panel = $('diff-panel');
  panel.hidden = false;
  $('diff-title').textContent = relPath.split('/').pop();
  $('diff-subtitle').textContent = relPath;
  setStatus('diff-status', '对比中…', '');
  $('diff-view').innerHTML = '<div class="loading">正在对比…</div>';
  $('diff-nav').innerHTML = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const result = await window.api.browseCompare({ repoId: state.browsing.repoId, relPath });
  if (!result.ok) {
    setStatus('diff-status', '失败', 'bad');
    $('diff-view').innerHTML = `<div class="empty-state">${escapeHtml(result.error ?? '对比失败')}</div>`;
    return;
  }

  state.diff = { relPath, result };

  if (result.same) setStatus('diff-status', '完全一致', 'ok');
  else if (!result.localExists) setStatus('diff-status', '本机没有', 'warn');
  else setStatus('diff-status', '有差异', 'warn');

  $('diff-take-remote').disabled = result.same;
  $('diff-push-local').disabled = result.same || !result.localExists || !result.localPath;

  renderDiff(result);
}

function renderDiff(result) {
  const view = $('diff-view');
  view.innerHTML = '';

  if (result.binary) {
    const box = el('div', 'diff-binary');
    box.appendChild(el('div', '', '这是二进制文件（会话日志、数据库等），只比较大小和指纹。'));
    box.appendChild(el('div', 'muted sm', `远端 ${formatBytes(result.remoteSize)} · 本机 ${result.localExists ? formatBytes(result.localSize) : '不存在'}`));
    box.appendChild(el('div', 'muted sm', `远端指纹 ${result.remoteHash.slice(0, 16)}…`));
    if (result.localHash) box.appendChild(el('div', 'muted sm', `本机指纹 ${result.localHash.slice(0, 16)}…`));
    view.appendChild(box);
    return;
  }

  if (!result.localPath) {
    view.innerHTML = '<div class="empty-state">这个文件在本机没有对应位置，只能查看远端内容。</div>';
    const pre = el('pre', 'diff-code');
    pre.textContent = result.remoteText ?? '';
    view.appendChild(pre);
    return;
  }

  const added = result.hunks.filter((h) => h.type === 'add').length;
  const removed = result.hunks.filter((h) => h.type === 'del').length;
  $('diff-nav').innerHTML = `<span class="stat ok">+${added}</span><span class="stat bad">−${removed}</span>`;

  const table = el('div', 'diff-table');
  for (const hunk of result.hunks) {
    if (hunk.type === 'skip') {
      table.appendChild(el('div', 'diff-row skip', `… 省略 ${hunk.count} 行 …`));
      continue;
    }
    const row = el('div', `diff-row ${hunk.type}`);
    row.appendChild(el('div', 'diff-line', hunk.leftLine ? String(hunk.leftLine) : ''));
    row.appendChild(el('div', 'diff-line', hunk.rightLine ? String(hunk.rightLine) : ''));
    const text = el('div', 'diff-text');
    if (hunk.type === 'same') text.textContent = hunk.left ?? '';
    else if (hunk.type === 'del') text.textContent = '− ' + (hunk.left ?? '');
    else text.textContent = '+ ' + (hunk.right ?? '');
    row.appendChild(text);
    table.appendChild(row);
  }
  view.appendChild(table);
}

$('diff-close').addEventListener('click', () => {
  $('diff-panel').hidden = true;
  state.diff = null;
});

$('diff-delete').addEventListener('click', async () => {
  if (!state.diff || !state.browsing) return;
  await deleteRemoteItem(state.diff.relPath, state.diff.relPath.split('/').pop());
  $('diff-panel').hidden = true;
  state.diff = null;
});

$('diff-take-remote').addEventListener('click', async () => {
  if (!state.diff || !state.browsing) return;
  const result = await window.api.browseTakeRemote({ repoId: state.browsing.repoId, relPath: state.diff.relPath });
  if (!result.ok) return toast(result.error ?? '失败', 'bad');
  toast('已用远端版本覆盖本地（原文件已备份）', 'ok');
  await openDiff(state.diff.relPath);
  await loadBrowser($('browser-search').value, { silent: true });
  await refreshSources();
});

$('diff-push-local').addEventListener('click', async () => {
  if (!state.diff || !state.browsing) return;
  const result = await window.api.browsePushLocal({ repoId: state.browsing.repoId, relPath: state.diff.relPath });
  if (!result.ok) return toast(result.error ?? '失败', 'bad');
  toast(result.pushed ? '已推送到远端' : '远端已是最新', 'ok');
  await openDiff(state.diff.relPath);
  await loadBrowser($('browser-search').value, { silent: true });
});



// ───────────────────────────────── 同步

async function runSync(mode) {
  const source = activeSource();
  if (!source) return;
  if (!state.bootstrap.hasToken) {
    toast('先连接 GitHub 账号', 'bad');
    showView('account');
    return;
  }
  if (!state.targetRepo) {
    toast(`先给 ${source.label} 建一个仓库`, 'bad');
    showView('repos');
    return;
  }
  if (state.selected.size === 0) {
    toast('至少选一个工作区', 'bad');
    return;
  }

  state.busy = true;
  updateActions();
  $('busy').hidden = false;
  $('busy-title').textContent = mode === 'upload' ? '正在上传…' : '正在下载…';
  $('busy-bar').style.width = '0%';
  $('busy-bar').classList.add('indeterminate');
  $('busy-detail').textContent = '';

  const started = Date.now();
  // 只传当前标签页所属软件的选择集
  const keys = [...state.selected].filter((key) => key.startsWith(source.id));
  const result = await window.api.runSync({ repoId: state.targetRepo, mode, keys });

  $('busy').hidden = true;
  state.busy = false;
  updateActions();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const panel = $('result');
  const list = $('result-list');
  list.innerHTML = '';
  panel.hidden = false;

  if (!result.ok) {
    $('result-title').textContent = '同步失败';
    list.appendChild(el('li', 'err', result.error ?? '未知错误'));
    for (const step of result.steps ?? []) list.appendChild(el('li', '', step));
    toast('同步失败', 'bad');
    return;
  }

  const label = mode === 'upload' ? '上传完成' : '下载完成';
  $('result-title').textContent = `${label} · ${seconds}s`;
  for (const step of result.steps ?? []) list.appendChild(el('li', 'ok', step));
  for (const conflict of result.conflicts ?? []) list.appendChild(el('li', 'warn', conflict));
  for (const warning of result.warnings ?? []) list.appendChild(el('li', 'warn', warning));
  if ((result.steps ?? []).length === 0) list.appendChild(el('li', '', '没有需要变更的内容'));

  toast(label, 'ok');
  await refreshSources();
  await refreshRepos();
}

$('act-upload').addEventListener('click', () => runSync('upload'));
$('act-download').addEventListener('click', () => runSync('download'));
$('result-close').addEventListener('click', () => {
  $('result').hidden = true;
});
$('busy-hide').addEventListener('click', () => {
  $('busy').hidden = true;
});

// ───────────────────────────────── 账号

$('open-token-page').addEventListener('click', () => {
  openRepoUrl('https://github.com/settings/tokens/new?scopes=repo&description=dshwb-sync');
});

$('token-help').addEventListener('click', () => {
  openRepoUrl('https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens');
});

$('verify-token').addEventListener('click', async () => {
  const token = $('token-input').value.trim();
  if (!token) return setHint('token-hint', '先粘贴令牌', 'bad');
  setHint('token-hint', '正在验证…');
  const result = await window.api.verifyToken(token);
  if (!result.ok) return setHint('token-hint', result.error ?? '验证失败', 'bad');

  state.bootstrap = await window.api.bootstrap();
  state.config = state.bootstrap.config;
  $('token-input').value = '';
  setHint('token-hint', '');
  $('auth-body').hidden = true;
  $('auth-signed').hidden = false;
  $('account-name').textContent = result.login;
  $('account-scopes').textContent = `权限：${result.scopes.join(', ') || '未显示'}`;
  if (result.avatar) $('account-avatar').style.backgroundImage = `url(${result.avatar})`;
  setStatus('auth-status', '已连接', 'ok');
  toast(`已连接 ${result.login}`, 'ok');
  await refreshRepos();
  await refreshSources();
});

$('sign-out').addEventListener('click', async () => {
  await window.api.signOut();
  state.bootstrap = await window.api.bootstrap();
  $('auth-body').hidden = false;
  $('auth-signed').hidden = true;
  setStatus('auth-status', '未连接', 'bad');
  toast('已断开连接');
});

$('probe-network').addEventListener('click', async () => {
  setStatus('net-status', '检测中…', '');
  $('net-detail').textContent = '逐个尝试可用的网络通道…';
  const result = await window.api.probe();
  state.config = await window.api.getConfig();
  if (result.ok) {
    setStatus('net-status', '可用', 'ok');
    $('net-detail').textContent = result.proxy ? `使用代理 ${result.proxy}（${result.ms}ms）` : '直连可用';
    toast('网络通道已确认', 'ok');
  } else {
    setStatus('net-status', '不可用', 'bad');
    $('net-detail').textContent = (result.results ?? []).map((i) => `${i.proxy || '直连'}：${i.detail || '失败'}`).join('；');
    toast('连不上 GitHub', 'bad');
  }
});

// ───────────────────────────────── 选项

function renderPaths() {
  const container = $('paths');
  container.innerHTML = '';
  const config = state.config;
  if (!config) return;

  for (const source of state.sources) {
    const row = el('div', 'path-row');

    // 数据目录不在默认位置时 detect 会判「没安装」。这里照样列出来，
    // 并明确标出「未检测到」，否则用户不知道该来这儿改路径。
    const detected = source.installed !== false;

    const head = el('div', 'path-head');
    head.appendChild(el('span', 'path-icon', source.icon ?? '▣'));
    head.appendChild(el('span', 'path-label', source.label));
    if (source.tier?.containerLabel && !source.generic) {
      head.appendChild(el('span', 'pill', source.tier.containerLabel));
    }
    if (!detected) {
      const warn = el('span', 'pill warn', '未检测到');
      if (source.detail) warn.title = source.detail;
      head.appendChild(warn);
    }
    row.appendChild(head);

    if (!detected) {
      const home = config.softwareHome?.[source.id] ?? '';
      row.appendChild(
        el(
          'div',
          'hint',
          `没在默认位置找到 ${source.label} 的数据目录`
            + (home ? `（当前配置：${home}）` : '')
            + '。如果它装在别处，用下面「数据目录」选一下真实位置即可。',
        ),
      );
    }

    // 工作区根目录（结构化软件才有）
    if (!source.generic) {
      const rootRow = el('div', 'path-entry');
      rootRow.appendChild(el('span', 'path-kind', '工作区根目录'));
      const value = config.workspaceRoot?.[source.id] ?? '';
      const text = el('span', 'path-value', value || '（未设置）');
      rootRow.appendChild(text);
      const pick = el('button', 'btn ghost xs', '选择');
      pick.addEventListener('click', async () => {
        const picked = await window.api.pickFolder();
        if (!picked.ok) return;
        const result = await window.api.setWorkspaceRoot({ sourceId: source.id, path: picked.path });
        state.config = result.config;
        renderPaths();
        toast('已更新');
      });
      rootRow.appendChild(pick);
      row.appendChild(rootRow);
    }

    // 软件数据目录
    const homeRow = el('div', 'path-entry');
    homeRow.appendChild(el('span', 'path-kind', '数据目录'));
    const homeValue = config.softwareHome?.[source.id] ?? '';
    homeRow.appendChild(el('span', 'path-value', homeValue || '（未设置）'));
    const pickHome = el('button', 'btn ghost xs', '选择');
    pickHome.addEventListener('click', async () => {
      const picked = await window.api.pickFolder();
      if (!picked.ok) return;
      const result = await window.api.setSoftwareHome({ sourceId: source.id, path: picked.path });
      state.config = result.config;
      renderPaths();
      toast('已更新');
    });
    homeRow.appendChild(pickHome);
    row.appendChild(homeRow);

    container.appendChild(row);
  }
}

function renderCustomSources() {
  const container = $('custom-list');
  container.innerHTML = '';
  const list = state.config?.customSources ?? [];
  if (list.length === 0) return;

  for (const source of list) {
    const row = el('div', 'custom-row');
    row.appendChild(el('span', '', `${source.icon ?? '▣'} ${source.label}`));
    const pathText = el('span', 'path-value', state.config?.softwareHome?.[source.homeKey] ?? '');
    pathText.style.flex = '1';
    row.appendChild(pathText);

    const remove = el('button', 'btn ghost xs', '移除');
    remove.addEventListener('click', async () => {
      await window.api.removeCustomSource(source.id);
      state.config = await window.api.getConfig();
      renderCustomSources();
      await refreshSources();
      renderPaths();
    });
    row.appendChild(remove);
    container.appendChild(row);
  }
}

$('add-custom').addEventListener('click', async () => {
  const presetId = $('preset-select').value;
  const preset = (state.bootstrap.presets ?? []).find((item) => item.id === presetId);
  if (!preset) return;

  const picked = await window.api.pickFolder();
  if (!picked.ok) return;

  const id = preset.id === 'custom' ? `custom-${Date.now().toString(36)}` : preset.id;
  await window.api.addCustomSource({
    id,
    label: preset.id === 'custom' ? picked.path.split(/[\\/]/).pop() : preset.label,
    description: preset.description,
    icon: preset.icon,
    home: picked.path,
  });

  state.config = await window.api.getConfig();
  setHint('custom-hint', `已添加 ${preset.label}`, 'ok');
  renderCustomSources();
  await refreshSources();
  renderPaths();
  toast('数据源已添加', 'ok');
});

async function refreshDiagnostics() {
  if (!state.config) return;
  const info = await window.api.diagnostics();
  renderPaths();
  renderCustomSources();

  const lines = [
    `引擎 ${info.engineVersion}`,
    `本机代号   ${state.config.machine}`,
    `主机/系统  ${info.hostname} · ${info.platform}`,
    `Electron   ${info.electron}（Node ${info.node}）`,
    `git        ${info.git ?? '✗ 未找到'}`,
    `网络       ${info.proxy || '直连'}`,
    '',
    `GitHub 令牌  ${info.hasToken ? '已保存（' + (info.tokenMode === 'safeStorage' ? '系统加密' : '明文') + '）' : '未保存'}`,
    '',
    '工作区根目录：',
    ...Object.entries(info.workspaceRoot ?? {}).map(([k, v]) => `  ${k}: ${v || '（未设置）'}`),
    '',
    '仓库：',
    ...(info.repos.length > 0
      ? info.repos.map((r) => `  ${r.name} → ${r.target}（${r.source}）${r.cloned ? ' 已克隆' : ''}`)
      : ['  （还没有仓库）']),
    '',
    `数据目录  ${info.paths.home}`,
  ];
  $('diag').textContent = lines.join('\n');
}

$('copy-diag').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('diag').textContent);
  toast('已复制');
});

$('open-state').addEventListener('click', () => window.api.openStateFolder());

// ───────────────────────────────── 启动

boot().catch((error) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">
    <h2>启动失败</h2><pre style="color:#f85149;white-space:pre-wrap">${escapeHtml(error?.stack ?? error)}</pre></div>`;
});
