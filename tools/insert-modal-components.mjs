// 在 createPanel 的 return 之前插入三个独立弹窗组件。
// 它们是真正的 React 组件（各自持有 hooks），所以开合不会触发 error #310。
import fs from 'node:fs';

const file = 'E:/AITools/wbpro/跨电脑同步/plugins/shared/panel.js';
let src = fs.readFileSync(file, 'utf8');

const anchor = `      return null;
    }

  };
}`;

if (!src.includes(anchor)) throw new Error('找不到插入锚点，panel.js 结构可能已变');

const components = `      return null;
    }

    // ── 弹窗组件（独立组件，各自持有自己的 hooks）

    /** 新建仓库（对应桌面端的「＋ 给这个软件新建仓库」）。 */
    function CreateRepoModal({ source, onSubmit, onClose, notify: _notify }) {
      const [name, setName] = useState(source?.label ? source.label + ' 同步' : '同步');
      const [repoName, setRepoName] = useState((source?.id ?? 'sync') + '-sync');
      const [isPrivate, setIsPrivate] = useState(true);
      const [description, setDescription] = useState('');
      const [hint, setHint] = useState({ text: '', kind: '' });
      const [submitting, setSubmitting] = useState(false);
      const sourceLabel = source?.label ?? '';

      const submit = async () => {
        if (!name.trim() || !repoName.trim()) {
          setHint({ text: '显示名和仓库名都要填', kind: 'bad' });
          return;
        }
        setHint({ text: '正在创建…', kind: '' });
        setSubmitting(true);
        const r = await onSubmit({
          name: name.trim(),
          repoName: repoName.trim(),
          isPrivate,
          description: description.trim(),
        });
        setSubmitting(false);
        if (!r.ok) {
          setHint({ text: r.error, kind: 'bad' });
          return;
        }
        onClose();
        if (r.marker && r.marker.ok === false) {
          _notify?.('仓库已创建，但标识没写进 GitHub：' + (r.marker.error ?? '未知原因'), 'bad');
        } else {
          _notify?.((isPrivate ? '私有' : '公开') + '仓库已创建，已打上「' + sourceLabel + '」标识', 'ok');
        }
      };

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal' },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, '为 ' + sourceLabel + ' 建仓库'),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '这个仓库只收 ' + sourceLabel + ' 的内容。'),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-grid2' },
              h('div', { className: 'dshwb-field' },
                h('label', null, '显示名'),
                h('input', {
                  className: 'dshwb-input', value: name,
                  onChange: (e) => setName(e.target.value),
                }),
                h('div', { className: 'dshwb-hint' }, '只在你自己的界面里显示'),
              ),
              h('div', { className: 'dshwb-field' },
                h('label', null, 'GitHub 仓库名'),
                h('input', {
                  className: 'dshwb-input', value: repoName,
                  onChange: (e) => setRepoName(e.target.value),
                }),
                h('div', { className: 'dshwb-hint' }, '对方看到的仓库名'),
              ),
            ),
            h('div', { className: 'dshwb-field' },
              h('label', null, '可见性'),
              h('div', { className: 'dshwb-seg' },
                h('button', {
                  className: 'dshwb-seg-item' + (isPrivate ? ' active' : ''),
                  onClick: () => setIsPrivate(true),
                },
                  h('span', { className: 'dshwb-seg-title' }, '私有'),
                  h('span', { className: 'dshwb-seg-sub' }, '只有你能看'),
                ),
                h('button', {
                  className: 'dshwb-seg-item' + (!isPrivate ? ' active' : ''),
                  onClick: () => setIsPrivate(false),
                },
                  h('span', { className: 'dshwb-seg-title' }, '公开'),
                  h('span', { className: 'dshwb-seg-sub' }, '可分享给别人'),
                ),
              ),
            ),
            h('div', { className: 'dshwb-field' },
              h('label', null, '描述'),
              h('input', {
                className: 'dshwb-input', value: description,
                placeholder: sourceLabel + ' 跨电脑同步',
                onChange: (e) => setDescription(e.target.value),
              }),
              h('div', { className: 'dshwb-hint' }, '显示在 GitHub 上，自动加软件标识'),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', { className: 'dshwb-btn primary', disabled: submitting, onClick: submit },
                submitting ? '创建中…' : '创建仓库'),
            ),
          ),
        ));
    }

    /** 加入已有仓库（对应桌面端的「加入已有仓库」）。 */
    function AdoptRepoModal({ boot, repos, call, onSubmit, onClose, notify: _notify }) {
      const [owner, setOwner] = useState(boot?.config?.github?.login ?? '');
      const [repoName, setRepoName] = useState('');
      const [hint, setHint] = useState({ text: '', kind: '' });
      const [candidates, setCandidates] = useState(null);
      const [submitting, setSubmitting] = useState(false);

      useEffect(() => {
        let alive = true;
        (async () => {
          const r = await call('availableRepos');
          if (!alive) return;
          if (r.ok) setCandidates(r.repos ?? []);
          else setCandidates({ failed: r.error });
        })();
        return () => { alive = false; };
      }, []);

      const registered = new Set(repos.map((r) => r.owner + '/' + r.repoName));
      const failed = candidates && !Array.isArray(candidates) ? candidates.failed : '';
      const list = Array.isArray(candidates)
        ? candidates.filter((r) => !registered.has(r.fullName)).slice(0, 60)
        : [];

      const submit = async () => {
        if (!owner.trim() || !repoName.trim()) {
          setHint({ text: '所有者和仓库名都要填', kind: 'bad' });
          return;
        }
        setHint({ text: '正在读取仓库标识…', kind: '' });
        setSubmitting(true);
        const r = await onSubmit({ owner: owner.trim(), repoName: repoName.trim() });
        setSubmitting(false);
        if (!r.ok) {
          setHint({ text: r.error, kind: 'bad' });
          return;
        }
        onClose();
        _notify?.(r.stamp && r.stamp.ok === false
          ? '已加入，但标识没写进 GitHub：' + (r.stamp.error ?? '未知原因')
          : '已加入本机', r.stamp && r.stamp.ok === false ? 'bad' : 'ok');
      };

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal' },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, '加入已有仓库'),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '另一台机器建过的仓库，这里填地址就能接管，不用重建。'),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-grid2' },
              h('div', { className: 'dshwb-field' },
                h('label', null, 'GitHub 所有者'),
                h('input', { className: 'dshwb-input', value: owner, onChange: (e) => setOwner(e.target.value) }),
              ),
              h('div', { className: 'dshwb-field' },
                h('label', null, '仓库名'),
                h('input', {
                  className: 'dshwb-input', value: repoName, placeholder: 'dsh-private-sync',
                  onChange: (e) => setRepoName(e.target.value),
                }),
              ),
            ),
            h('div', { className: 'dshwb-hint' }, '程序会读取仓库里的标识文件，自动认出它属于哪个软件'),
            h('div', { className: 'dshwb-field' },
              h('label', null, '或者从账号下的仓库里选'),
              candidates === null
                ? h('div', { className: 'dshwb-hint' }, '正在读取…')
                : failed
                  ? h('div', { className: 'dshwb-hint bad' }, '读不到账号下的仓库：' + failed)
                  : list.length === 0
                    ? h('div', { className: 'dshwb-hint' }, '账号下的仓库都已经登记过了')
                    : h('div', { className: 'dshwb-browser' },
                        ...list.map((r) => h('div', {
                          key: r.fullName, className: 'dshwb-browser-row',
                          onClick: () => { setOwner(r.owner); setRepoName(r.name); },
                        },
                          h('span', { className: 'name' }, r.fullName),
                          h('span', { className: 'dshwb-pill' }, r.private ? '私有' : '公开'),
                        ))),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', { className: 'dshwb-btn primary', disabled: submitting, onClick: submit },
                submitting ? '加入中…' : '加入'),
            ),
          ),
        ));
    }

    /**
     * 目录选择器。
     *
     * 插件没有系统的「选择文件夹」对话框（那是 Electron 主进程能力），
     * 所以自己列目录让用户点进去选，并允许直接填绝对路径。
     */
    function BrowseDirModal({ target, call, onClose, onPicked, notify: _notify }) {
      const [listing, setListing] = useState(null);
      const [manual, setManual] = useState('');
      const [hint, setHint] = useState({ text: '', kind: '' });

      const load = async (p) => {
        const r = await call('browseDir', { path: p });
        if (!r.ok) {
          setHint({ text: r.error, kind: 'bad' });
          return;
        }
        setListing(r);
        setManual(r.path);
        setHint({ text: '', kind: '' });
      };

      useEffect(() => { load(''); }, []);

      const pick = async (value) => {
        if (target.kind === 'addSource') {
          const preset = target.preset ?? {};
          const id = preset.id === 'custom' ? 'custom-' + Date.now().toString(36) : preset.id;
          const r = await call('addCustomSource', {
            id,
            label: preset.id === 'custom' ? String(value).split(/[\\\\/]/).pop() : preset.label,
            description: preset.description,
            icon: preset.icon,
            home: value,
          });
          if (!r.ok) {
            setHint({ text: r.error ?? '添加失败', kind: 'bad' });
            return;
          }
          onClose();
          await onPicked();
          _notify?.('已添加 ' + (preset.label ?? id), 'ok');
          return;
        }

        const r = await call('setPath', { sourceId: target.sourceId, kind: target.kind, value });
        if (!r.ok) {
          setHint({ text: r.error ?? '保存失败', kind: 'bad' });
          return;
        }
        onClose();
        await onPicked();
        _notify?.('已更新目录', 'ok');
      };

      const title = target.kind === 'workspaceRoot'
        ? '选择工作区根目录'
        : target.kind === 'addSource'
          ? '为 ' + (target.preset?.label ?? '新软件') + ' 选择数据目录'
          : '选择数据目录';

      return h('div', {
        className: 'dshwb-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'dshwb-modal' },
          h('div', { className: 'dshwb-modal-head' },
            h('div', { style: { minWidth: 0, flex: 1 } },
              h('h2', null, title),
              h('p', { className: 'dshwb-muted dshwb-sm' }, '点目录进入；双击目录直接选中它。'),
            ),
            h('button', { className: 'dshwb-btn ghost xs', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'dshwb-modal-body' },
            h('div', { className: 'dshwb-field' },
              h('label', null, '路径'),
              h('div', { className: 'dshwb-row' },
                h('input', {
                  className: 'dshwb-input', value: manual, style: { flex: 1 },
                  onChange: (e) => setManual(e.target.value),
                }),
                h('button', { className: 'dshwb-btn sm', onClick: () => load(manual) }, '前往'),
              ),
            ),
            h('div', { className: 'dshwb-browser' },
              listing
                ? h('div', null,
                    h('div', { className: 'dshwb-browser-path' }, listing.path || '（根）'),
                    listing.parent
                      ? h('div', { className: 'dshwb-browser-row', onClick: () => load(listing.parent) },
                          h('span', { className: 'name' }, '.. 上一级'))
                      : null,
                    ...(listing.dirs ?? []).map((d) =>
                      h('div', {
                        key: d.path, className: 'dshwb-browser-row',
                        onClick: () => load(d.path),
                        onDoubleClick: () => pick(d.path),
                      },
                        h('span', { className: 'name' }, d.name),
                        h('span', { className: 'dshwb-hint' }, '双击选中'),
                      )),
                  )
                : h('div', { className: 'dshwb-loading' }, '读取中…'),
            ),
          ),
          h('div', { className: 'dshwb-modal-foot' },
            h('div', { className: 'dshwb-hint ' + hint.kind }, hint.text),
            h('div', { className: 'dshwb-row' },
              h('button', { className: 'dshwb-btn ghost', onClick: onClose }, '取消'),
              h('button', {
                className: 'dshwb-btn primary',
                onClick: () => pick(manual || listing?.path || ''),
              }, '用这个目录'),
            ),
          ),
        ));
    }
  };
}`;

src = src.replace(anchor, components);
fs.writeFileSync(file, src, 'utf8');
console.log('已插入三个独立弹窗组件');
