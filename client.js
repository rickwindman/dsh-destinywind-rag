/**
 * 浏览器半：设置页「知识库」栏 + 对话输入框旁的知识库选择器。
 *
 * 注册两个 Slot（slot 名取自真实 Slot 树，非猜测）：
 *  - settings.section      → 设置页「知识库」栏目（4 个标签页）
 *  - conversation.input.left → 输入框左侧的知识库选择器
 *
 * 全部交互走宿主半的 HTTP API（/dsh-destinywind-rag/*）。
 *
 * 【拼接安全】web boot 会把所有插件的 client.js 拼进同一个模块作用域
 * （dsh-app://app/plugins/??a/client.js,b/client.js,...）。文件顶层不允许
 * 声明任何标识符——否则与其它插件撞名（曾因顶层 const API_BASE 与
 * dsh-destinywind-memory 撞名导致整个 web boot import failed，DSH 无法启动）。
 * 所有常量必须放在 factory(require) 函数作用域内。
 */

window.__ModuleLoader__.load({
  id: 'dsh-destinywind-rag',
  factory(require) {
    const React = require('react');
    const API_BASE = '/dsh-destinywind-rag';

    // 等待体验：进度百分比静止的阶段（如导入中后端逐文件处理）也要让进度条
    // 「活着」，否则用户会当成卡死。
    // 实现取 JS 模拟推进而非注入样式表：曾用 require('styles').insert 注入
    // keyframes，该内建 API 未在真机验证过，导致 web boot 激活直接 failed
    //（全机其他插件也从未用过它）。JS 定时推进零新依赖、零激活风险。

    const SETTINGS_SLOT = 'settings.section';
    const SETTINGS_ENTRY_ID = 'destinywind-rag';
    // 18 = 排在「记忆」(16) 与「技能」(17) 之后，靠近插件相关页面。
    const SETTINGS_ORDER = 18;

    const COMPOSER_SLOT = 'conversation.input.left';
    const COMPOSER_ENTRY_ID = 'destinywind-rag-scope';
    const COMPOSER_ORDER = 30;

    const KIND_META = {
      openai: { short: 'OpenAI 兼容', icon: '☁', label: '大模型向量引擎 · OpenAI 兼容端点' },
      custom: { short: '自定义 HTTP', icon: '⇄', label: '大模型向量引擎 · 自定义 HTTP 端点' },
      onnx: { short: '本地 ONNX', icon: '▣', label: '本地向量模型 · 本地 ONNX' },
      ollama: { short: 'Ollama', icon: '◉', label: '本地向量模型 · Ollama' },
      none: { short: '纯关键词', icon: '—', label: '不启用向量（纯 BM25 关键词检索）' },
    };

    const STATUS_TEXT = {
      ready: { text: '就绪', color: '#16a34a' },
      indexing: { text: '索引中', color: '#2563eb' },
      stale: { text: '需重建', color: '#d97706' },
      partial: { text: '部分失败', color: '#d97706' },
    };

    // ───────────────────────── API ─────────────────────────

    async function api(path, options) {
      const res = await fetch(`${API_BASE}${path}`, {
        method: options?.method ?? 'GET',
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error(`服务无响应（HTTP ${String(res.status)}）`);
      }
      if (body?.ok !== true) {
        const err = new Error(String(body?.error ?? `请求失败（HTTP ${String(res.status)}）`));
        err.suggestion = String(body?.suggestion ?? '');
        throw err;
      }
      return body;
    }

    // ───────────────────────── 主题 ─────────────────────────

    const T = {
      surface: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))',
      surfaceAlt: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      text2: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))',
      brand: 'var(--dsw-alias-brand-primary, #4c7dd0)',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warning-primary, #d97706)',
    };

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 980 },
      tabs: { display: 'flex', gap: 2, borderBottom: `1px solid ${T.border}` },
      tab: (active) => ({
        padding: '8px 14px', border: 0, background: 'transparent', cursor: 'pointer',
        color: active ? T.brand : T.text2, fontFamily: 'inherit', fontSize: 13.5,
        borderBottom: `2px solid ${active ? T.brand : 'transparent'}`,
        fontWeight: active ? 600 : 400,
      }),
      card: { border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, overflow: 'hidden' },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' },
      cardBody: { padding: 14 },
      title: { fontSize: 13.5, fontWeight: 600, color: T.text },
      sub: { fontSize: 12, color: T.text2, marginTop: 2 },
      btn: { padding: '6px 12px', borderRadius: 8, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
      btnPrimary: { padding: '6px 12px', borderRadius: 8, border: `1px solid ${T.brand}`, background: T.brand, color: '#fff', fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
      btnDanger: { padding: '6px 12px', borderRadius: 8, border: `1px solid ${T.error}`, background: 'transparent', color: T.error, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
      btnSm: { padding: '3px 9px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 13, fontFamily: 'inherit' },
      select: { padding: '7px 10px', borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 13, fontFamily: 'inherit' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' },
      th: { textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${T.border}`, color: T.text2, fontWeight: 500, fontSize: 12, whiteSpace: 'nowrap' },
      td: { padding: '9px 12px', borderBottom: `1px solid ${T.border}`, color: T.text, verticalAlign: 'middle', overflowWrap: 'break-word', wordBreak: 'break-word' },
      /** 长路径/长名称截断：两行省略 + title 悬浮看全文（配合 table-layout:fixed 防挤爆按钮）。 */
      clamp2: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', wordBreak: 'break-all' },
      /** 操作按钮组：空间不足时自动换行，绝不溢出可视区。 */
      btnWrap: { display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' },
      pill: (color) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '2px 8px', borderRadius: 999, background: 'transparent', border: `1px solid ${color}`, color }),
      dot: (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' }),
      bar: { height: 6, background: T.surfaceAlt, borderRadius: 999, overflow: 'hidden', minWidth: 90 },
      barFill: (pct, color) => ({ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: color ?? T.brand, borderRadius: 999, transition: 'width .3s ease' }),
      error: { fontSize: 12, color: T.error, marginTop: 6 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
    };

    /** 模态框（原生 dialog 元素，避免依赖额外组件）。 */
    function Modal(props) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        const el = ref.current;
        if (el && !el.open) el.showModal();
      }, []);
      return React.createElement('dialog', {
        ref,
        style: { border: `1px solid ${T.border}`, borderRadius: 12, padding: 0, background: 'var(--dsw-alias-bg-base, #fff)', color: T.text, maxWidth: 560, width: '92vw' },
        onClose: props.onClose,
        onClick: (e) => { if (e.target === ref.current) ref.current.close(); },
      }, React.createElement('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 600 } }, props.title),
        props.children,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          React.createElement('button', { type: 'button', style: styles.btn, disabled: !!props.busy, onClick: () => ref.current?.close() }, '取消'),
          props.onConfirm
            ? React.createElement('button', {
                type: 'button',
                style: props.danger ? styles.btnDanger : styles.btnPrimary,
                disabled: !!props.busy,
                onClick: () => { props.onConfirm(); ref.current?.close(); },
              }, props.busy ? '处理中…' : (props.confirmLabel ?? '确定'))
            : null,
        ),
      ));
    }

    // ───────────────────────── 标签页 1：知识库列表 ─────────────────────────

    function BasesTab({ state, actions, pickDirectory }) {
      const [dialog, setDialog] = React.useState(null);
      const [expandedBaseId, setExpandedBaseId] = React.useState('');
      const [folders, setFolders] = React.useState(null);
      const [foldersLoading, setFoldersLoading] = React.useState(false);
      const { bases, task } = state;

      // 展开/收起某库的来源文件夹视图。
      async function toggleFolders(baseId) {
        if (expandedBaseId === baseId) { setExpandedBaseId(''); setFolders(null); return; }
        setExpandedBaseId(baseId);
        setFoldersLoading(true);
        setFolders(null);
        try {
          const r = await api(`/bases/${encodeURIComponent(baseId)}/folders`);
          setFolders(r.folders ?? []);
        } catch (err) {
          setFolders([]);
        } finally {
          setFoldersLoading(false);
        }
      }

      function confirmDeleteFolder(base, folder) {
        setDialog({
          kind: 'deleteFolder', base, folder,
          // 惰性确认：点「确认」时才执行删除。
        });
      }

      return React.createElement(React.Fragment, null,
        task ? React.createElement('div', { style: styles.card },
          React.createElement('div', { style: { padding: 12 } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 } },
              React.createElement('span', null, `⏳ ${task.label}`),
              React.createElement('span', { style: styles.mono }, `${task.percent}%`),
            ),
            // 条纹流动：即使后端没有逐项进度，条也 visibly 活着，绝不「像卡死」。
            React.createElement('div', { style: styles.bar }, React.createElement('i', { style: styles.barFill(task.percent) })),
            React.createElement('div', { style: { fontSize: 11.5, color: T.text2, marginTop: 6 } },
              '正在处理，请稍候——文件夹很大或首次下载模型时可能需要几分钟；页面可以随时关闭，任务不会中断。'),
          )) : null,

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.cardHead },
            React.createElement('div', null,
              React.createElement('div', { style: styles.title }, `知识库（${bases.length}）`),
              React.createElement('div', { style: styles.sub }, '每个知识库可独立绑定向量模型；更换模型后需重建索引。'),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8 } },
              React.createElement('button', { type: 'button', style: styles.btn, disabled: !!state.pendingAction, onClick: () => setDialog({ kind: 'addFolder' }) }, '📁 添加文件夹'),
              React.createElement('button', { type: 'button', style: styles.btn, disabled: !!state.pendingAction || bases.length === 0, onClick: () => actions.reindexAll() }, '↻ 重建索引'),
              React.createElement('button', { type: 'button', style: styles.btnPrimary, disabled: !!state.pendingAction, onClick: () => setDialog({ kind: 'newBase' }) }, '＋ 新建知识库'),
            ),
          ),
          React.createElement('div', { style: { padding: 0 } },
            bases.length === 0
              ? React.createElement('div', { style: { padding: 32, textAlign: 'center', color: T.text2 } },
                  React.createElement('div', { style: { fontSize: 26, marginBottom: 8 } }, '📚'),
                  React.createElement('div', { style: { fontSize: 14, color: T.text, marginBottom: 6 } }, '还没有知识库'),
                  React.createElement('div', { style: { fontSize: 12.5, marginBottom: 14 } }, '添加一个文件夹，插件会自动解析 PDF / DOCX / PPTX / Markdown / TXT 并建立索引。'),
                  React.createElement('button', { type: 'button', style: styles.btnPrimary, onClick: () => setDialog({ kind: 'addFolder' }) }, '📁 添加文件夹'),
                )
              : React.createElement('table', { style: styles.table },
                  React.createElement('colgroup', null,
                    React.createElement('col', { style: { width: '26%' } }),
                    React.createElement('col', { style: { width: '10%' } }),
                    React.createElement('col', { style: { width: '11%' } }),
                    React.createElement('col', { style: { width: '17%' } }),
                    React.createElement('col', { style: { width: '36%' } }),
                  ),
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', { style: styles.th }, '名称'),
                    React.createElement('th', { style: styles.th }, '文档'),
                    React.createElement('th', { style: styles.th }, '状态'),
                    React.createElement('th', { style: styles.th }, '最后更新'),
                    React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, '操作'),
                  )),
                  React.createElement('tbody', null, bases.flatMap((base) => {
                    const st = STATUS_TEXT[base.status] ?? STATUS_TEXT.ready;
                    const busy = state.busyBaseId === base.id;
                    const expanded = expandedBaseId === base.id;
                    const rows = [];
                    rows.push(React.createElement('tr', { key: base.id },
                      React.createElement('td', { style: styles.td },
                        React.createElement('div', { style: { fontWeight: 600, ...styles.clamp2 }, title: base.name }, base.name),
                        React.createElement('div', { style: { ...styles.mono, color: T.text2, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                          title: `${base.id} · ${base.providerName ? `绑定 ${base.providerName}` : '未绑定模型'}` },
                          `${base.id} · ${base.providerName ? `绑定 ${base.providerName}` : '未绑定模型'}`),
                      ),
                      React.createElement('td', { style: styles.td }, `${base.docCount}`),
                      React.createElement('td', { style: styles.td },
                        busy
                          ? React.createElement('span', { style: styles.pill(T.brand) }, '索引中…')
                          : React.createElement('span', { style: styles.pill(st.color) }, st.text),
                      ),
                      React.createElement('td', { style: { ...styles.td, ...styles.mono, color: T.text2, fontSize: 11.5 } },
                        base.updatedAt ? new Date(base.updatedAt).toLocaleString('zh-CN') : '—'),
                      React.createElement('td', { style: { ...styles.td } },
                        React.createElement('div', { style: styles.btnWrap },
                          React.createElement('button', {
                            type: 'button',
                            style: { ...styles.btnSm, color: expanded ? T.brand : T.text, borderColor: expanded ? T.brand : T.border },
                            onClick: () => { void toggleFolders(base.id); },
                          }, expanded ? '📁 收起' : '📁 文件夹'),
                          React.createElement('button', { type: 'button', style: styles.btnSm, onClick: () => setDialog({ kind: 'rename', base }) }, '重命名'),
                          React.createElement('button', { type: 'button', style: styles.btnSm, disabled: busy, onClick: () => actions.reindex(base) }, '重建索引'),
                          React.createElement('button', { type: 'button', style: { ...styles.btnSm, color: T.error, borderColor: T.error }, onClick: () => setDialog({ kind: 'delete', base }) }, '删除'),
                        ),
                      ),
                    ));
                    if (expanded) {
                      rows.push(React.createElement('tr', { key: base.id + ':folders' },
                        React.createElement('td', { colSpan: 5, style: { ...styles.td, background: T.surfaceAlt } },
                          foldersLoading
                            ? React.createElement('div', { style: { fontSize: 12.5, color: T.text2, padding: '8px 0' } }, '正在读取来源文件夹…')
                            : React.createElement(FolderList, {
                                base, folders,
                                pendingAction: state.pendingAction,
                                onDelete: confirmDeleteFolder,
                                onRescan: (folder) => { void actions.rescanFolder(base.id, folder); },
                              }),
                        ),
                      ));
                    }
                    return rows;
                  })),
                ),
          ),
        ),

        dialog?.kind === 'newBase' ? React.createElement(NewBaseDialog, {
          providers: state.providers,
          onClose: () => setDialog(null),
          onConfirm: (payload) => { actions.createBase(payload); setDialog(null); },
        }) : null,
        dialog?.kind === 'rename' ? React.createElement(RenameDialog, {
          base: dialog.base,
          onClose: () => setDialog(null),
          onConfirm: (name) => { actions.renameBase(dialog.base.id, name); setDialog(null); },
        }) : null,
        dialog?.kind === 'delete' ? React.createElement(ConfirmDialog, {
          title: '删除知识库',
          message: `确定要删除知识库「${dialog.base.name}」吗？将删除插件内的 ${dialog.base.docCount} 个文档的索引记录（含全部分块与向量数据），此操作不可恢复。\n\n磁盘上的原文件不会被删除或修改，可随时重新添加文件夹并重建索引。`,
          danger: true,
          onClose: () => setDialog(null),
          onConfirm: () => { actions.deleteBase(dialog.base.id); setDialog(null); },
        }) : null,
        dialog?.kind === 'deleteFolder' ? React.createElement(ConfirmDialog, {
          title: '移除文件夹索引',
          message: `确定要移除「${dialog.folder}」导入的全部索引记录吗？\n\n只删除插件内的索引数据，磁盘上的原文件不会被删除或修改；之后可随时点「重新扫描」重新索引进库。`,
          danger: true,
          confirmLabel: '移除索引',
          onClose: () => setDialog(null),
          onConfirm: () => { actions.deleteFolderIndex(dialog.base.id, dialog.folder); setDialog(null); },
        }) : null,
        dialog?.kind === 'addFolder' ? React.createElement(AddFolderDialog, {
          bases: state.bases,
          pickDirectory,
          onClose: () => setDialog(null),
          onConfirm: (payload) => { actions.addFolder(payload); setDialog(null); },
        }) : null,
      );
    }

    function NewBaseDialog({ providers, onClose, onConfirm }) {
      const [name, setName] = React.useState('');
      const [description, setDescription] = React.useState('');
      const [providerId, setProviderId] = React.useState(providers[0]?.id ?? '');
      return React.createElement(Modal, {
        title: '新建知识库', onClose, confirmLabel: '创建',
        onConfirm: () => { if (name.trim()) onConfirm({ name: name.trim(), description: description.trim(), providerId }); },
      },
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '知识库名称'),
        React.createElement('input', { style: styles.input, value: name, placeholder: '例如：产品手册', onChange: (e) => setName(e.target.value) }),
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '描述（可选）'),
        React.createElement('input', { style: styles.input, value: description, placeholder: '这个知识库放什么内容', onChange: (e) => setDescription(e.target.value) }),
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '向量模型'),
        React.createElement('select', { style: styles.select, value: providerId, onChange: (e) => setProviderId(e.target.value) },
          providers.length === 0
            ? React.createElement('option', { value: '' }, '（暂无 provider，将使用系统自动检测）')
            : providers.map((p) => React.createElement('option', { key: p.id, value: p.id }, `${p.name} · ${p.model}`)),
        ),
      );
    }

    function RenameDialog({ base, onClose, onConfirm }) {
      const [name, setName] = React.useState(base.name);
      return React.createElement(Modal, { title: '重命名知识库', onClose, confirmLabel: '保存', onConfirm: () => { if (name.trim()) onConfirm(name.trim()); } },
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '新名称'),
        React.createElement('input', { style: styles.input, value: name, onChange: (e) => setName(e.target.value) }),
      );
    }

    function ConfirmDialog({ title, message, danger, onClose, onConfirm, confirmLabel }) {
      return React.createElement(Modal, { title, onClose, danger, confirmLabel: confirmLabel ?? '确认', onConfirm },
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.6, color: danger ? T.error : T.text } }, message),
      );
    }

    /** 添加文件夹：路径输入 + 目录浏览 + 确认后开始索引。 */
    function AddFolderDialog({ bases, onClose, onConfirm, pickDirectory }) {
      const [path, setPath] = React.useState('');
      const [browsing, setBrowsing] = React.useState(false);
      const [entries, setEntries] = React.useState(null);
      const [baseId, setBaseId] = React.useState(bases[0]?.id ?? '');
      const [error, setError] = React.useState('');
      const [browsingBusy, setBrowsingBusy] = React.useState(false);

      // 目录浏览：优先宿主原生选择器（uiWorkspace.pickDirectory，弹系统文件夹对话框），
      // 其次全局注入的 picker；两者都不可用才退回手输模式。
      async function browse() {
        setError('');
        if (typeof pickDirectory === 'function') {
          setBrowsingBusy(true);
          try {
            const picked = await pickDirectory();
            // 用户取消返回 null：不报错、不进手输模式，直接留在原状态。
            if (typeof picked === 'string' && picked.trim() !== '') {
              setPath(picked);
              return;
            }
            if (picked === null || picked === undefined) return;
          } catch (err) {
            setError(`目录选择器不可用：${String(err?.message ?? err)}（可手动输入路径）`);
          } finally {
            setBrowsingBusy(false);
          }
        }
        const fallback = globalThis.__DSH_DIRECTORY_PICKER__;
        if (typeof fallback === 'function') {
          try {
            const picked = await fallback();
            if (typeof picked === 'string' && picked.trim() !== '') { setPath(picked); return; }
            if (picked === null || picked === undefined) return;
          } catch (err) {
            setError(`目录选择器不可用：${String(err?.message ?? err)}`);
          }
        }
        // 无任何原生选择器：展开手输 + 子目录列出模式。
        setBrowsing(true);
      }

      // 手输路径时可列出子目录辅助选择。
      async function loadEntries(dir) {
        try {
          const r = await api(`/fs/list?path=${encodeURIComponent(dir)}`);
          setEntries(r.entries ?? []);
          setError('');
        } catch (err) {
          setEntries(null);
          setError(String(err?.message ?? err));
        }
      }

      return React.createElement(Modal, {
        title: '添加文件夹', onClose, confirmLabel: '确认并开始索引',
        onConfirm: () => {
          if (!path.trim()) { setError('请填写或选择文件夹路径'); return; }
          onConfirm({ dirPath: path.trim(), baseId });
        },
      },
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '文件夹路径'),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('input', { style: { ...styles.input, flex: 1 }, value: path, placeholder: '例如：D:\\Documents\\产品资料', onChange: (e) => setPath(e.target.value) }),
          React.createElement('button', {
            type: 'button', style: styles.btn, disabled: browsingBusy,
            onClick: () => { void browse(); },
          }, browsingBusy ? '打开选择器…' : '浏览…'),
        ),
        React.createElement('div', { style: { fontSize: 11.5, color: T.text2 } }, '支持 PDF、DOCX、PPTX、Markdown、TXT；子目录会递归索引。'),

        browsing ? React.createElement('div', { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
          React.createElement('div', { style: { fontSize: 12, color: T.text2 } }, '输入目录后点「列出」可查看子目录：'),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('input', { style: { ...styles.input, flex: 1 }, placeholder: 'D:\\Documents', id: 'rag-browse-dir' }),
            React.createElement('button', { type: 'button', style: styles.btn, onClick: () => {
              const el = document.getElementById('rag-browse-dir');
              if (el && el.value.trim()) void loadEntries(el.value.trim());
            } }, '列出'),
          ),
          entries ? React.createElement('div', { style: { maxHeight: 180, overflow: 'auto', border: `1px solid ${T.border}`, borderRadius: 6 } },
            entries.length === 0
              ? React.createElement('div', { style: { padding: 10, fontSize: 12, color: T.text2 } }, '该目录下没有子目录。')
              : entries.map((entry) => React.createElement('div', {
                  key: entry.path,
                  style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12.5, borderBottom: `1px solid ${T.border}` },
                  onClick: () => setPath(entry.path),
                }, `📁 ${entry.path}`)),
          ) : null,
        ) : null,

        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '加入知识库'),
        React.createElement('select', { style: styles.select, value: baseId, onChange: (e) => setBaseId(e.target.value) },
          bases.length === 0
            ? React.createElement('option', { value: '' }, '（将自动创建「默认知识库」）')
            : bases.map((b) => React.createElement('option', { key: b.id, value: b.id }, b.name)),
        ),
        error ? React.createElement('div', { style: styles.error }, error) : null,
      );
    }

    /**
     * 导入报告：为什么有的文件没进索引，一目了然。
     * 成功 / 内容重复跳过 / 按扩展名跳过明细（含旧版 Office 提示）/ 失败原因。
     */
    /**
     * 来源文件夹清单：路径 + 文档数 + 分块数，支持「删除索引」（原文件不动）与「重新扫描」。
     */
    function FolderList({ base, folders, onDelete, onRescan, pendingAction }) {
      if (!folders || folders.length === 0) {
        return React.createElement('div', { style: { fontSize: 12.5, color: T.text2, padding: '8px 4px' } },
          '该知识库还没有按文件夹导入的来源（可从「添加文件夹」导入，或全部是手工添加的文本）。',
        );
      }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' } },
        React.createElement('div', { style: { fontSize: 11.5, color: T.text2 } },
          '以下文件夹的文件已索引进本库；「删除索引」只移除插件内的索引记录，磁盘原文件不受影响。'),
        folders.map((f) => React.createElement('div', {
          key: f.folder,
          style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 10px', borderRadius: 8, background: T.surface, border: `1px solid ${T.border}` },
        },
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { ...styles.mono, fontSize: 12, ...styles.clamp2 }, title: f.folder }, `📁 ${f.folder}`),
            React.createElement('div', { style: { fontSize: 11.5, color: T.text2, marginTop: 2 } },
              `${f.documents} 个文档 · ${f.chunks} 个分块`),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 6, flex: 'none', flexWrap: 'wrap', justifyContent: 'flex-end' } },
            React.createElement('button', {
              type: 'button', style: styles.btnSm,
              disabled: pendingAction === `rescan:${f.folder}` || !!pendingAction,
              title: `重新扫描 ${f.folder}（增量索引新增文件）`,
              onClick: () => onRescan(f.folder),
            }, pendingAction === `rescan:${f.folder}` ? '扫描中…' : '↻ 重新扫描'),
            React.createElement('button', {
              type: 'button', style: { ...styles.btnSm, color: T.error, borderColor: T.error },
              disabled: !!pendingAction,
              onClick: () => onDelete(base, f.folder),
            }, pendingAction === 'deleteFolder' ? '移除中…' : '删除索引'),
          ),
        )),
      );
    }

    function ImportReportDialog({ report, onClose }) {
      const extEntries = Object.entries(report.skippedByExt ?? {}).sort((a, b) => b[1] - a[1]);
      const oldOffice = extEntries.filter(([ext]) => ['.doc', '.ppt', '.xls', '.wps'].includes(ext));
      return React.createElement(Modal, {
        title: '导入完成', onClose, confirmLabel: '知道了', onConfirm: () => {},
      },
        React.createElement('div', { style: { fontSize: 12.5, color: T.text2, marginBottom: 10 } },
          `扫描目录：${report.dirPath ?? '—'}（含全部子目录层级，无深度限制；共扫描 ${report.folders ?? 0} 个文件夹）`),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 } },
          React.createElement('div', { style: { padding: 10, borderRadius: 8, border: `1px solid ${T.ok}` } },
            React.createElement('div', { style: { fontSize: 18, fontWeight: 700, color: T.ok } }, report.imported ?? 0),
            React.createElement('div', { style: { fontSize: 11.5, color: T.text2 } }, '新索引进库')),
          React.createElement('div', { style: { padding: 10, borderRadius: 8, border: `1px solid ${T.border}` } },
            React.createElement('div', { style: { fontSize: 18, fontWeight: 700 } }, report.duplicate ?? 0),
            React.createElement('div', { style: { fontSize: 11.5, color: T.text2 } }, '内容重复跳过')),
          React.createElement('div', { style: { padding: 10, borderRadius: 8, border: `1px solid ${T.warn}` } },
            React.createElement('div', { style: { fontSize: 18, fontWeight: 700, color: T.warn } }, report.skipped ?? 0),
            React.createElement('div', { style: { fontSize: 11.5, color: T.text2 } }, '格式不支持跳过')),
        ),
        extEntries.length > 0 ? React.createElement('div', { style: { marginBottom: 12 } },
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 } }, '未索引的文件类型：'),
          React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            extEntries.map(([ext, n]) => React.createElement('span', { key: ext, style: styles.pill(T.warn) }, `${ext} × ${n}`)),
          ),
          oldOffice.length > 0 ? React.createElement('div', { style: { fontSize: 12, color: T.warn, marginTop: 8 } },
            `检测到旧版 Office 格式（${oldOffice.map(([e]) => e).join('、')}）：插件无法直接解析，请用 Office/WPS 另存为 .docx / .pptx / .xlsx 后重新扫描该文件夹。`) : null,
          React.createElement('div', { style: { fontSize: 11.5, color: T.text2, marginTop: 8 } },
            '当前支持：PDF、DOCX、PPTX、Markdown、TXT（及 JSON/CSV/LOG 等纯文本）。'),
        ) : null,
        (report.failed ?? []).length > 0 ? React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 6, color: T.error } },
            `失败 ${report.failed.length} 个：`),
          React.createElement('div', { style: { maxHeight: 140, overflow: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 } },
            report.failed.map((f, i) => React.createElement('div', { key: i, style: { padding: '6px 10px', fontSize: 12, borderBottom: `1px solid ${T.border}` } },
              React.createElement('div', { style: { ...styles.mono, wordBreak: 'break-all' } }, f.path),
              React.createElement('div', { style: { color: T.error } }, f.error),
            )),
          ),
        ) : null,
        (report.imported ?? 0) === 0 && extEntries.length > 0
          ? React.createElement('div', { style: { marginTop: 10, padding: 10, borderRadius: 8, background: T.surfaceAlt, fontSize: 12.5 } },
              '本次没有任何文件被索引进库——全部是上面列出的不支持格式，或内容与库中已有文档重复。')
          : null,
      );
    }

    // ───────────────────────── 标签页 2：向量模型 ─────────────────────────

    function ProvidersTab({ state, actions }) {
      const [dialog, setDialog] = React.useState(null);
      const { providers, bindings, bases } = state;

      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.cardHead },
            React.createElement('div', null,
              React.createElement('div', { style: styles.title }, `向量引擎（${providers.length}）`),
              React.createElement('div', { style: styles.sub }, '大模型向量引擎（OpenAI 兼容 / 自定义 HTTP）与本地向量模型（ONNX / Ollama）均支持。'),
            ),
            React.createElement('button', { type: 'button', style: styles.btnPrimary, onClick: () => setDialog({ kind: 'provider', provider: null }) }, '＋ 新增 provider'),
          ),
          React.createElement('div', null,
            providers.length === 0
              ? React.createElement('div', { style: { padding: 26, textAlign: 'center', color: T.text2, fontSize: 13 } }, '暂无 provider。点击「新增 provider」添加，或直接添加文档让插件自动检测。')
              : React.createElement('table', { style: styles.table },
                  React.createElement('colgroup', null,
                    React.createElement('col', { style: { width: '22%' } }),
                    React.createElement('col', { style: { width: '18%' } }),
                    React.createElement('col', { style: { width: '22%' } }),
                    React.createElement('col', { style: { width: '18%' } }),
                    React.createElement('col', { style: { width: '20%' } }),
                  ),
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', { style: styles.th }, '类型 / 名称'),
                    React.createElement('th', { style: styles.th }, '端点'),
                    React.createElement('th', { style: styles.th }, '模型'),
                    React.createElement('th', { style: styles.th }, '状态'),
                    React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, '操作'),
                  )),
                  React.createElement('tbody', null, providers.map((p) => {
                    const meta = KIND_META[p.kind] ?? KIND_META.none;
                    const testing = state.testingProviderId === p.id;
                    return React.createElement('tr', { key: p.id },
                      React.createElement('td', { style: styles.td },
                        React.createElement('div', { style: { fontWeight: 600, ...styles.clamp2 }, title: p.name }, `${meta.icon} ${p.name}`),
                        React.createElement('div', { style: { fontSize: 11, color: T.text2 } }, meta.short),
                      ),
                      React.createElement('td', { style: { ...styles.td, ...styles.mono, color: T.text2, fontSize: 11.5 } },
                        React.createElement('div', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: p.endpoint },
                          p.kind === 'onnx' ? '（本地）' : (p.endpoint || '—'))),
                      React.createElement('td', { style: { ...styles.td, ...styles.mono, color: T.text2, fontSize: 11.5 } },
                        React.createElement('div', { style: styles.clamp2, title: p.model }, p.model || '—')),
                      React.createElement('td', { style: styles.td },
                        testing
                          ? React.createElement('div', null,
                              React.createElement('span', { style: styles.pill(T.text2) }, '测试中…'),
                              state.testProgress
                                ? React.createElement('div', { style: { fontSize: 11.5, color: T.text2, marginTop: 4, ...styles.clamp2 } }, state.testProgress)
                                : null,
                            )
                          : p.status === 'ok'
                            ? React.createElement('span', { style: styles.pill(T.ok) }, `✓ 正常 · ${p.latencyMs} ms`)
                            : p.status === 'error'
                              ? React.createElement('span', { style: { ...styles.pill(T.error), whiteSpace: 'normal' } }, `✗ ${p.error || '连接失败'}`)
                              : React.createElement('span', { style: { fontSize: 12, color: T.text2 } }, '未测试'),
                      ),
                      React.createElement('td', { style: { ...styles.td } },
                        React.createElement('div', { style: styles.btnWrap },
                          React.createElement('button', { type: 'button', style: styles.btnSm, onClick: () => setDialog({ kind: 'provider', provider: p }) }, '编辑'),
                          React.createElement('button', { type: 'button', style: styles.btnSm, disabled: testing, onClick: () => actions.testProvider(p) }, '测试连接'),
                          React.createElement('button', { type: 'button', style: { ...styles.btnSm, color: T.error, borderColor: T.error }, onClick: () => setDialog({ kind: 'deleteProvider', provider: p }) }, '删除'),
                        ),
                      ),
                    );
                  })),
                ),
          ),
        ),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.cardHead },
            React.createElement('div', null,
              React.createElement('div', { style: styles.title }, '知识库 ↔ 模型绑定'),
              React.createElement('div', { style: styles.sub }, '更换模型后需重建索引；维度与已建索引不一致时会提示「需重建」。'),
            ),
          ),
          React.createElement('div', null,
            bases.length === 0
              ? React.createElement('div', { style: { padding: 26, textAlign: 'center', color: T.text2, fontSize: 13 } }, '还没有知识库。')
              : React.createElement('table', { style: styles.table },
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', { style: styles.th }, '知识库名称'),
                    React.createElement('th', { style: styles.th }, '绑定的 provider'),
                    React.createElement('th', { style: styles.th }, '模型名'),
                    React.createElement('th', { style: styles.th }, '向量维度'),
                    React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, '操作'),
                  )),
                  React.createElement('tbody', null, bases.map((base) => {
                    const binding = bindings.find((b) => b.baseId === base.id && b.role === 'embedding');
                    const dim = base.dimension;
                    return React.createElement('tr', { key: base.id },
                      React.createElement('td', { style: { ...styles.td, fontWeight: 600 } }, base.name),
                      React.createElement('td', { style: styles.td },
                        binding
                          ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                              React.createElement('span', { style: styles.dot(binding.providerId ? T.ok : T.text2) }),
                              binding.providerName)
                          : React.createElement('span', { style: { color: T.text2 } }, '未绑定')),
                      React.createElement('td', { style: { ...styles.td, ...styles.mono, color: T.text2 } }, binding?.model || '—'),
                      React.createElement('td', { style: styles.td },
                        dim === null || dim === undefined
                          ? React.createElement('span', { style: { color: T.text2 } }, '—')
                          : dim.status === 'mismatch'
                            ? React.createElement('span', { style: styles.pill(T.warn) }, `需重建（模型 ${dim.modelDim} 维 / 索引 ${dim.indexDim} 维）`)
                            : dim.status === 'unknown'
                              ? React.createElement('span', { style: styles.pill(T.text2) }, dim.message)
                              : React.createElement('span', { style: styles.pill(T.ok) }, `${dim.modelDim || dim.indexDim} 维 · 一致`),
                      ),
                      React.createElement('td', { style: { ...styles.td, textAlign: 'right' } },
                        React.createElement('button', { type: 'button', style: styles.btnSm, disabled: providers.length === 0, onClick: () => setDialog({ kind: 'changeModel', base }) }, '更换模型'),
                      ),
                    );
                  })),
                ),
          ),
        ),

        dialog?.kind === 'provider' ? React.createElement(ProviderDialog, {
          provider: dialog.provider,
          onClose: () => setDialog(null),
          onSave: (payload) => { actions.saveProvider(dialog.provider, payload); setDialog(null); },
          onTest: (payload) => actions.testDraft(payload),
          testResult: state.draftTestResult,
        }) : null,
        dialog?.kind === 'deleteProvider' ? React.createElement(ConfirmDialog, {
          title: '删除向量 provider',
          message: `确定要删除「${dialog.provider.name}」吗？${bindings.filter((b) => b.providerId === dialog.provider.id).length > 0
            ? `有 ${bindings.filter((b) => b.providerId === dialog.provider.id).length} 个知识库正在使用它，删除后需重新绑定并重建索引。`
            : ''}`,
          danger: true,
          onClose: () => setDialog(null),
          onConfirm: () => { actions.deleteProvider(dialog.provider.id); setDialog(null); },
        }) : null,
        dialog?.kind === 'changeModel' ? React.createElement(ChangeModelDialog, {
          base: dialog.base,
          providers,
          onClose: () => setDialog(null),
          onConfirm: (providerId) => { actions.changeModel(dialog.base, providerId); setDialog(null); },
        }) : null,
      );
    }

    function ProviderDialog({ provider, onClose, onSave, onTest, testResult }) {
      const isNew = !provider;
      const [kind, setKind] = React.useState(provider?.kind ?? 'openai');
      const [name, setName] = React.useState(provider?.name ?? '');
      const [endpoint, setEndpoint] = React.useState(provider?.endpoint ?? '');
      const [apiKey, setApiKey] = React.useState('');
      const [model, setModel] = React.useState(provider?.model ?? '');
      const [dim, setDim] = React.useState(provider?.dim ? String(provider.dim) : '');

      const isLocal = kind === 'onnx' || kind === 'ollama';

      function payload() {
        return {
          kind,
          name: name.trim() || (KIND_META[kind]?.short ?? 'provider'),
          endpoint: isLocal ? (kind === 'ollama' ? (endpoint.trim() || 'http://127.0.0.1:11434') : '') : endpoint.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          dim: Number(dim) || 0,
        };
      }

      return React.createElement(Modal, {
        title: isNew ? '新增向量 provider' : '编辑向量 provider',
        onClose, confirmLabel: isNew ? '保存' : '保存修改',
        onConfirm: () => onSave(payload()),
      },
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '类型'),
        React.createElement('select', { style: styles.select, value: kind, onChange: (e) => setKind(e.target.value) },
          Object.entries(KIND_META).filter(([k]) => k !== 'none').map(([k, v]) =>
            React.createElement('option', { key: k, value: k }, v.label)),
        ),

        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '名称'),
        React.createElement('input', { style: styles.input, value: name, placeholder: '例如：公司网关 / 本地 Ollama', onChange: (e) => setName(e.target.value) }),

        kind === 'openai' || kind === 'custom' ? React.createElement(React.Fragment, null,
          React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, 'Endpoint'),
          React.createElement('input', { style: styles.input, value: endpoint, placeholder: 'https://api.openai.com/v1', onChange: (e) => setEndpoint(e.target.value) }),
          React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, 'API Key'),
          React.createElement('input', { style: styles.input, type: 'password', value: apiKey, placeholder: provider?.apiKey ? '（已保存，留空则不修改）' : 'sk-…', onChange: (e) => setApiKey(e.target.value) }),
          React.createElement('div', { style: { fontSize: 11.5, color: T.text2 } }, '留空时依次尝试环境变量 KNOWLEDGE_API_KEY / OPENAI_API_KEY。'),
        ) : null,

        kind === 'ollama' ? React.createElement(React.Fragment, null,
          React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, 'Ollama 端点（可选）'),
          React.createElement('input', { style: styles.input, value: endpoint, placeholder: 'http://127.0.0.1:11434', onChange: (e) => setEndpoint(e.target.value) }),
        ) : null,

        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '模型名'),
        React.createElement('input', { style: styles.input, value: model, placeholder: kind === 'onnx' ? 'onnx-community/Qwen3-Embedding-0.6B-ONNX' : kind === 'ollama' ? 'bge-m3' : 'text-embedding-3-small', onChange: (e) => setModel(e.target.value) }),

        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '向量维度（可选）'),
        React.createElement('input', { style: styles.input, value: dim, placeholder: '留空则测试连接时自动探测', onChange: (e) => setDim(e.target.value) }),

        isLocal ? React.createElement('div', { style: { padding: 10, borderRadius: 8, background: T.surfaceAlt, fontSize: 12, color: T.ok } },
          '本地向量模型开箱即用，无需 API Key；首次使用时自动下载权重并显示进度。') : null,

        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement('button', { type: 'button', style: styles.btn, onClick: () => onTest(payload()) }, '测试连接（不改动当前 provider）'),
        ),
        testResult ? React.createElement('div', { style: { fontSize: 12, color: testResult.ok ? T.ok : T.error } },
          testResult.ok ? `✓ 连接成功 · ${testResult.latencyMs} ms${testResult.dim ? ` · ${testResult.dim} 维` : ''}` : `✗ ${testResult.error}`,
        ) : null,
      );
    }

    function ChangeModelDialog({ base, providers, onClose, onConfirm }) {
      const [providerId, setProviderId] = React.useState(base.providerId ?? providers[0]?.id ?? '');
      const target = providers.find((p) => p.id === providerId);
      const mismatch = target && base.indexDim > 0 && target.dim > 0 && target.dim !== base.indexDim;
      return React.createElement(Modal, {
        title: '更换向量模型', onClose, confirmLabel: '确认并重建索引',
        onConfirm: () => { if (providerId) onConfirm(providerId); },
      },
        React.createElement('div', { style: { fontSize: 12.5, color: T.text2 } }, `知识库：${base.name}`),
        React.createElement('div', { style: { fontSize: 12.5, color: T.text2 } }, `当前绑定：${base.providerName || '未绑定'} · ${base.model || '—'}`),
        React.createElement('label', { style: { fontSize: 12, color: T.text2 } }, '更换为'),
        React.createElement('select', { style: styles.select, value: providerId, onChange: (e) => setProviderId(e.target.value) },
          providers.map((p) => React.createElement('option', { key: p.id, value: p.id }, `${p.name} · ${p.model}（${p.dim || '未知'} 维）`)),
        ),
        mismatch ? React.createElement('div', { style: { padding: 10, borderRadius: 8, background: T.surfaceAlt, fontSize: 12.5, color: T.warn } },
          `维度不一致：模型 ${target.dim} 维 / 已建索引 ${base.indexDim} 维，必须重建索引。`) : null,
        React.createElement('div', { style: { padding: 10, borderRadius: 8, background: T.surfaceAlt, fontSize: 12.5, color: T.warn } },
          '更换后需重建索引，是否继续？'),
      );
    }

    // ───────────────────────── 标签页 3：检索测试 ─────────────────────────

    function SearchTab({ state, actions }) {
      const [query, setQuery] = React.useState('');
      const [scope, setScope] = React.useState('all');
      const { searchResult, bases, searching } = state;

      function run() {
        if (!query.trim()) return;
        actions.search({ query: query.trim(), baseId: scope });
      }

      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.cardBody },
            React.createElement('div', { style: { display: 'flex', gap: 8 } },
              React.createElement('input', {
                style: { ...styles.input, flex: 1 }, value: query,
                placeholder: '输入查询语句，例如：如何配置部署环境？',
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') run(); },
              }),
              React.createElement('select', { style: { ...styles.select, width: 180 }, value: scope, onChange: (e) => setScope(e.target.value) },
                React.createElement('option', { value: 'all' }, '全部知识库'),
                bases.map((b) => React.createElement('option', { key: b.id, value: b.id }, b.name)),
              ),
              React.createElement('button', { type: 'button', style: styles.btnPrimary, disabled: searching, onClick: run }, searching ? '检索中…' : '检索'),
            ),
            React.createElement('div', { style: { fontSize: 11.5, color: T.text2, marginTop: 8 } },
              '检索方式：BM25 关键词 + 向量语义 → RRF 融合（可选重排序）。'),
          ),
        ),

        !searchResult
          ? React.createElement('div', { style: styles.card }, React.createElement('div', { style: { padding: 36, textAlign: 'center', color: T.text2 } },
              React.createElement('div', { style: { fontSize: 26, marginBottom: 8 } }, '🔍'),
              React.createElement('div', { style: { fontSize: 14, color: T.text, marginBottom: 4 } }, '输入查询开始检索测试'),
              React.createElement('div', { style: { fontSize: 12.5 } }, '可指定知识库范围；不指定则检索全部知识库。'),
            ))
          : searchResult.hits.length === 0
            ? React.createElement('div', { style: styles.card }, React.createElement('div', { style: { padding: 36, textAlign: 'center', color: T.text2 } },
                React.createElement('div', { style: { fontSize: 26, marginBottom: 8 } }, '🫙'),
                React.createElement('div', { style: { fontSize: 14, color: T.text, marginBottom: 4 } }, '没有召回结果'),
                React.createElement('div', { style: { fontSize: 12.5 } }, searchResult.message ?? '可尝试更换关键词、放宽相似度阈值，或确认目标知识库已完成索引。'),
              ))
            : React.createElement('div', { style: styles.card },
                React.createElement('div', { style: { padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } },
                  searchResult.hits.map((hit, i) => React.createElement(HitCard, { key: hit.id, hit, index: i, query, actions })),
                ),
                React.createElement('div', { style: { ...styles.cardHead, borderTop: `1px solid ${T.border}`, borderBottom: 0, color: T.text2, fontSize: 12 } },
                  React.createElement('span', null, `共召回 ${searchResult.hits.length} 条结果（已按相似度排序）`),
                  React.createElement('span', { style: styles.mono }, `检索耗时 ${searchResult.elapsedMs} ms${searchResult.reranked ? ' · 已重排序' : ''}`),
                ),
              ),
      );
    }

    function HitCard({ hit, index, query, actions }) {
      // 高亮命中词：把查询按空白/标点切开，逐个高亮。
      const terms = String(query ?? '').split(/[\s，。？！、,.;:!?]+/).filter((t) => t.length > 0);
      let parts = [hit.text];
      if (terms.length > 0) {
        const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        try {
          parts = hit.text.split(new RegExp(`(${pattern})`, 'gi'));
        } catch {
          parts = [hit.text];
        }
      }
      const lowerTerms = terms.map((t) => t.toLowerCase());

      return React.createElement('div', { style: { border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px' } },
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
          React.createElement('span', { style: { width: 22, height: 22, borderRadius: 6, background: T.surfaceAlt, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 } }, index + 1),
          React.createElement('span', { style: styles.pill(T.brand) }, `相似度 ${hit.score.toFixed(3)}`),
          hit.lexicalScore !== null && hit.lexicalScore !== undefined ? React.createElement('span', { style: styles.pill(T.text2) }, `BM25 ${hit.lexicalScore.toFixed(2)}`) : null,
          hit.vectorScore !== null && hit.vectorScore !== undefined ? React.createElement('span', { style: styles.pill(T.text2) }, `向量 ${hit.vectorScore.toFixed(3)}`) : null,
          React.createElement('span', { style: styles.pill(T.text2) }, hit.baseName),
        ),
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.65, color: T.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
          parts.map((part, i) => lowerTerms.includes(String(part).toLowerCase())
            ? React.createElement('mark', { key: i, style: { background: 'rgba(250,204,21,0.35)', borderRadius: 3 } }, part)
            : part),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap', fontSize: 12, color: T.text2 } },
          React.createElement('span', null, '来源：'),
          React.createElement('span', { style: { ...styles.mono, background: T.surfaceAlt, padding: '2px 6px', borderRadius: 5 } }, hit.source.path || hit.documentTitle || '未知'),
          hit.source.locator ? React.createElement('span', null, `· ${hit.source.locator}`) : null,
          hit.source.openable
            ? React.createElement('button', { type: 'button', style: { ...styles.btnSm, color: T.brand, borderColor: T.brand }, onClick: () => actions.openSource(hit.source.path) }, '打开原文件')
            : null,
        ),
      );
    }

    // ───────────────────────── 标签页 4：状态 ─────────────────────────

    /**
     * 可下载模型清单：文本向量 + 图文多模态（CLIP）。
     * 数据来自宿主 /models 接口（lib/local-models.js 的目录），此处只渲染。
     */
    function ModelCatalog({ detect, downloads, actions, disabled }) {
      const [models, setModels] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        void (async () => {
          try {
            const r = await api('/models');
            setModels(r.models ?? []);
          } catch (err) {
            setError(String(err?.message ?? err));
          }
        })();
      }, []);

      const statusByModel = {};
      for (const d of downloads ?? []) statusByModel[d.model] = d;

      function kindBadge(m) {
        if (m.multimodal) return React.createElement('span', { key: 'mm', style: styles.pill('#7c3aed') }, '图文多模态');
        if (m.kind === 'reranking') return React.createElement('span', { key: 'rr', style: styles.pill(T.warn) }, '重排序');
        return React.createElement('span', { key: 'tx', style: styles.pill(T.brand) }, '文本向量');
      }

      async function download(model) {
        setBusy(model);
        setError('');
        try {
          await api('/models/download', { method: 'POST', body: { model } });
          await actions.refreshStatus();
        } catch (err) {
          setError(String(err?.message ?? err) + (err?.suggestion ? ` — ${err.suggestion}` : ''));
        } finally {
          setBusy('');
        }
      }

      return React.createElement('div', null,
        error ? React.createElement('div', { style: styles.error }, error) : null,
        models === null
          ? React.createElement('div', { style: { fontSize: 12.5, color: T.text2 } }, '正在读取模型清单…')
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              models.map((m) => {
                const st = statusByModel[m.id];
                const isReady = st?.status === 'ready' || detect?.onnx?.downloaded && m.id === detect?.onnx?.model;
                return React.createElement('div', {
                  key: m.id,
                  style: { display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.border}` },
                },
                  React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                      React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, m.name),
                      kindBadge(m),
                      m.recommended ? React.createElement('span', { style: styles.pill(T.ok) }, '推荐') : null,
                      m.experimental ? React.createElement('span', { style: styles.pill(T.text2) }, '实验') : null,
                      isReady ? React.createElement('span', { style: styles.pill(T.ok) }, '已就绪') : null,
                    ),
                    React.createElement('div', { style: { fontSize: 11.5, color: T.text2, marginTop: 2 } },
                      `${m.subtitle ?? ''} · 约 ${m.sizeMB ?? '?'} MB`),
                  ),
                  React.createElement('button', {
                    type: 'button',
                    style: styles.btnSm,
                    disabled: disabled || busy === m.id || st?.status === 'downloading',
                    onClick: () => { void download(m.id); },
                  }, st?.status === 'downloading' ? `${st.progress ?? 0}%` : busy === m.id ? '开始下载…' : '下载'),
                );
              }),
            ),
      );
    }

    function StatusTab({ state, actions }) {
      const { status } = state;
      if (!status) return React.createElement('div', { style: { padding: 20, color: T.text2, fontSize: 13 } }, '正在读取状态…');
      const detect = status.detect ?? {};
      const downloads = status.downloads ?? [];
      const stats = status.stats ?? {};
      // 运行时不可用：显示安装引导而不是让用户点下载后吃 0% 失败。
      const onnxUnavailable = status.onnxAvailable === false;

      return React.createElement(React.Fragment, null,
        onnxUnavailable ? React.createElement('div', { style: styles.card },
          React.createElement('div', { style: { padding: 16 } },
            React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600, marginBottom: 6 } },
              '本地向量模型需要先安装运行时依赖'),
            React.createElement('div', { style: { fontSize: 12.5, color: T.text2, marginBottom: 8, lineHeight: 1.7 } },
              '正常情况下这些依赖会随插件自动安装（optionalDependencies）。如果安装时被跳过或失败，检索仍可正常使用（自动降级为关键词模式），也可改用 Ollama 或远程端点。要启用内置本地模型，请在插件目录执行：'),
            React.createElement('div', { style: { ...styles.mono, padding: '8px 12px', borderRadius: 8, background: T.surfaceAlt, marginBottom: 10, wordBreak: 'break-all' } },
              'npm i @huggingface/transformers@4.3.1 onnxruntime-node@1.30.0'),
            React.createElement('div', { style: { fontSize: 12, color: T.text2 } },
              '安装完成后重启 DSH 并回到本页选择模型下载。首次使用会自动下载模型权重，需要网络。'),
          ),
        ) : null,

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.cardHead },
            React.createElement('div', null,
              React.createElement('div', { style: styles.title }, '本地模型'),
              React.createElement('div', { style: styles.sub }, '选择模型下载；下载完成前检索会自动降级为关键词模式。图文模型支持把图片加入知识库（文字搜图）。'),
            ),
            React.createElement('button', { type: 'button', style: styles.btn, onClick: () => actions.refreshStatus() }, '刷新'),
          ),
          React.createElement('div', { style: styles.cardBody },
            React.createElement(ModelCatalog, { detect, downloads, actions, disabled: onnxUnavailable }),
            downloads.length === 0
              ? null
              : React.createElement('div', { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` } },
                  React.createElement('div', { style: { fontSize: 12.5, color: T.text2, marginBottom: 10 } }, '下载任务：'),
                  downloads.map((d) => React.createElement('div', { key: d.model, style: { marginBottom: 14 } },
                  React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, gap: 10 } },
                    React.createElement('span', null,
                      React.createElement('b', null, d.model),
                      React.createElement('span', { style: { color: T.text2, fontSize: 12, marginLeft: 6 } }, d.message || '')),
                    React.createElement('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      React.createElement('span', { style: styles.mono }, `${d.progress}%`),
                      d.status === 'downloading'
                        ? React.createElement('button', { type: 'button', style: styles.btnSm, onClick: () => actions.cancelModel(d.model) }, '取消')
                        : null,
                    ),
                  ),
                  React.createElement('div', { style: styles.bar },
                    React.createElement('i', { style: styles.barFill(d.progress, d.status === 'error' ? T.error : d.status === 'ready' ? T.ok : T.brand) })),
                  d.status === 'error' ? React.createElement('div', { style: { marginTop: 8, padding: 10, borderRadius: 8, background: T.surfaceAlt, fontSize: 12.5 } },
                    React.createElement('div', { style: { color: T.error, marginBottom: 4 } }, `✗ 下载失败：${d.message}`),
                    React.createElement('div', { style: { color: T.text2, marginBottom: 8 } }, '替代方案：'),
                    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      React.createElement('button', { type: 'button', style: styles.btnSm, onClick: () => actions.downloadModel(d.model) }, '重试下载'),
                      React.createElement('button', { type: 'button', style: styles.btnSm, onClick: () => actions.switchToOllama() }, '改用本机 Ollama'),
                      React.createElement('button', { type: 'button', style: styles.btnSm, onClick: () => actions.disableVector() }, '改用纯关键词检索'),
                    ),
                  ) : null,
                ))),
          ),
        ),

        React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.cardHead }, React.createElement('div', { style: styles.title }, '环境检测')),
          React.createElement('div', { style: styles.cardBody },
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '130px 1fr', gap: '6px 12px', fontSize: 12.5 } },
              React.createElement('span', { style: { color: T.text2 } }, '推荐引擎'),
              React.createElement('span', null, `${KIND_META[detect.recommended]?.short ?? detect.recommended ?? '—'}`),
              React.createElement('span', { style: { color: T.text2 } }, 'Ollama'),
              React.createElement('span', { style: { color: detect.ollama?.ok ? T.ok : T.text2 } },
                detect.ollama?.ok ? `✓ 可用（${detect.ollama.models?.length ?? 0} 个模型，${detect.ollama.latencyMs} ms）` : `✗ ${detect.ollama?.error || '未检测到'}`),
              React.createElement('span', { style: { color: T.text2 } }, '本地 ONNX 运行时'),
              React.createElement('span', { style: { color: detect.onnx?.ok ? T.ok : T.error } },
                detect.onnx?.ok ? `✓ 可用（模型权重${detect.onnx.downloaded ? '已' : '未'}下载）` : `✗ ${detect.onnx?.reason || '不可用'}`),
              React.createElement('span', { style: { color: T.text2 } }, 'GPU 加速'),
              React.createElement('span', null, detect.gpu?.available ? `✓ ${detect.gpu.gpuProviders?.join(', ')}` : '未检测到（将使用 CPU）'),
              React.createElement('span', { style: { color: T.text2 } }, 'API Key'),
              React.createElement('span', null, detect.apiKey?.has ? `✓ 检测到环境变量：${detect.apiKey.found.join(', ')}` : '未检测到环境变量（可在 provider 中直接填写）'),
              React.createElement('span', { style: { color: T.text2 } }, '模型缓存目录'),
              React.createElement('span', { style: { ...styles.mono, wordBreak: 'break-all' } }, detect.modelCache?.dir || '—'),
              React.createElement('span', { style: { color: T.text2 } }, '知识库 / 文档 / 分块'),
              React.createElement('span', null, `${stats.bases ?? 0} / ${stats.documents ?? 0} / ${stats.chunks ?? 0}`),
            ),
            (detect.reasons ?? []).length > 0
              ? React.createElement('div', { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` } },
                  React.createElement('div', { style: { fontSize: 12, color: T.text2, marginBottom: 4 } }, '检测说明：'),
                  (detect.reasons ?? []).map((r, i) => React.createElement('div', { key: i, style: { fontSize: 12, color: T.text2 } }, `· ${r}`)),
                )
              : null,
          ),
        ),

        (stats.bases ?? 0) === 0
          ? React.createElement('div', { style: styles.card }, React.createElement('div', { style: { padding: 36, textAlign: 'center', color: T.text2 } },
              React.createElement('div', { style: { fontSize: 26, marginBottom: 8 } }, '📚'),
              React.createElement('div', { style: { fontSize: 14, color: T.text, marginBottom: 6 } }, '知识库为空'),
              React.createElement('div', { style: { fontSize: 12.5, marginBottom: 14 } }, '还没有任何已索引的文档。添加一个文件夹后即可在对话中检索。'),
              React.createElement('button', { type: 'button', style: styles.btnPrimary, onClick: () => actions.goToTab('bases') }, '去添加文件夹'),
            ))
          : null,
      );
    }

    // ───────────────────────── 设置页主组件 ─────────────────────────

    function KnowledgeSettingsPage({ pickDirectory }) {
      const [tab, setTab] = React.useState('bases');
      const [bases, setBases] = React.useState([]);
      const [providers, setProviders] = React.useState([]);
      const [bindings, setBindings] = React.useState([]);
      const [status, setStatus] = React.useState(null);
      const [task, setTask] = React.useState(null);
      const [busyBaseId, setBusyBaseId] = React.useState('');
      const [testingProviderId, setTestingProviderId] = React.useState('');
      const [testProgress, setTestProgress] = React.useState('');
      const [draftTestResult, setDraftTestResult] = React.useState(null);
      const [searchResult, setSearchResult] = React.useState(null);
      const [searching, setSearching] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const [importReport, setImportReport] = React.useState(null);
      // 一次性操作的防双击锁（'createBase' | 'rename' | 'delete' | 'deleteFolder' | 'rescan:<id>' …）
      const [pendingAction, setPendingAction] = React.useState('');

      const notify = React.useCallback((message, kind) => {
        setToast({ message, kind });
        setTimeout(() => setToast(null), 4000);
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const [b, p, s] = await Promise.all([
            api('/bases'),
            api('/providers'),
            api('/status'),
          ]);
          setBases(b.bases ?? []);
          setProviders(p.providers ?? []);
          setBindings(p.bindings ?? []);
          setStatus(s);
        } catch (err) {
          notify(String(err?.message ?? err), 'error');
        }
      }, [notify]);

      React.useEffect(() => { void refresh(); }, [refresh]);

      // 下载/索引进行中时轮询状态。
      React.useEffect(() => {
        const hasActive = (status?.downloads ?? []).some((d) => d.status === 'downloading');
        if (!hasActive) return undefined;
        const timer = setInterval(() => { void refresh(); }, 1200);
        return () => clearInterval(timer);
      }, [status, refresh]);

      // 等待体验：后端没有逐项进度的长任务（导入/扫描），百分比会静止——静止的
      // 进度条会被当成卡死。这里让它在 30~95% 区间缓慢模拟推进；任何真实进度
      // （轮询到的 reindex 进度、完成态 100%）写入时直接覆盖模拟值。
      // dep 只挂 task?.sim：模拟启动一次，之后 interval 自持（setTask 函数式更新），
      // 真实进度写入会改 percent 但 sim 标志不变，interval 继续从新值缓慢推进。
      React.useEffect(() => {
        if (task?.sim !== true) return undefined;
        const timer = setInterval(() => {
          setTask((cur) => {
            if (!cur || cur.sim !== true || cur.percent >= 95) return cur;
            return { ...cur, percent: Math.min(95, cur.percent + 1) };
          });
        }, 300);
        return () => clearInterval(timer);
      }, [task?.sim]);

      const actions = {
        goToTab: (t) => setTab(t),

        async createBase(payload) {
          setPendingAction('createBase');
          try {
            const r = await api('/bases', { method: 'POST', body: payload });
            notify(`已创建知识库「${r.base.name}」`, 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally { setPendingAction(''); }
        },

        async renameBase(id, name) {
          setPendingAction('rename');
          try {
            await api(`/bases/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
            notify(`已重命名为「${name}」`, 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally { setPendingAction(''); }
        },

        async deleteBase(id) {
          setPendingAction('delete');
          try {
            await api(`/bases/${encodeURIComponent(id)}`, { method: 'DELETE' });
            notify('已删除知识库（磁盘原文件不受影响）', 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally { setPendingAction(''); }
        },

        async reindex(base) {
          setBusyBaseId(base.id);
          setTask({ label: `正在重建「${base.name}」索引…`, percent: 5 });
          // 轮询进度：重建是长任务（逐文档重新向量化），一次性请求期间必须让用户
          // 看到活的进度，否则「像卡死」。POST 仍同步返回（兼容），轮询只负责展示。
          let pollTimer = null;
          let lastPercent = 5;
          const startPolling = () => {
            pollTimer = setInterval(() => {
              void (async () => {
                try {
                  const r = await api('/reindex/progress');
                  const p = r.progress ?? {};
                  if (p.running && typeof p.percent === 'number') {
                    lastPercent = Math.max(lastPercent, p.percent);
                    setTask({ label: `${p.stage || '正在重建'}（${p.done ?? 0}/${p.total ?? '?'}）`, percent: lastPercent });
                  }
                } catch { /* 轮询失败不打断主流程 */ }
              })();
            }, 800);
          };
          startPolling();
          try {
            const r = await api(`/bases/${encodeURIComponent(base.id)}/reindex`, { method: 'POST' });
            const rep = r.report ?? {};
            setTask({ label: `「${base.name}」重建完成`, percent: 100 });
            notify(rep.failed?.length > 0
              ? `重建完成，但有 ${rep.failed.length} 个文档失败`
              : `重建完成：${rep.chunks} 个分块，维度 ${rep.dim || '未变'}`, rep.failed?.length > 0 ? 'error' : 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally {
            if (pollTimer) clearInterval(pollTimer);
            setBusyBaseId(''); setTimeout(() => setTask(null), 1500);
          }
        },

        async reindexAll() {
          if (bases.length === 0) { notify('没有可重建的知识库'); return; }
          for (const base of bases) {
            // 串行重建，避免同时占用模型运行时。
            // eslint-disable-next-line no-await-in-loop
            await actions.reindex(base);
          }
        },

        async addFolder(payload) {
          setPendingAction('addFolder');
          try {
            let targetBaseId = payload.baseId;
            if (!targetBaseId) {
              const r = await api('/ensure-default', { method: 'POST' });
              targetBaseId = r.base?.id;
            }
            setTask({ label: `正在索引「${payload.dirPath}」…`, percent: 30, sim: true });
            const r = await api('/documents', { method: 'POST', body: { dirPath: payload.dirPath, baseId: targetBaseId } });
            setTask({ label: '索引完成', percent: 100 });
            setImportReport({ ...r, dirPath: payload.dirPath });
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally { setPendingAction(''); setTimeout(() => setTask(null), 1500); }
        },

        async rescanFolder(baseId, folder) {
          setPendingAction(`rescan:${folder}`);
          try {
            setTask({ label: `正在重新扫描「${folder}」…`, percent: 30, sim: true });
            const r = await api('/documents', { method: 'POST', body: { dirPath: folder, baseId } });
            setTask({ label: '扫描完成', percent: 100 });
            setImportReport({ ...r, dirPath: folder });
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally { setPendingAction(''); setTimeout(() => setTask(null), 1500); }
        },

        async deleteFolderIndex(baseId, folder) {
          setPendingAction('deleteFolder');
          try {
            const r = await api(`/bases/${encodeURIComponent(baseId)}/folders/delete`, { method: 'POST', body: { folder } });
            notify(`已移除 ${r.deleted} 个文档的索引记录（原文件未动）`, 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally { setPendingAction(''); }
        },

        async saveProvider(provider, payload) {
          try {
            if (provider) {
              await api(`/providers/${encodeURIComponent(provider.id)}`, { method: 'PATCH', body: payload });
              notify(`已保存 provider「${payload.name}」`, 'ok');
            } else {
              await api('/providers', { method: 'POST', body: payload });
              notify(`已新增 provider「${payload.name}」`, 'ok');
            }
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },

        async testProvider(provider) {
          setTestingProviderId(provider.id);
          // 测试期间轮询下载进度：ONNX 首测会真实下载模型（可达数百 MB），
          // 静止的「测试中…」会被当成卡死；把活的百分比叠到按钮文案上。
          let pollTimer = null;
          const startPolling = () => {
            pollTimer = setInterval(() => {
              void (async () => {
                try {
                  const s = await api('/status');
                  const d = (s.downloads ?? []).find((x) => x.model === provider.model);
                  if (d && d.status === 'downloading') {
                    setTestProgress(`${provider.name} 正在下载模型 ${d.progress}%`);
                  } else if (d && d.status === 'ready') {
                    setTestProgress(`${provider.name} 模型就绪，正在验证…`);
                  }
                } catch { /* 轮询失败不打断 */ }
              })();
            }, 800);
          };
          setTestProgress(`${provider.name} 测试中…`);
          startPolling();
          try {
            const r = await api(`/providers/${encodeURIComponent(provider.id)}/test`, { method: 'POST' });
            const res = r.result ?? {};
            notify(res.ok
              ? `连接成功：${provider.name}（${res.latencyMs} ms${res.dim ? ` · ${res.dim} 维` : ''}）`
              : `连接失败：${res.error}${res.suggestion ? ` — ${res.suggestion}` : ''}`, res.ok ? 'ok' : 'error');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
          finally {
            if (pollTimer) clearInterval(pollTimer);
            setTestingProviderId(''); setTestProgress('');
          }
        },

        // 草稿测试：调 /providers/test-draft，宿主直接测 spec、零落库
        // （旧实现「先建临时 provider→测试→删除」会泄漏 __draft_ 垃圾记录）。
        async testDraft(payload) {
          setDraftTestResult(null);
          try {
            const r = await api('/providers/test-draft', { method: 'POST', body: payload });
            setDraftTestResult(r.result);
          } catch (err) {
            setDraftTestResult({ ok: false, error: String(err?.message ?? err) });
          }
        },

        async deleteProvider(id) {
          try {
            await api(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
            notify('已删除 provider', 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },

        async changeModel(base, providerId) {
          try {
            const r = await api('/bindings', { method: 'POST', body: { baseId: base.id, providerId, role: 'embedding' } });
            notify('已更换模型，正在重建索引…');
            await refresh();
            if (r.dimension?.status === 'mismatch') {
              await actions.reindex({ ...base, id: base.id, name: base.name });
            }
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },

        async search(payload) {
          setSearching(true);
          try {
            const r = await api('/search', { method: 'POST', body: payload });
            setSearchResult(r);
          } catch (err) {
            notify(String(err?.message ?? err), 'error');
            setSearchResult({ hits: [], elapsedMs: 0, message: String(err?.message ?? err) });
          } finally { setSearching(false); }
        },

        openSource(path) {
          // 交给宿主提供的文件打开能力；没有就复制路径提示用户。
          const opener = globalThis.__DSH_OPEN_FILE__;
          if (typeof opener === 'function') {
            try { void opener(path); return; } catch { /* 退回复制 */ }
          }
          try {
            void navigator.clipboard.writeText(path);
            notify(`已复制文件路径：${path}`, 'ok');
          } catch {
            notify(`文件路径：${path}`, 'ok');
          }
        },

        async refreshStatus() { await refresh(); },

        async downloadModel(model) {
          try {
            await api('/models/download', { method: 'POST', body: { model } });
            notify('已开始下载/预热模型，进度见上方进度条', 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },

        async cancelModel(model) {
          try {
            await api('/models/cancel', { method: 'POST', body: { model } });
            notify('已取消下载', 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },

        async switchToOllama() {
          try {
            await api('/config', { method: 'POST', body: { overrides: { embeddingProvider: 'ollama' } } });
            notify('已切换为 Ollama 向量引擎', 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },

        async disableVector() {
          try {
            await api('/config', { method: 'POST', body: { overrides: { embeddingProvider: 'none' } } });
            notify('已切换为纯关键词（BM25）检索', 'ok');
            await refresh();
          } catch (err) { notify(String(err?.message ?? err), 'error'); }
        },
      };

      const state = {
        tab, bases, providers, bindings, status, task, busyBaseId,
        testingProviderId, testProgress, draftTestResult, searchResult, searching,
        pendingAction,
      };

      return React.createElement('div', { style: styles.page },
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 13, color: T.text2 } },
            '管理知识库、向量模型绑定与检索测试。零配置可用：首次使用时插件会自动检测本机 Ollama / 本地 ONNX / 已配置端点并创建默认知识库。'),
        ),

        React.createElement('nav', { style: styles.tabs },
          [['bases', '知识库列表'], ['providers', '向量模型'], ['search', '检索测试'], ['status', '状态']].map(([key, label]) =>
            React.createElement('button', { key, type: 'button', style: styles.tab(tab === key), onClick: () => setTab(key) }, label)),
        ),

        tab === 'bases' ? React.createElement(BasesTab, { state, actions, pickDirectory }) : null,
        tab === 'providers' ? React.createElement(ProvidersTab, { state, actions }) : null,
        tab === 'search' ? React.createElement(SearchTab, { state, actions }) : null,
        tab === 'status' ? React.createElement(StatusTab, { state, actions }) : null,

        importReport ? React.createElement(ImportReportDialog, {
          report: importReport,
          onClose: () => setImportReport(null),
        }) : null,

        toast ? React.createElement('div', {
          style: {
            position: 'fixed', right: 18, bottom: 18, zIndex: 90, padding: '9px 14px', borderRadius: 8,
            fontSize: 12.5, color: '#fff', maxWidth: 420,
            background: toast.kind === 'error' ? '#991b1b' : toast.kind === 'ok' ? '#166534' : '#1f2430',
          },
        }, toast.message) : null,
      );
    }

    // ───────────────────────── 输入框旁的知识库选择器 ─────────────────────────

    /**
     * 对话输入框左侧的知识库范围选择器。
     * 「自动」= 不限定，由模型自行判断是否检索；也可指定某个库或全部库。
     */
    function KnowledgeScopePicker() {
      const [open, setOpen] = React.useState(false);
      const [bases, setBases] = React.useState([]);
      const [scope, setScope] = React.useState(() => {
        try { return globalThis.localStorage?.getItem('dsh-destinywind-rag:scope') ?? 'auto'; } catch { return 'auto'; }
      });

      React.useEffect(() => {
        void (async () => {
          try {
            const r = await api('/bases');
            setBases(r.bases ?? []);
          } catch {
            setBases([]);
          }
        })();
      }, []);

      function choose(value) {
        setScope(value);
        try { globalThis.localStorage?.setItem('dsh-destinywind-rag:scope', value); } catch { /* 忽略 */ }
        // 同步给宿主：模型未显式指定范围时按此限定检索。
        const payload = value === 'auto'
          ? { scope: 'auto', baseId: null }
          : value === 'all'
            ? { scope: 'all', baseId: null }
            : { scope: 'base', baseId: value };
        void api('/scope', { method: 'POST', body: payload }).catch(() => { /* 离线时仅本地生效 */ });
        setOpen(false);
      }

      const current = scope === 'auto'
        ? '自动'
        : scope === 'all'
          ? '全部知识库'
          : (bases.find((b) => b.id === scope)?.name ?? '未知知识库');

      return React.createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
        React.createElement('button', {
          type: 'button',
          title: '选择知识库检索范围',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px',
            borderRadius: 8, border: `1px solid ${scope === 'auto' ? T.border : T.brand}`,
            background: 'transparent', color: scope === 'auto' ? T.text2 : T.brand,
            fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', maxWidth: 180,
          },
          onClick: () => setOpen((v) => !v),
        },
          React.createElement('span', null, '📚'),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, current),
        ),
        open ? React.createElement('div', {
          style: {
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60, minWidth: 200,
            border: `1px solid ${T.border}`, borderRadius: 10, background: 'var(--dsw-alias-bg-base, #fff)',
            boxShadow: '0 8px 24px rgba(16,24,40,0.16)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
          },
        },
          [
            ['auto', '自动（由模型判断）'],
            ['all', '全部知识库'],
          ].map(([value, label]) => React.createElement('div', {
            key: value,
            style: { padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, color: scope === value ? T.brand : T.text },
            onClick: () => choose(value),
          }, label)),
          bases.length > 0 ? React.createElement('div', { style: { height: 1, background: T.border, margin: '4px 0' } }) : null,
          bases.map((b) => React.createElement('div', {
            key: b.id,
            style: { padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, color: scope === b.id ? T.brand : T.text, display: 'flex', justifyContent: 'space-between', gap: 8 },
            onClick: () => choose(b.id),
          },
            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, b.name),
            React.createElement('span', { style: { color: T.text2, fontSize: 11 } }, `${b.docCount}`),
          )),
          bases.length === 0
            ? React.createElement('div', { style: { padding: '7px 10px', fontSize: 12, color: T.text2 } }, '暂无知识库，请先在设置页添加文档。')
            : null,
        ) : null,
      );
    }

    // ───────────────────────── 注册 ─────────────────────────

    /** 取原生目录选择器：uiWorkspace.pickDirectory（系统文件夹对话框）。 */
    function resolveDirectoryPicker(ctx) {
      try {
        const uiWorkspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : undefined;
        if (uiWorkspace && typeof uiWorkspace.pickDirectory === 'function') {
          return (opts) => uiWorkspace.pickDirectory(opts);
        }
      } catch {
        /* uiWorkspace 未注册时保持 undefined */
      }
      return null;
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 原生目录选择器：每次渲染时按需解析（服务可能晚注册，与 computer-user 同策略）。
        let directoryPicker = resolveDirectoryPicker(ctx);

        // 设置页「知识库」栏
        ctx.effect(() => ctx.slots.inject(SETTINGS_SLOT, () => {
          // slot 回调在每次打开设置页时执行：重新解析可选服务（晚注册/HMR 友好）。
          directoryPicker = resolveDirectoryPicker(ctx) ?? directoryPicker;
          return ctx.slots.register(
            { name: SETTINGS_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: '知识库' },
            (props) => KnowledgeSettingsPage({ ...props, pickDirectory: directoryPicker }),
          );
        }), 'dsh-destinywind-rag: settings section');

        // 输入框旁的知识库选择器
        ctx.effect(() => ctx.slots.inject(COMPOSER_SLOT, () => ctx.slots.register(
          { name: COMPOSER_SLOT, id: COMPOSER_ENTRY_ID, order: COMPOSER_ORDER, label: '知识库范围' },
          KnowledgeScopePicker,
        )), 'dsh-destinywind-rag: composer scope picker');
      },
    };
  },
});
