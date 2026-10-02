/**
 * dsh-workspace-scope —— client 半边（浏览器）。
 *
 * 手写的 bundle：不需要复刻仓库内的 tsdown `clientBundle` 构建链，官方
 * `dsh-client-ui-skill` 与三个社区包的产物完全同形 ——
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内只 `require` 平台种子。
 *
 * 两个落点：
 *  1. 设置页 `settings.section`：技能表格（名称/描述/来源/三态/可管理标记）、搜索、
 *     MCP 服务器开关、当前项目根、配置来源。**状态一律来自本插件配置文件**，不读
 *     注册表返回的 invocation —— 冷读路径用的是 preset 作用域，看不到 agent 层的
 *     降级，会把 manual/off 显示成启用态。
 *  2. 输入框右侧 `conversation.input.right`：搜索 + 点选 → `inputActions.setDraft()`
 *     插入 `/名 `，随后回焦。
 *
 * 数据面：`POST /api/workspace-scope/rpc`（host 侧挂在官方守好的 `/api` 下，
 * 鉴权与 Host/Origin 栅栏由 Connection 负责）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-scope',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    /** RPC 路径必须与 host 半边的 `RPC_PATH` 一致。 */
    const RPC_PATH = '/api/workspace-scope/rpc';
    const STORAGE_KEY = 'dsh-workspace-scope.cwd';

    /** 三态的显示信息。 */
    const STATE_META = {
      pinned: { label: '自动注入', short: '自', hint: '进 <available_skills>，模型可自选，也可 /名 调用', color: 'var(--dsw-alias-state-success-primary)' },
      manual: { label: '仅手动', short: '手', hint: '不进模型目录、skill 工具拒绝，但 /名 仍注入全文', color: 'var(--dsw-alias-state-warn-primary)' },
      off: { label: '关闭', short: '关', hint: '完全无关：不进目录，/名 也不注入', color: 'var(--dsw-alias-state-idle-primary)' },
    };

    const COLORS = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      accent: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    /** 调用 host 面板 RPC。 */
    async function rpc(method, args = {}) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ method, args }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`面板 RPC 返回了非 JSON（HTTP ${response.status}）`);
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error(payload?.error ?? `面板 RPC 失败（HTTP ${response.status}）`);
      }
      return payload.value;
    }

    /** 从会话标准 props 拿 sessionId（0.1.7 之后没有"当前会话"游标）。 */
    const sessionIdOf = (props) => props?.sessionId ?? props?.session?.sessionId;

    /** 从会话标准 props 拿工作区 cwd；拿不到返回空串。 */
    const selectWorkspaceCwd = (sessionId) => (state) => {
      const cwd = sessionId === undefined ? undefined : state?.byId?.[sessionId]?.cwd;
      return typeof cwd === 'string' ? cwd : '';
    };

    /** 路径收敛成 `~/...`，避免长路径把表格挤爆。 */
    function shortenPath(path) {
      if (typeof path !== 'string') return '';
      const parts = path.split('/');
      if (path.startsWith('/Users/') && parts.length > 3) return `~/${parts.slice(3).join('/')}`;
      return path;
    }

    /** 字节数可读化。 */
    function readableSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    // ── 输入框右侧：技能点选插入 ─────────────────────────────────────────────

    /** 一个纯粹的插入动作：把 `/<name> ` 接到当前 draft 之后并调 setDraft。 */
    function insertSkill(inputActions, draft, name) {
      const separator = draft === '' || draft.endsWith(' ') || draft.endsWith('\n') ? '' : ' ';
      const next = `${draft}${separator}/${name} `;
      if (typeof inputActions?.setDraft !== 'function') throw new Error('当前内核没有提供 inputActions.setDraft');
      inputActions.setDraft(next);
      return next;
    }

    /** 把焦点还给 composer，并尽量把光标放回末尾。 */
    function focusComposer(from) {
      const container = from?.closest?.('[data-dsh-composer], form, .composer') ?? document;
      const editable = container.querySelector?.('textarea, [contenteditable="true"]');
      if (editable === null || editable === undefined) return;
      editable.focus?.();
      if (typeof editable.setSelectionRange === 'function' && typeof editable.value === 'string') {
        try {
          editable.setSelectionRange(editable.value.length, editable.value.length);
        } catch {
          /* 富文本编辑器不接受 selectionRange，忽略 */
        }
      }
    }

    /** composer 右侧的按钮 + 技能选择浮层。 */
    function ComposerScopeButton(props) {
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [rows, setRows] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [bottom, setBottom] = useState(96);
      const boxRef = useRef(null);

      const sessionId = sessionIdOf(props);
      const useSessions = props?.useSessions;
      const slotCwd = typeof useSessions === 'function' ? useSessions(selectWorkspaceCwd(sessionId)) : '';

      // draft 镜像：`useInput` 是选择器 hook，只能在 render 期调用；点击回调跑在
      // render 之外，用它同步最新的 draft，避免用陈旧快照覆盖用户已输入的内容。
      const draftRef = useRef('');
      if (typeof props?.useInput === 'function') {
        try {
          const snapshot = props.useInput((s) => s);
          if (snapshot !== undefined && typeof snapshot.draft === 'string') draftRef.current = snapshot.draft;
        } catch {
          /* 保留上一次已知的 draft */
        }
      }

      const load = useCallback(async () => {
        setError(undefined);
        try {
          const scope = typeof slotCwd === 'string' && slotCwd !== '' ? slotCwd : (await rpc('workspaces')).workspaces?.[0]?.path;
          if (typeof scope !== 'string' || scope === '') throw new Error('拿不到工作区目录');
          const state = await rpc('state', { cwd: scope });
          setRows(state.skills.filter((skill) => skill.state !== 'off'));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setRows([]);
        }
      }, [slotCwd]);

      useEffect(() => {
        if (!open) return undefined;
        // 每次打开都重新拉一次：配置可能刚在设置页被改过。
        setRows(undefined);
        void load();
        const onDown = (event) => {
          if (boxRef.current !== null && !boxRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [open, load]);

      const toggle = () => {
        if (!open) {
          const rect = boxRef.current?.getBoundingClientRect();
          if (rect !== undefined) setBottom(Math.max(64, Math.round(window.innerHeight - rect.top + 8)));
        }
        setOpen(!open);
        setQuery('');
      };

      const pick = (name) => {
        try {
          insertSkill(props?.inputActions, draftRef.current, name);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          return;
        }
        setOpen(false);
        setQuery('');
        const from = boxRef.current;
        window.requestAnimationFrame(() => focusComposer(from));
      };

      const visible = useMemo(() => {
        const list = rows ?? [];
        const needle = query.trim().toLowerCase();
        if (needle === '') return list;
        return list.filter((skill) => `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(needle));
      }, [rows, query]);

      return h(
        'div',
        { ref: boxRef, style: { position: 'relative', display: 'inline-flex' } },
        h(ScopeIconButton, { active: open, onClick: toggle, title: '插入 /技能名' }),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  bottom: `${bottom}px`,
                  right: '16px',
                  width: '380px',
                  maxHeight: '52vh',
                  display: 'flex',
                  flexDirection: 'column',
                  background: COLORS.layer,
                  border: `1px solid ${COLORS.borderStrong}`,
                  borderRadius: '10px',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
                  zIndex: 60,
                  overflow: 'hidden',
                },
                onMouseDown: (event) => event.stopPropagation(),
              },
              h('div', { style: { padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}` } },
                h('input', {
                  autoFocus: true,
                  value: query,
                  placeholder: '搜索技能…',
                  onChange: (event) => setQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') setOpen(false);
                    if (event.key === 'Enter' && visible[0] !== undefined) pick(visible[0].name);
                  },
                  style: {
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: `1px solid ${COLORS.border}`,
                    background: COLORS.layer2,
                    color: COLORS.text,
                    font: 'inherit',
                    outline: 'none',
                  },
                })),
              error !== undefined
                ? h('div', { style: { padding: '10px 12px', color: COLORS.error, fontSize: '12px' } }, `加载失败：${error}`)
                : null,
              h(
                'div',
                { style: { overflow: 'auto', padding: '4px 0' } },
                rows === undefined
                  ? h('div', { style: { padding: '10px 12px', color: COLORS.dim, fontSize: '12px' } }, '加载中…')
                  : visible.length === 0
                    ? h('div', { style: { padding: '10px 12px', color: COLORS.dim, fontSize: '12px' } }, '没有匹配的技能')
                    : visible.map((skill) =>
                        h(
                          'button',
                          {
                            key: skill.name,
                            type: 'button',
                            onClick: () => pick(skill.name),
                            title: skill.description,
                            style: {
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              padding: '7px 12px',
                              border: 'none',
                              background: 'transparent',
                              color: COLORS.text,
                              cursor: 'pointer',
                              font: 'inherit',
                            },
                            onMouseEnter: (event) => { event.currentTarget.style.background = COLORS.layer2; },
                            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent'; },
                          },
                          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
                            h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' } }, `/${skill.name}`),
                            skill.state === 'manual'
                              ? h('span', { style: { fontSize: '10px', color: COLORS.warn, border: `1px solid ${COLORS.warn}`, borderRadius: '4px', padding: '0 4px' } }, '仅手动')
                              : null),
                          h('div', { style: { fontSize: '11px', color: COLORS.dim, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, skill.description ?? '')),
                      ),
              ),
            )
          : null,
      );
    }

    /** 一个小图标按钮（避免依赖 primitives 的具体图标名）。 */
    function ScopeIconButton({ active, onClick, title }) {
      return h(
        'button',
        {
          type: 'button',
          title,
          onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            height: '28px',
            padding: '0 8px',
            borderRadius: '6px',
            border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
            background: 'transparent',
            color: active ? COLORS.accent : COLORS.dim,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '12px',
          },
        },
        h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, '/'),
        h('span', null, '技能'),
      );
    }

    // ── 设置页：工作区能力面板 ───────────────────────────────────────────────

    const TriState = ({ value, onChange, disabled }) => {
      const order = ['pinned', 'manual', 'off'];
      return h(
        'div',
        { style: { display: 'inline-flex', border: `1px solid ${COLORS.border}`, borderRadius: '6px', overflow: 'hidden', opacity: disabled ? 0.45 : 1 } },
        order.map((state) =>
          h(
            'button',
            {
              key: state,
              type: 'button',
              disabled,
              title: STATE_META[state].hint,
              onClick: () => onChange(state),
              style: {
                border: 'none',
                padding: '3px 8px',
                font: 'inherit',
                fontSize: '11px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                background: value === state ? COLORS.layer2 : 'transparent',
                color: value === state ? STATE_META[state].color : COLORS.dim,
                fontWeight: value === state ? 600 : 400,
              },
            },
            STATE_META[state].label,
          ),
        ),
      );
    };

    /** 设置页里的"工作区能力"一节。 */
    function WorkspaceScopeSection() {
      const [workspaces, setWorkspaces] = useState([]);
      const [cwd, setCwd] = useState(() => {
        try {
          return window.localStorage.getItem(STORAGE_KEY) ?? '';
        } catch {
          return '';
        }
      });
      const [state, setState] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState('');
      const [onlyProblem, setOnlyProblem] = useState(false);

      const refresh = useCallback(
        async (target) => {
          if (typeof target !== 'string' || target === '') return;
          setBusy(true);
          setError(undefined);
          try {
            setState(await rpc('state', { cwd: target }));
          } catch (cause) {
            setError(String(cause?.message ?? cause));
          } finally {
            setBusy(false);
          }
        },
        [],
      );

      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const listed = (await rpc('workspaces')).workspaces ?? [];
            if (cancelled) return;
            setWorkspaces(listed);
            const stored = (() => {
              try {
                return window.localStorage.getItem(STORAGE_KEY) ?? '';
              } catch {
                return '';
              }
            })();
            const target = listed.some((workspace) => workspace.path === stored) ? stored : listed[0]?.path;
            if (typeof target === 'string' && target !== '') {
              setCwd(target);
              await refresh(target);
            } else {
              setError('没有可配置的工作区：先打开一个会话或在工作区列表里添加目录');
            }
          } catch (cause) {
            if (!cancelled) setError(String(cause?.message ?? cause));
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [refresh]);

      const choose = (path) => {
        setCwd(path);
        try {
          window.localStorage.setItem(STORAGE_KEY, path);
        } catch {
          /* 无痕模式下 localStorage 不可写，忽略 */
        }
        void refresh(path);
      };

      const apply = async (method, args) => {
        setBusy(true);
        setError(undefined);
        try {
          await rpc(method, { cwd, ...args });
          await refresh(cwd);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setBusy(false);
        }
      };

      const rows = useMemo(() => {
        const all = state?.skills ?? [];
        const needle = query.trim().toLowerCase();
        return all.filter((skill) => {
          if (onlyProblem && skill.manageable && skill.state === 'pinned') return false;
          if (needle === '') return true;
          return `${skill.name} ${skill.description ?? ''} ${skill.sourceLabel ?? ''}`.toLowerCase().includes(needle);
        });
      }, [state, query, onlyProblem]);

      const header = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: '15px', color: COLORS.text } }, '工作区能力'),
          h('span', { style: { fontSize: '12px', color: COLORS.dim } }, '按当前项目目录决定技能是否自动注入、以及哪些 MCP 服务器工具可见')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', color: COLORS.dim } }, '工作区'),
          h(
            'select',
            {
              value: cwd,
              onChange: (event) => choose(event.target.value),
              style: { padding: '4px 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
            },
            workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.path }, `${workspace.title} — ${shortenPath(workspace.path)}`)),
          ),
          state?.scope?.projectLayer === true
            ? h('span', { style: { fontSize: '11px', color: COLORS.dim, fontFamily: 'ui-monospace, monospace' } }, shortenPath(state.scope.projectRoot))
            : null,
          h('span', { style: { fontSize: '11px', color: COLORS.dim } },
            state?.scope?.projectLayer === true
              ? `写入项目层 ${shortenPath(state.scope.projectPath)}`
              : `写入全局层 ${shortenPath(state.scope.globalPath)}`),
        ),
        state?.scope?.notice !== undefined ? h('div', { style: { fontSize: '11px', color: COLORS.warn } }, state.scope.notice) : null,
        state?.catalog?.notice !== undefined ? h('div', { style: { fontSize: '11px', color: COLORS.dim } }, state.catalog.notice) : null,
        state?.scope?.readError === undefined
          ? null
          : h('div', { style: { fontSize: '11px', color: COLORS.error } }, `配置文件有问题：${state.scope.readError}`),
        error !== undefined ? h('div', { style: { fontSize: '12px', color: COLORS.error } }, error) : null,
      );

      if (state === undefined) {
        return h('div', { style: { padding: '4px 0', display: 'flex', flexDirection: 'column', gap: '12px' } }, header, h('div', { style: { fontSize: '12px', color: COLORS.dim } }, busy ? '加载中…' : '暂无数据'));
      }

      const totals = state.totals;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' } },
        header,

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('input', {
            value: query,
            placeholder: '搜索技能…',
            onChange: (event) => setQuery(event.target.value),
            style: { flex: '1 1 220px', minWidth: '180px', padding: '5px 8px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
          }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: COLORS.dim } },
            h('input', { type: 'checkbox', checked: onlyProblem, onChange: (event) => setOnlyProblem(event.target.checked) }),
            '只看非默认项'),
          h('span', { style: { fontSize: '12px', color: COLORS.dim } },
            `共 ${totals.total} 个技能：隐藏 ${totals.hidden}（关闭 ${totals.off}），不可管理 ${totals.unmanageable}`),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: COLORS.dim } },
            '默认',
            h(
              'select',
              {
                value: state.defaultState,
                onChange: (event) => void apply('setDefault', { state: event.target.value }),
                style: { padding: '3px 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
              },
              ['pinned', 'manual', 'off'].map((value) => h('option', { key: value, value }, STATE_META[value].label)),
            ),
          ),
          busy ? h('span', { style: { fontSize: '11px', color: COLORS.dim } }, '同步中…') : null,
        ),

        h(
          'div',
          { style: { border: `1px solid ${COLORS.border}`, borderRadius: '8px', overflow: 'hidden' } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '200px 1fr 130px 220px', gap: '8px', padding: '6px 10px', background: COLORS.layer2, fontSize: '11px', color: COLORS.dim } },
            h('span', null, '技能'),
            h('span', null, '描述'),
            h('span', null, '来源'),
            h('span', null, '状态')),
          h(
            'div',
            { style: { maxHeight: '46vh', overflow: 'auto' } },
            rows.length === 0
              ? h('div', { style: { padding: '12px', fontSize: '12px', color: COLORS.dim } }, '没有匹配的技能')
              : rows.map((skill) =>
                  h(
                    'div',
                    {
                      key: skill.name,
                      style: {
                        display: 'grid',
                        gridTemplateColumns: '200px 1fr 130px 220px',
                        gap: '8px',
                        padding: '6px 10px',
                        alignItems: 'center',
                        borderTop: `1px solid ${COLORS.border}`,
                        opacity: skill.manageable ? 1 : 0.6,
                      },
                    },
                    h('div', { style: { minWidth: 0 } },
                      h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, skill.name),
                      h('div', { style: { fontSize: '10px', color: COLORS.dim } },
                        [skill.matchedKey === undefined ? '默认' : `命中 ${skill.matchedKey}`, readableSize(skill.size)].filter(Boolean).join(' · '))),
                    h('div', { style: { fontSize: '11px', color: COLORS.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: skill.reason ?? skill.description }, skill.reason ?? skill.description ?? ''),
                    h('div', { style: { fontSize: '11px', color: COLORS.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: skill.path ?? '' }, skill.sourceLabel ?? ''),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                      h(TriState, { value: skill.state, disabled: !skill.manageable, onChange: (next) => void apply('setSkill', { name: skill.name, state: next }) }),
                      skill.matchedKey === undefined
                        ? null
                        : h('button', {
                            type: 'button',
                            title: '删除显式配置，回落到通配符/默认',
                            onClick: () => void apply('setSkill', { name: skill.name, state: 'default' }),
                            style: { border: 'none', background: 'transparent', color: COLORS.dim, cursor: 'pointer', fontSize: '11px', font: 'inherit' },
                          }, '清除'),
                      skill.manageable
                        ? null
                        : h('span', { style: { fontSize: '10px', color: COLORS.idle, border: `1px solid ${COLORS.idle}`, borderRadius: '4px', padding: '0 4px' } }, '不可管理')),
                  ),
                ),
          ),
        ),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h4', { style: { margin: 0, fontSize: '13px', color: COLORS.text } }, 'MCP 服务器'),
          state.mcp.length === 0
            ? h('div', { style: { fontSize: '12px', color: COLORS.dim } }, '没有检测到 MCP 工具（服务器未连接或未配置）')
            : state.mcp.map((server) =>
                h('label', { key: server.name, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: COLORS.text } },
                  h('input', { type: 'checkbox', checked: server.enabled, onChange: (event) => void apply('setMcp', { server: server.name, enabled: event.target.checked }) }),
                  h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, server.name),
                  h('span', { style: { color: COLORS.dim } }, `${server.toolCount} 个工具`),
                  server.explicit ? null : h('span', { style: { color: COLORS.dim, fontSize: '11px' } }, '（继承默认：启用）')),
              )),
      );
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────

    const inject = ['slots'];

    /**
     * client 半边入口。
     * @param ctx - client 插件上下文（注入 slots）。
     */
    function apply(ctx) {
      // 向未声明的 slot 注册会在加载时抛错，所以一律走 `slots.inject`。
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'workspace-scope', order: 120, label: '插入技能' },
          ComposerScopeButton,
        )), 'workspace-scope: composer button');

      ctx.effect(() => ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'workspace-scope', order: 25, label: '工作区能力' },
          WorkspaceScopeSection,
        )), 'workspace-scope: settings section');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__logic = { insertSkill, shortenPath, readableSize, STATE_META };
    return module.exports;
  },
});
