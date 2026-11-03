// 预加载：只暴露白名单 IPC 给渲染层。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  // 启动
  bootstrap: () => invoke('app:bootstrap'),
  initConfig: (options) => invoke('app:initConfig', options),

  // 账号
  verifyToken: (token) => invoke('github:verifyToken', token),
  signOut: () => invoke('github:signOut'),
  openUrl: (url) => invoke('github:openUrl', url),
  probe: () => invoke('github:probe'),

  // 仓库
  listRepos: () => invoke('repos:list'),
  availableRepos: () => invoke('repos:available'),
  discoverRepos: () => invoke('repos:discover'),
  adoptRepo: (payload) => invoke('repos:adopt', payload),
  claimRepo: (payload) => invoke('repos:claim', payload),
  addRepo: (input) => invoke('repos:add', input),
  updateRepo: (payload) => invoke('repos:update', payload),
  removeRepo: (payload) => invoke('repos:remove', payload),
  createRemoteRepo: (options) => invoke('repos:createRemote', options),
  updateRemoteRepo: (payload) => invoke('repos:updateRemote', payload),
  stampAllRepos: () => invoke('repos:stampAll'),
  deleteRemoteRepo: (payload) => invoke('repos:deleteRemote', payload),

  // 数据源
  inspectSources: () => invoke('sources:inspect'),
  addCustomSource: (input) => invoke('sources:addCustom', input),
  removeCustomSource: (id) => invoke('sources:removeCustom', id),

  // 同步
  runSync: (payload) => invoke('sync:run', payload),

  // 远端内容浏览与对比
  browseList: (payload) => invoke('browse:list', payload),
  browseCompare: (payload) => invoke('browse:compare', payload),
  browseTakeRemote: (payload) => invoke('browse:takeRemote', payload),
  browsePushLocal: (payload) => invoke('browse:pushLocal', payload),
  browseWriteRemote: (payload) => invoke('browse:writeRemote', payload),
  browseDeleteRemote: (payload) => invoke('browse:deleteRemote', payload),

  // 配置
  getConfig: () => invoke('config:get'),
  updateConfig: (patch) => invoke('config:update', patch),
  setWorkspaceRoot: (payload) => invoke('config:setWorkspaceRoot', payload),
  setSoftwareHome: (payload) => invoke('config:setSoftwareHome', payload),
  pickFolder: () => invoke('config:pickFolder'),

  // 诊断
  diagnostics: () => invoke('diag:info'),
  openStateFolder: () => invoke('diag:openStateFolder'),

  onProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('sync:progress', listener);
    return () => ipcRenderer.removeListener('sync:progress', listener);
  },
});
