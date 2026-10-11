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
 *
 * ponytail: 单文件手写 bundle（1000+ 行，越过"文件 < 800 行"的常规上限）。拆包要引入
 * 构建链，而 client 半边刻意只依赖 `react` 这个平台种子；等到需要跨插件复用组件、或本文件
 * 涨到 ~1500 行时再拆。
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

    /** 状态下拉里三态的固定顺序（行内下拉、批量条、默认状态共用）。 */
    const STATE_ORDER = ['pinned', 'manual', 'off'];

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

    /**
     * 技能表格的列模板：`勾选 / 技能 / 描述(含来源) / 状态`。
     *
     * 两轮演变的原因都在这条模板里：
     *  1. 最初四项定宽 `200px 1fr 130px 220px` 光固定列就 550px（+24px 间距），已超过设置
     *     面板的内容宽度；而描述单元格带 `overflow:hidden` —— CSS 里这类元素的自动最小尺寸
     *     是 0，于是 `1fr` 被压成 0 宽、`text-overflow:ellipsis` 连省略号都没地方画，表现就是
     *     **描述列一片空白**。所以每列都要有下限。
     *  2. 三态按钮（180~212px）是宽度大头，换成原生 `<select>`（96px）后省下的空间全给描述列；
     *     "来源"列并进描述单元格的末尾（它是不常用信息），于是四个下限 + 3 个 8px 间距
     *     只有 474px —— 面板正常宽度下描述列能拿到 240~280px、显示两行。
     */
    const GRID_COLUMNS = '24px minmax(150px, 200px) minmax(180px, 1fr) 96px';
    /** 表格的最小总宽：四个列下限之和 + 3 个 8px 间距。低于它就在外层横向滚动。 */
    const GRID_MIN_WIDTH = '474px';

    /** 状态下拉的"删除显式配置"伪值：它不是状态，是一个动作，所以不进 STATE_META。 */
    const CLEAR_VALUE = '__clear__';

    /** 描述列最多显示几行（超出用省略号）。 */
    const DESCRIPTION_MAX_LINES = 2;

    /** 目录体量估算的说明文案：字符数是复刻宿主规则算出来的，不是真实 token 数。 */
    const CATALOG_ESTIMATE_HINT = '按宿主渲染规则估算的字符数（`- `name`: description`，描述空白折叠、超 500 字符截断）。token 数因语言而异：英文约 3.8 字符/token，中文约 1.6 字符/token。';

    /** 面板 RPC 的超时预算：宿主挂起时不能把面板永远挂在"同步中…"。 */
    const RPC_TIMEOUT_MS = 15000;

    /** 调用 host 面板 RPC。 */
    async function rpc(method, args = {}) {
      let response;
      try {
        response = await fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ method, args }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch (cause) {
        if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
          throw new Error(`面板 RPC 超时（${RPC_TIMEOUT_MS / 1000} 秒未响应）`);
        }
        throw cause;
      }
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

    /** `props.useInput` 缺席时的占位 hook：hook 不能条件调用，必须有个稳定的替身。 */
    function useNoInput() {
      return undefined;
    }

    /** 选择器的稳定标识（每次渲染新建闭包会让部分 store 反复重订阅）。 */
    const identityInput = (state) => state;

    /** 路径收敛成 `~/...`，避免长路径把表格挤爆（macOS 的 /Users 与 Linux 的 /home 都认）。 */
    function shortenPath(path) {
      if (typeof path !== 'string') return '';
      const home = /^\/(?:Users|home)\/[^/]+\/(.+)$/.exec(path);
      return home === null ? path : `~/${home[1]}`;
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
    function focusComposer(container) {
      const root = container ?? document;
      const editable = root.querySelector?.('textarea, [contenteditable="true"]');
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

    /** 从按钮所在节点向上找 composer 容器；浮层关闭后节点已摘除，所以要**提前**取。 */
    function composerContainerOf(from) {
      return from?.closest?.('[data-dsh-composer], form, .composer') ?? undefined;
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
      // 选择器必须引用稳定：每次渲染新建闭包会让部分 store 反复重订阅。
      const selectCwd = useMemo(() => selectWorkspaceCwd(sessionId), [sessionId]);
      const slotCwd = typeof useSessions === 'function' ? useSessions(selectCwd) : '';

      // draft 镜像：`useInput` 是选择器 hook，只能在 render 期调用；点击回调跑在
      // render 之外，用它同步最新的 draft，避免用陈旧快照覆盖用户已输入的内容。
      // hook 不能条件调用、也不能 try/catch（抛错会打乱 hook 顺序），所以缺省时用替身。
      const draftRef = useRef('');
      const useInput = typeof props?.useInput === 'function' ? props.useInput : useNoInput;
      const snapshot = useInput(identityInput);
      if (snapshot !== undefined && typeof snapshot.draft === 'string') draftRef.current = snapshot.draft;

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
        // 容器必须在关闭浮层**之前**取：关闭后按钮节点已摘除，`closest()` 拿不到 composer，
        // 退化成"在 document 里找第一个输入框"，可能把焦点给到别处。
        const container = composerContainerOf(boxRef.current);
        try {
          insertSkill(props?.inputActions, draftRef.current, name);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          return;
        }
        setOpen(false);
        setQuery('');
        window.requestAnimationFrame(() => focusComposer(container));
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
          ? h(SkillPickerPopup, {
              bottom,
              query,
              rows,
              visible,
              error,
              onQuery: setQuery,
              onPick: pick,
              onClose: () => setOpen(false),
            })
          : null,
      );
    }

    /** `/技能` 浮层：搜索框 + 候选列表（纯展示，交互回调由调用方给）。 */
    function SkillPickerPopup({ bottom, query, rows, visible, error, onQuery, onPick, onClose }) {
      return h(
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
            onChange: (event) => onQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && visible[0] !== undefined) onPick(visible[0].name);
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
              : visible.map((skill) => h(SkillChoice, { key: skill.name, skill, onPick })),
        ),
      );
    }

    /** 浮层里的一个技能候选。 */
    function SkillChoice({ skill, onPick }) {
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onPick(skill.name),
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
        h('div', { style: { fontSize: '11px', color: COLORS.dim, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, skill.description ?? ''),
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

    /**
     * 行内状态选择器：原生 `<select>`。
     *
     * 原来是三个按钮拼的三态开关（180~212px），换成下拉后只占 96px —— 省下的宽度全给描述列，
     * 这是"释放空间显示更多技能介绍"的主要来源。用原生控件而不是自定义浮层：面板里已经有
     * 两个原生 select（工作区、默认状态），键盘与无障碍行为一致，也不用再引一套 UI 依赖。
     */
    function StateSelect({ skill, disabled, onChange }) {
      // "删除显式配置"只在**该键就在写入层里**时才有意义：host 的 `fallbackState` 正是按这个
      // 判据算的（精确键在另一层时删了也不改变生效状态，host 会跳过并回报原因）。两边共用
      // 同一个判据，面板就不会给出一个点了没反应的动作。
      const clearable = skill.fallbackState !== undefined;
      const meta = STATE_META[skill.state];
      return h(
        'select',
        {
          value: skill.state,
          disabled,
          title: meta?.hint,
          'aria-label': `技能 ${skill.name} 的注入状态`,
          onChange: (event) => onChange(event.target.value === CLEAR_VALUE ? 'default' : event.target.value),
          style: {
            width: '100%',
            boxSizing: 'border-box',
            padding: '3px 4px',
            borderRadius: '6px',
            border: `1px solid ${COLORS.border}`,
            background: COLORS.layer2,
            color: disabled ? COLORS.dim : meta?.color ?? COLORS.text,
            font: 'inherit',
            fontSize: '11px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          },
        },
        STATE_ORDER.map((state) => h('option', { key: state, value: state }, STATE_META[state].label)),
        clearable
          ? h('option', { key: CLEAR_VALUE, value: CLEAR_VALUE }, `删除显式配置（→ ${STATE_META[skill.fallbackState ?? 'pinned'].label}）`)
          : null,
      );
    }

    /** 字符数可读化：1234 → 1.2k（负数用于增量展示）。 */
    function formatChars(chars) {
      if (typeof chars !== 'number' || !Number.isFinite(chars)) return '0';
      if (Math.abs(chars) < 1000) return String(chars);
      return `${(chars / 1000).toFixed(1)}k`;
    }

    /** 目录体量增量的文案；0 单独说，免得读者以为"±0 字符"也算一次目录变化。 */
    function signedChars(delta) {
      if (delta === 0) return '目录大小不变';
      return `目录 ${delta < 0 ? '-' : '+'}${formatChars(Math.abs(delta))} 字符`;
    }

    /**
     * 把 host 排好序的行切成 [(可管理/不可管理) × 来源] 分组。
     *
     * 只按**相邻**两行的标签是否相同切分 —— 排序规则只有 `catalog.js` 一处实现，
     * 面板不再自己排一遍，两者因此不可能打架。`key` 用序号而不是标签：两个不同的未知来源
     * 会共享同一个显示名（"未知来源"），按标签做 React key 会撞。
     */
    function groupRows(rows) {
      const groups = [];
      for (const row of rows) {
        const label = `${row.manageable ? '可管理' : '不可管理'} · ${row.sourceLabel ?? '未知来源'}`;
        const last = groups.at(-1);
        if (last !== undefined && last.label === label) last.rows.push(row);
        else groups.push({ key: `group-${groups.length}`, label, rows: [row] });
      }
      return groups;
    }

    /**
     * 一次批量动作对模型目录体量的影响（字符数，负数 = 目录变小）。
     *
     * 只统计选中行：`before` 是它们此刻真正进目录的字符数，`after` 是动作生效后的。
     * 动作是 `default`（删除显式键）时用 host 算好的 `fallbackState` 推算落点。
     */
    function batchDeltaOf(skills, selected, target) {
      let before = 0;
      let after = 0;
      for (const row of skills) {
        if (!selected.has(row.name)) continue;
        const chars = typeof row.catalogChars === 'number' ? row.catalogChars : 0;
        before += row.inCatalog === true ? chars : 0;
        const next = target === 'default' ? row.fallbackState ?? row.state : target;
        after += next === 'pinned' ? chars : 0;
      }
      return after - before;
    }

    /** 批量操作条：只在有选中项时出现，不占常驻高度。 */
    function BatchBar({ selected, visible, batchState, onBatchState, onApply, onClear, delta, busy }) {
      // busy 期间一律禁用：写盘是异步的，双击会发出两次 setSkills，后一次的 noop 回执会盖掉
      // 前一次"已改 N 项"的结果。
      const plainButton = { border: 'none', background: 'transparent', color: COLORS.dim, cursor: busy ? 'not-allowed' : 'pointer', font: 'inherit', fontSize: '11px', opacity: busy ? 0.5 : 1 };
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
            padding: '6px 10px',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            background: COLORS.layer2,
            fontSize: '12px',
          },
        },
        h('span', { style: { color: COLORS.text } }, `已选 ${selected.size} 项（当前筛选 ${visible} 项）`),
        h('span', { style: { color: COLORS.dim } }, '设为'),
        h(
          'select',
          {
            value: batchState,
            disabled: busy,
            'aria-label': '批量设置的状态',
            onChange: (event) => onBatchState(event.target.value),
            style: { padding: '3px 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer, color: COLORS.text, font: 'inherit', fontSize: '12px' },
          },
          STATE_ORDER.map((value) => h('option', { key: value, value }, STATE_META[value].label)),
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => onApply(batchState),
            style: { padding: '3px 10px', borderRadius: '6px', border: `1px solid ${COLORS.accent}`, background: 'transparent', color: COLORS.accent, cursor: busy ? 'not-allowed' : 'pointer', font: 'inherit', fontSize: '12px', opacity: busy ? 0.5 : 1 },
          },
          '应用',
        ),
        h('button', { type: 'button', disabled: busy, title: '删除这些技能在写入层的显式配置（键在另一层的会被跳过并回报）', onClick: () => onApply('default'), style: plainButton }, '恢复默认'),
        h('button', { type: 'button', disabled: busy, onClick: onClear, style: plainButton }, '清除选择'),
        h('span', { style: { color: COLORS.dim } }, `本次：${signedChars(delta)} ｜ 目录变化会在会话里追加 1 份完整目录`),
      );
    }

    /**
     * 工具条（搜索 / 只看非默认 / 统计 / 目录体量 / 默认状态）+ 批量条 + 技能表格。
     *
     * 行的顺序直接来自 host 排好序的 `rows`，本组件只负责按 `(可管理, 来源)` 切分组表头。
     */
    function SkillTable({
      state,
      rows,
      query,
      onQuery,
      onlyProblem,
      onOnlyProblem,
      onApply,
      onApplySkill,
      busy,
      selected,
      onToggle,
      onToggleAll,
      onClearSelection,
      onApplyBatch,
      batchState,
      onBatchState,
      notice,
    }) {
      const totals = state.totals;
      const catalog = state.catalog ?? {};
      const groups = groupRows(rows);
      const selectable = rows.filter((skill) => skill.manageable);
      const allSelected = selectable.length > 0 && selectable.every((skill) => selected.has(skill.name));
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('input', {
            value: query,
            placeholder: '搜索技能…',
            onChange: (event) => onQuery(event.target.value),
            style: { flex: '1 1 220px', minWidth: '180px', padding: '5px 8px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
          }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: COLORS.dim } },
            h('input', { type: 'checkbox', checked: onlyProblem, 'aria-label': '只看非默认项', onChange: (event) => onOnlyProblem(event.target.checked) }),
            '只看非默认项'),
          h('span', { style: { fontSize: '12px', color: COLORS.dim } },
            `共 ${totals.total} 个技能：隐藏 ${totals.hidden}（关闭 ${totals.off}），不可管理 ${totals.unmanageable}`),
          // 目录体量：改动前先让使用者看见"这个工作区每步要广告多少东西"。
          h('span', { style: { fontSize: '12px', color: COLORS.dim }, title: CATALOG_ESTIMATE_HINT },
            `目录 ≈ ${formatChars(catalog.chars ?? 0)} 字符 / ${catalog.entries ?? 0} 条`),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: COLORS.dim } },
            '默认',
            h(
              'select',
              {
                value: state.defaultState,
                onChange: (event) => void onApply('setDefault', { state: event.target.value }),
                style: { padding: '3px 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
              },
              STATE_ORDER.map((value) => h('option', { key: value, value }, STATE_META[value].label)),
            ),
          ),
          busy ? h('span', { style: { fontSize: '11px', color: COLORS.dim } }, '同步中…') : null,
        ),

        selected.size === 0
          ? null
          : h(BatchBar, {
              selected,
              visible: rows.length,
              batchState,
              onBatchState,
              onApply: onApplyBatch,
              onClear: onClearSelection,
              delta: batchDeltaOf(state.skills, selected, batchState),
              busy,
            }),

        notice === undefined ? null : h('div', { style: { fontSize: '11px', color: COLORS.dim } }, notice),

        h(
          'div',
          { style: { border: `1px solid ${COLORS.border}`, borderRadius: '8px', overflow: 'hidden' } },
          // 横向滚动放在圆角容器里侧：外层继续收圆角，滚动条不会顶破边框。
          h('div', { style: { overflowX: 'auto' } },
            h('div', { style: { minWidth: GRID_MIN_WIDTH } },
              h('div', { style: { display: 'grid', gridTemplateColumns: GRID_COLUMNS, gap: '8px', padding: '6px 10px', background: COLORS.layer2, fontSize: '11px', color: COLORS.dim, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: allSelected,
                  disabled: selectable.length === 0,
                  title: '全选 / 取消全选当前筛选内的可管理技能',
                  'aria-label': '全选当前筛选内的可管理技能',
                  onChange: (event) => onToggleAll(event.target.checked),
                  style: { margin: 0, cursor: selectable.length === 0 ? 'not-allowed' : 'pointer' },
                }),
                h('span', null, '技能'),
                h('span', null, '描述与来源'),
                h('span', { style: { textAlign: 'right' } }, '状态')),
              h(
                'div',
                { style: { maxHeight: '46vh', overflow: 'auto' } },
                rows.length === 0
                  ? h('div', { style: { padding: '12px', fontSize: '12px', color: COLORS.dim } }, '没有匹配的技能')
                  : groups.flatMap((group) => [
                      h(
                        'div',
                        {
                          key: group.key,
                          style: { padding: '5px 10px', background: COLORS.layer2, borderTop: `1px solid ${COLORS.border}`, fontSize: '11px', color: COLORS.dim },
                        },
                        `${group.label}（${group.rows.length}）`,
                      ),
                      ...group.rows.map((skill) =>
                        h(SkillRow, {
                          key: skill.name,
                          skill,
                          selected: selected.has(skill.name),
                          onSelect: onToggle,
                          onApply: onApplySkill,
                          busy,
                        })),
                    ]),
              ),
            ),
          ),
        ),
      );
    }

    /** MCP 服务器开关分区。 */
    function McpSection({ mcp, mcpProbe, onApply }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('h4', { style: { margin: 0, fontSize: '13px', color: COLORS.text } }, 'MCP 服务器'),
        mcp.length === 0
          ? h('div', { style: { fontSize: '12px', color: COLORS.dim } }, '没有检测到 MCP 工具（服务器未连接或未配置）')
          : null,
        // 屏蔽效果只有从"该工作区自己的 agent"视角才能核对；没有活动会话时不能拿别的
        // 工作区的 agent 顶替，所以这里明说核对不了，而不是显示一个张冠李戴的数字。
        mcp.length > 0 && mcpProbe === undefined
          ? h('div', { style: { fontSize: '11px', color: COLORS.dim } }, '当前工作区没有活动会话，无法核对屏蔽是否已生效：在该工作区打开一次会话后再看这里')
          : null,
        mcp.map((server) =>
          h('label', { key: server.name, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: COLORS.text } },
            h('input', { type: 'checkbox', checked: server.enabled, onChange: (event) => void onApply('setMcp', { server: server.name, enabled: event.target.checked }) }),
            h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, server.name),
            h('span', { style: { color: COLORS.dim } }, `${server.toolCount} 个工具`),
            server.visibleTools === undefined
              ? null
              : h('span', { style: { color: server.visibleTools === 0 ? COLORS.dim : COLORS.warn, fontSize: '11px' } },
                  server.visibleTools === server.toolCount ? '全部可见' : `可见 ${server.visibleTools}/${server.toolCount}`),
            server.explicit ? null : h('span', { style: { color: COLORS.dim, fontSize: '11px' } }, '（继承默认：启用）')),
        ),
      );
    }

    /** 面板顶部：标题、工作区选择、当前项目根与写入层、各类提示。 */
    function ScopeHeader({ state, workspaces, cwd, onChoose, error }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: '15px', color: COLORS.text } }, '工作区能力'),
          h('span', { style: { fontSize: '12px', color: COLORS.dim } }, '按当前项目目录决定技能是否自动注入、以及哪些 MCP 服务器工具可见')),
        // 生效时机与代价：宿主在每个模型步重算技能目录，变了就**追加**一条带全量
        // <available_skills> 的替代消息（不就地替换）。不写清楚，使用者会以为改配置是零成本的。
        h('div', { style: { fontSize: '11px', color: COLORS.dim } },
          '改动立即生效：本工作区的会话在下一个模型步就会用新目录（无需重启或重开会话）；每次目录变化会在每个受影响会话里追加一份完整目录。'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', color: COLORS.dim } }, '工作区'),
          h(
            'select',
            {
              value: cwd,
              onChange: (event) => onChoose(event.target.value),
              style: { padding: '4px 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
            },
            workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.path }, `${workspace.title} — ${shortenPath(workspace.path)}`)),
          ),
          state?.scope?.projectLayer === true
            ? h('span', { style: { fontSize: '11px', color: COLORS.dim, fontFamily: 'ui-monospace, monospace' } }, shortenPath(state.scope.projectRoot))
            : null,
          h('span', { style: { fontSize: '11px', color: COLORS.dim } },
            // 首帧 state 还没到：只在这个分支兜底 —— 条件用了可选链，两个分支也必须
            // 自己保护，否则 `state.scope.globalPath` 会在首帧抛 TypeError，
            // 被 React 错误边界吞掉后整个设置面板空白，effect 也再没机会补数据。
            state?.scope === undefined
              ? '正在读取配置来源…'
              : state.scope.projectLayer === true
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
    }

    /** 技能表格的一行：勾选 / 名称与元信息 / 描述与来源 / 状态下拉。 */
    function SkillRow({ skill, selected, onSelect, onApply, busy }) {
      const badge = (color) => ({ fontSize: '10px', color, border: `1px solid ${color}`, borderRadius: '4px', padding: '0 4px', whiteSpace: 'nowrap' });
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: GRID_COLUMNS,
            gap: '8px',
            padding: '6px 10px',
            alignItems: 'center',
            borderTop: `1px solid ${COLORS.border}`,
            opacity: skill.manageable ? 1 : 0.6,
          },
        },
        h('input', {
          type: 'checkbox',
          checked: selected,
          disabled: !skill.manageable,
          title: skill.manageable ? `选中 ${skill.name} 以便批量修改` : skill.reason ?? '不可管理',
          'aria-label': `选择技能 ${skill.name}`,
          onChange: (event) => onSelect(skill.name, event.target.checked),
          style: { margin: 0, cursor: skill.manageable ? 'pointer' : 'not-allowed' },
        }),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
            h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: skill.name }, skill.name),
            skill.manageable ? null : h('span', { title: skill.reason ?? '不可管理', style: badge(COLORS.idle) }, '不可管理'),
            // 配置说"不该自动注入"，但注册表此刻仍对模型可见 → 说明 agent 层的降级没生效
            // （分层注册静默失败，或当前会话未绑定 agent preset）。把它显出来，而不是让
            // 用户以为"配置好了"。
            skill.state !== 'pinned' && skill.invocation?.modelInvocable === true && skill.manageable
              ? h('span', {
                  title: '配置已生效于目录降级，但当前会话的注册表仍显示可被模型调用：该会话可能未绑定 agent preset（面板已回退到 preset 作用域）',
                  style: { ...badge(COLORS.warn), cursor: 'help' },
                }, '未生效?')
              : null),
          h('div', { style: { fontSize: '10px', color: COLORS.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            [skill.matchedKey === undefined
              ? '默认'
              : skill.matchedKey === skill.name ? '显式配置' : `命中 ${skill.matchedKey}`,
            readableSize(skill.size)].filter(Boolean).join(' · '))),
        // 描述恒显示 description —— 早先这里是 `reason ?? description`，于是**不可管理技能
        // 永远看不到自己的描述**。原因挪到"不可管理"徽标的 title 上。
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 } },
          h('div', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: DESCRIPTION_MAX_LINES,
              overflow: 'hidden',
              fontSize: '11px',
              lineHeight: 1.45,
              color: COLORS.dim,
            },
            title: skill.description ?? '',
          }, skill.description ?? ''),
          // 来源是不常用信息，放在描述末尾（不单占一列）。**必须是 `flex: 0 0 auto`**：
          // 写成 `0 1 auto` 时它会被按"描述的最大内容宽度"等比压缩，窄列下只剩两三个字符
          // （实测 474px 容器里 72px 宽的 `~/.agents/skills` 被压到 23px）。超长来源由
          // maxWidth + 省略号兜住 —— 两头都不牺牲描述列。
          h(
            'span',
            {
              style: { flex: '0 0 auto', maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '10px', color: COLORS.dim, opacity: 0.85, whiteSpace: 'nowrap' },
              title: `${skill.sourceLabel ?? ''}${skill.path === undefined ? '' : ` — ${skill.path}`}`,
            },
            skill.sourceLabel ?? '',
          )),
        h('div', { style: { minWidth: 0 } },
          h(StateSelect, {
            skill,
            disabled: !skill.manageable || busy === true,
            onChange: (next) => void onApply('setSkill', { name: skill.name, state: next }),
          })),
      );
    }

    /** 从 localStorage 读上次选中的工作区；无痕模式或内容损坏时返回空串。 */
    function readStoredCwd() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) ?? '';
      } catch {
        return '';
      }
    }

    /** 面板数据面：工作区清单、选中 cwd、当前 state、加载/错误/忙碌状态与写操作。 */
    function useWorkspaceScopeData() {
      const [workspaces, setWorkspaces] = useState([]);
      const [cwd, setCwd] = useState(readStoredCwd);
      const [state, setState] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [busy, setBusy] = useState(false);

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
            const stored = readStoredCwd();
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

      const choose = useCallback((path) => {
        setCwd(path);
        try {
          window.localStorage.setItem(STORAGE_KEY, path);
        } catch {
          /* 无痕模式下 localStorage 不可写，忽略 */
        }
        void refresh(path);
      }, [refresh]);

      /**
       * 写一个 RPC 并刷新面板。
       * @returns 成功时返回 RPC 的返回值（批量写盘要拿 `applied`/`skipped` 回执），
       *   失败时返回 `undefined` 并把消息放进 `error`。
       */
      const apply = useCallback(async (method, args) => {
        setBusy(true);
        setError(undefined);
        try {
          const value = await rpc(method, { cwd, ...args });
          await refresh(cwd);
          return value;
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setBusy(false);
          return undefined;
        }
      }, [cwd, refresh]);

      return { workspaces, cwd, state, error, busy, choose, apply };
    }

    /** 设置页里的"工作区能力"一节。 */
    function WorkspaceScopeSection() {
      const { workspaces, cwd, state, error, busy, choose, apply } = useWorkspaceScopeData();
      const [query, setQuery] = useState('');
      const [onlyProblem, setOnlyProblem] = useState(false);
      /** 勾选集：技能名 → 选中。跨搜索/筛选保留，切换工作区与写盘成功后清空。 */
      const [selected, setSelected] = useState(() => new Set());
      const [batchState, setBatchState] = useState('manual');
      const [notice, setNotice] = useState(undefined);

      const rows = useMemo(() => {
        const all = state?.skills ?? [];
        const needle = query.trim().toLowerCase();
        return all.filter((skill) => {
          if (onlyProblem && skill.manageable && skill.state === 'pinned') return false;
          if (needle === '') return true;
          return `${skill.name} ${skill.description ?? ''} ${skill.sourceLabel ?? ''}`.toLowerCase().includes(needle);
        });
      }, [state, query, onlyProblem]);

      // 切工作区必须清空勾选：选中集是按名字记的，换了目录之后这些名字属于**另一个**
      // 工作区的配置，留着会让"应用"改到看不见的行。
      const chooseWorkspace = useCallback((path) => {
        setSelected(new Set());
        setNotice(undefined);
        choose(path);
      }, [choose]);

      const toggleRow = useCallback((name, checked) => {
        setSelected((previous) => {
          const next = new Set(previous);
          if (checked) next.add(name);
          else next.delete(name);
          return next;
        });
      }, []);

      const toggleAll = useCallback((checked) => {
        setSelected((previous) => {
          const next = new Set(previous);
          for (const skill of rows) {
            if (!skill.manageable) continue;
            if (checked) next.add(skill.name);
            else next.delete(skill.name);
          }
          return next;
        });
      }, [rows]);

      const clearSelection = useCallback(() => {
        setSelected(new Set());
        setNotice(undefined);
      }, []);

      /**
       * 技能写操作（单行下拉 / 批量）：成功后清空勾选。
       *
       * 单行与批量共用同一条出口：写盘之后表格会重排，留着旧勾选会让下一次"应用"改到
       * 使用者已经忘记的行。`setDefault` / `setMcp` 不走这里 —— 它们与勾选无关。
       */
      const applySkill = useCallback(async (method, args) => {
        const result = await apply(method, args);
        if (result !== undefined) setSelected(new Set());
        return result;
      }, [apply]);

      /** 批量写盘：一次 RPC 改完所有选中项，成功后清空勾选并回报跳过原因。 */
      const applyBatch = useCallback(async (target) => {
        const names = [...selected];
        if (names.length === 0) return;
        const result = await applySkill('setSkills', { names, state: target });
        if (result === undefined) return;
        const skipped = result.skipped ?? [];
        const applied = result.applied ?? [];
        // 三种情形必须分开说：改成了、什么都没改、以及"全部被跳过"——最后一种若沿用
        // "已经是目标状态"的文案，会和紧随其后的跳过明细自相矛盾。
        const head = applied.length > 0
          ? `已改 ${applied.length} 项`
          : skipped.length > 0 ? '未做任何改动' : '所选技能已经是目标状态，未写盘';
        setNotice(skipped.length === 0 ? head : `${head}；跳过 ${skipped.length} 项：${skipped.map((item) => `${item.name}（${item.reason}）`).join('、')}`);
      }, [applySkill, selected]);

      const header = h(ScopeHeader, { state, workspaces, cwd, onChoose: chooseWorkspace, error });

      if (state === undefined) {
        return h('div', { style: { padding: '4px 0', display: 'flex', flexDirection: 'column', gap: '12px' } }, header, h('div', { style: { fontSize: '12px', color: COLORS.dim } }, busy ? '加载中…' : '暂无数据'));
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' } },
        header,

        h(SkillTable, {
          state,
          rows,
          query,
          onQuery: setQuery,
          onlyProblem,
          onOnlyProblem: setOnlyProblem,
          onApply: apply,
          onApplySkill: applySkill,
          busy,
          selected,
          onToggle: toggleRow,
          onToggleAll: toggleAll,
          onClearSelection: clearSelection,
          onApplyBatch: applyBatch,
          batchState,
          onBatchState: setBatchState,
          notice,
        }),

        h(McpSection, { mcp: state.mcp, mcpProbe: state.mcpProbe, onApply: apply }),
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
    exports.__logic = { insertSkill, shortenPath, readableSize, STATE_META, formatChars, signedChars, groupRows, batchDeltaOf, CLEAR_VALUE, GRID_COLUMNS, GRID_MIN_WIDTH };
    return module.exports;
  },
});
