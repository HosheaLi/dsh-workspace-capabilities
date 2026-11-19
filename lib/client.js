/**
 * dsh-workspace-capabilities —— client 半边（浏览器）。
 *
 * 手写的 bundle：不需要复刻仓库内的 tsdown `clientBundle` 构建链，官方
 * `dsh-client-ui-skill` 与三个社区包的产物完全同形 ——
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内只 `require` 平台种子。
 *
 * 两个落点：
 *  1. 设置页 `settings.section`：配置区（工作区/默认状态/写入层）、技能表格（名称/来源/
 *     描述/三态/可管理标记）、搜索与统计胶囊、MCP 服务器开关。**状态一律来自本插件
 *     配置文件**，不读注册表返回的 invocation —— 冷读路径用的是 preset 作用域，看不到
 *     agent 层的降级，会把 manual/off 显示成启用态。
 *  2. 输入框右侧 `conversation.input.right`：搜索 + 点选 → `inputActions.setDraft()`
 *     插入 `/名 `，随后回焦。
 *
 * 数据面：`POST /api/workspace-scope/rpc`（host 侧挂在官方守好的 `/api` 下，
 * 鉴权与 Host/Origin 栅栏由 Connection 负责）。
 *
 * ponytail: 单文件手写 bundle（1500+ 行，越过"文件 < 800 行"的常规上限）。拆包要引入
 * 构建链，而 client 半边刻意只依赖 `react` 这个平台种子；真正该拆的触发条件是出现跨插件
 * 复用组件的需求（届时构建链才有第二个消费者）。行数只作提醒：本轮调整后约 1511 行，
 * 继续单文件直到那个需求出现，不再按行数硬拆。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-capabilities',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    /** RPC 路径必须与 host 半边的 `RPC_PATH` 一致。 */
    const RPC_PATH = '/api/workspace-scope/rpc';
    const STORAGE_KEY = 'dsh-workspace-capabilities.cwd';

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
      // 原生设置页的分区简介用 tertiary；面板页头与它对齐。
      tertiary: 'var(--dsw-alias-label-tertiary)',
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
     * 技能表格的列模板：`勾选 / 技能 / 来源 / 描述 / 状态`。
     *
     * 来源从描述单元格里独立成一列：两者原本挤在一起，来源标签被读成描述的一部分，
     * 描述截断后也没有稳定的位置。独立成列后每列职责单一。
     *
     * 去掉描述后的「展开」入口后，单元格不再为那个文字预留 22px，列上限整体收窄一档：
     * 描述优先拿剩余宽度，技能名与来源只保留可读的下限。每列都必须有下限 —— 描述单元格
     * 带 `overflow:hidden`，这类元素的自动最小尺寸是 0；裸 `1fr` 会被压成 0 宽。
     */
    const GRID_COLUMNS = '24px minmax(132px, 184px) minmax(92px, 112px) minmax(164px, 1fr) 96px';
    /**
     * 表格的最小总宽：五个列下限之和 + 4 个 8px 间距 + 左右 padding 20px = 560px。
     * 设置面板内容列约 564px（800px 面板 − 188px 导航 − 48px padding），所以日常宽度
     * 不触发横向滚动；低于 560px 才在表格里横向滚动。
     */
    const GRID_MIN_WIDTH = '560px';

    /** 状态下拉的"删除显式配置"伪值：它不是状态，是一个动作，所以不进 STATE_META。 */
    const CLEAR_VALUE = '__clear__';

    /** 描述列最多显示几行（超出用省略号）。 */
    const DESCRIPTION_MAX_LINES = 2;

    /** 目录体量估算的说明文案：字符数是复刻宿主规则算出来的，不是真实 token 数。 */
    const CATALOG_ESTIMATE_HINT = '按宿主渲染规则估算的字符数（`- `name`: description`，描述空白折叠、超 500 字符截断）。token 数因语言而异：英文约 3.8 字符/token，中文约 1.6 字符/token。';

    /** 顶部信息说明浮层的尺寸预算：宽度、最小宽度、视口边距、向下预留高度。 */
    const INFO_TIP_WIDTH = 360;
    const INFO_TIP_MIN_WIDTH = 180;
    const INFO_TIP_MARGIN = 12;
    const INFO_TIP_VERTICAL_RESERVE = 240;

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
            opacity: disabled ? 0.75 : 1,
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
     * 面板顶部的三态计数 + 不可管理数。
     *
     * 只把**可管理**技能算进三态：bundled/runtime 的正文不在磁盘上，配置对它们无效，
     * 算进"关闭/自动注入"只会让数字虚高（与 host 的 `totals` 同一口径）。
     *
     * 输入必须是**全量** `state.skills` 而不是筛选后的 rows —— 否则搜索一下数字就变了，
     * 使用者会把它当成真实配置在变化。
     * @param skills - host `state` 返回的技能行。
     * @returns `{ total, pinned, manual, off, unmanageable }`。
     */
    function stateCountsOf(skills) {
      const counts = { total: 0, pinned: 0, manual: 0, off: 0, unmanageable: 0 };
      for (const skill of skills) {
        counts.total += 1;
        if (!skill.manageable) {
          counts.unmanageable += 1;
          continue;
        }
        if (skill.state === 'pinned') counts.pinned += 1;
        else if (skill.state === 'manual') counts.manual += 1;
        else if (skill.state === 'off') counts.off += 1;
      }
      return counts;
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
            flexDirection: 'column',
            gap: '8px',
            padding: '8px 10px',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            background: COLORS.layer2,
            fontSize: '12px',
          },
        },
        // 第一行：选中数量 + 目标状态。
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { color: COLORS.text, fontWeight: 500 } }, `已选 ${selected.size} 项（当前筛选 ${visible} 项）`),
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
          )),
        // 第二行：本次动作对目录体量的影响。左对齐，不再用 marginLeft:auto 顶到右边。
        h('span', { style: { color: COLORS.dim } }, `本次：${signedChars(delta)} ｜ 目录变化会在会话里追加 1 份完整目录`),
        // 第三行：三个操作按钮固定在批量条最下方。
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => onApply(batchState),
              style: { padding: '3px 12px', borderRadius: '6px', border: `1px solid ${COLORS.accent}`, background: 'transparent', color: COLORS.accent, cursor: busy ? 'not-allowed' : 'pointer', font: 'inherit', fontSize: '12px', fontWeight: 500, opacity: busy ? 0.5 : 1 },
            },
            '应用',
          ),
          h('button', { type: 'button', disabled: busy, title: '删除这些技能在写入层的显式配置（键在另一层的会被跳过并回报）', onClick: () => onApply('default'), style: plainButton }, '恢复默认'),
          h('button', { type: 'button', disabled: busy, onClick: onClear, style: plainButton }, '清除选择')),
      );
    }

    /** 统计胶囊：一行小字，数值用主文字色，避免整条统计变成一串灰字。 */
    function StatChip({ label, value, tone, title }) {
      return h(
        'span',
        {
          title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '999px',
            border: `1px solid ${COLORS.border}`,
            background: COLORS.layer2,
            fontSize: '11px',
            color: COLORS.dim,
            whiteSpace: 'nowrap',
          },
        },
        label,
        h('span', { style: { color: tone ?? COLORS.text, fontWeight: 500, fontVariantNumeric: 'tabular-nums' } }, String(value)),
      );
    }

    /**
     * 工具条（统计 / 目录体量 / 搜索）+ 批量条 + 技能表格。
     *
     * 自上而下：目录体量一行纯文本 → 三态统计胶囊（左对齐）→ 搜索与筛选 → 表格。
     * 搜索靠近表格，统计靠近页头；目录体量不再是胶囊，避免一行里塞两种视觉语法。
     * 可管理行按 host 顺序直接铺开，不可管理行单独收进末尾的折叠分组。
     */
    function SkillTable({
      state,
      rows,
      query,
      onQuery,
      onlyProblem,
      onOnlyProblem,
      onClearFilters,
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
      showUnmanageable,
      onToggleUnmanageable,
      tip,
      onShowTip,
      onHideTip,
      onClearTip,
      onCancelHideTip,
      onMouseLeaveTip,
    }) {
      const counts = stateCountsOf(state.skills ?? []);
      const catalog = state.catalog ?? {};
      const manageableRows = rows.filter((skill) => skill.manageable);
      const unmanageableRows = rows.filter((skill) => !skill.manageable);
      const allSelected = manageableRows.length > 0 && manageableRows.every((skill) => selected.has(skill.name));
      const filtersActive = query.trim() !== '' || onlyProblem;
      // 表格可视高度是 46vh；行内上下 padding 收紧后按 ~42px 行高估算"一屏能放几行"。
      const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 900;
      const visibleRows = Math.max(1, Math.floor((viewportHeight * 0.46) / 42));
      // 折叠分组只占一条组头；展开后才把组内行算进可视行数。
      const displayedRows = manageableRows.length
        + (unmanageableRows.length > 0 ? 1 : 0)
        + (showUnmanageable ? unmanageableRows.length : 0);
      const needsScrollHint = displayedRows > visibleRows;
      const collapsedNote = unmanageableRows.length > 0 && !showUnmanageable
        ? `（不可管理 ${unmanageableRows.length} 项已折叠）`
        : '';
      /** 可管理行与不可管理行渲染同一种行组件，避免两处各抄一份 props。 */
      const skillRowOf = (skill) => h(SkillRow, {
        key: skill.name,
        skill,
        selected: selected.has(skill.name),
        onSelect: onToggle,
        onApply: onApplySkill,
        busy,
        onShowTip,
        onHideTip,
      });
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        // 目录体量：仍是估算值，但不再用胶囊，单独占统计上一行。
        h('div', {
          title: CATALOG_ESTIMATE_HINT,
          style: { fontSize: '11px', lineHeight: 1.5, color: COLORS.dim },
        }, `目录 ≈ ${formatChars(catalog.chars ?? 0)} 字符 / ${catalog.entries ?? 0} 条`),
        // 统计区：技能总数 → 三态 → 不可管理，左对齐。
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          h(StatChip, { label: '技能', value: counts.total }),
          h(StatChip, { label: '自动注入', value: counts.pinned, tone: STATE_META.pinned.color }),
          h(StatChip, { label: '仅手动', value: counts.manual, tone: STATE_META.manual.color }),
          h(StatChip, { label: '关闭', value: counts.off, tone: STATE_META.off.color }),
          h(StatChip, { label: '不可管理', value: counts.unmanageable }),
          busy ? h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: COLORS.dim } }, '同步中…') : null,
        ),
        // 搜索靠近表格；只看非默认项跟着搜索走。
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('input', {
            value: query,
            placeholder: '搜索技能…',
            'aria-label': '搜索技能',
            onChange: (event) => onQuery(event.target.value),
            style: { flex: '0 1 360px', minWidth: '160px', height: '30px', boxSizing: 'border-box', padding: '0 10px', borderRadius: '8px', border: `1px solid ${COLORS.border}`, background: COLORS.layer2, color: COLORS.text, font: 'inherit', fontSize: '12px' },
          }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: COLORS.dim, whiteSpace: 'nowrap', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: onlyProblem, 'aria-label': '只看非默认项', onChange: (event) => onOnlyProblem(event.target.checked) }),
            '只看非默认项'),
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
          { style: { border: `1px solid ${COLORS.border}`, borderRadius: '10px', overflow: 'hidden', background: COLORS.layer } },
          // 横向滚动放在圆角容器里侧：外层继续收圆角，滚动条不会顶破边框。
          h('div', { style: { overflowX: 'auto' }, onScroll: onClearTip },
            h('div', { style: { minWidth: GRID_MIN_WIDTH } },
              h('div', { style: { display: 'grid', gridTemplateColumns: GRID_COLUMNS, gap: '8px', padding: '6px 10px', background: COLORS.layer2, fontSize: '11px', color: COLORS.dim, fontWeight: 500, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: allSelected,
                  disabled: manageableRows.length === 0,
                  title: '全选 / 取消全选当前筛选内的可管理技能',
                  'aria-label': '全选当前筛选内的可管理技能',
                  onChange: (event) => onToggleAll(event.target.checked),
                  style: { margin: 0, cursor: manageableRows.length === 0 ? 'not-allowed' : 'pointer' },
                }),
                h('span', null, '技能'),
                h('span', null, '来源'),
                h('span', null, '描述'),
                h('span', null, '状态')),
              h(
                'div',
                { style: { maxHeight: '46vh', overflow: 'auto' }, onScroll: onClearTip },
                rows.length === 0
                  ? h('div', { style: { padding: '32px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', fontSize: '12px', color: COLORS.dim } },
                      h('span', null, '没有匹配的技能'),
                      filtersActive
                        ? h('button', { type: 'button', onClick: onClearFilters, style: { border: `1px solid ${COLORS.border}`, borderRadius: '6px', background: 'transparent', color: COLORS.dim, cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: '3px 10px' } }, '清除筛选')
                        : null)
                  : [
                      ...manageableRows.map(skillRowOf),
                      // 不可管理项独立分组：默认折叠，组头把数量与原因一句话说清。
                      unmanageableRows.length === 0
                        ? null
                        : h('div', { key: '__unmanageable__', style: { borderTop: `1px solid ${COLORS.border}` } },
                            h('button', {
                              type: 'button',
                              'aria-expanded': showUnmanageable,
                              'aria-controls': 'workspace-scope-unmanageable',
                              onClick: onToggleUnmanageable,
                              style: {
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                width: '100%',
                                padding: '6px 10px',
                                border: 'none',
                                background: 'transparent',
                                color: COLORS.dim,
                                font: 'inherit',
                                fontSize: '11px',
                                textAlign: 'left',
                                cursor: 'pointer',
                              },
                            },
                              h('span', { 'aria-hidden': 'true', style: { display: 'inline-block', width: '10px' } }, showUnmanageable ? '▾' : '▸'),
                              h('span', { style: { color: COLORS.text, fontWeight: 500 } }, `不可管理 ${unmanageableRows.length} 项`),
                              h('span', null, '正文不在磁盘上，配置对它无效')),
                            // 受控区域始终存在，折叠时为空：aria-controls 不会指向一个不存在的 id。
                            h('div', { id: 'workspace-scope-unmanageable' },
                              showUnmanageable ? unmanageableRows.map(skillRowOf) : null),
                          ),
                    ],
              ),
            ),
          ),
          // 面板内滚动没有常驻滚动条（macOS 的 overlay 滚动条默认隐藏），不提示的话
          // 表格看起来像在十几行处"结束"了。按 46vh 估算一屏行数，溢出时才提示。
          needsScrollHint
            ? h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '5px 10px', borderTop: `1px solid ${COLORS.border}`, background: COLORS.layer2, fontSize: '11px', color: COLORS.dim } },
                h('span', null, `当前筛选 ${rows.length} 项${collapsedNote}`),
                h('span', null, '表格内可滚动查看全部'))
            : null,
        ),

        tip === undefined ? null : h(DescriptionTooltip, { tip, onMouseEnter: onCancelHideTip, onMouseLeave: onMouseLeaveTip }),
      );
    }

    /** MCP 服务器开关分区。 */
    function McpSection({ mcp, mcpProbe, onApply }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', borderTop: `1px solid ${COLORS.border}`, paddingTop: '14px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('h4', { style: { margin: 0, fontSize: '13px', fontWeight: 600, color: COLORS.text } }, 'MCP 服务器'),
          h('span', { style: { fontSize: '11px', color: COLORS.dim } }, '关闭后从工具 schema 与 server instructions 里屏蔽；进程仍由宿主启动')),
        mcp.length === 0
          ? h('div', { style: { fontSize: '12px', color: COLORS.dim } }, '没有检测到 MCP 工具（服务器未连接或未配置）')
          : null,
        // 屏蔽效果只有从"该工作区自己的 agent"视角才能核对；没有活动会话时不能拿别的
        // 工作区的 agent 顶替，所以这里明说核对不了，而不是显示一个张冠李戴的数字。
        mcp.length > 0 && mcpProbe === undefined
          ? h('div', { style: { fontSize: '11px', color: COLORS.dim } }, '当前工作区没有活动会话，无法核对屏蔽是否已生效：在该工作区打开一次会话后再看这里')
          : null,
        mcp.map((server) =>
          h('label', { key: server.name, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: COLORS.text, cursor: 'pointer' } },
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

    /**
     * 面板顶部：标题、生效说明、工作区 / 默认状态配置行、各类提示。
     *
     * 标题与简介都独立成行、字号对齐原生设置页分区（18px / 13px）。配置区改成两行：
     * 工作区一行、默认状态一行；路径与写入层不再常驻，收进工作区下拉右侧的信息图标。
     */
    function ScopeHeader({ state, workspaces, cwd, onChoose, onDefault, error, infoTip, onInfoEnter, onInfoLeave }) {
      const scope = state?.scope;
      // 首帧 state 还没到：只在这个分支兜底 —— 条件用了可选链，两个分支也必须自己保护，
      // 否则 `scope.projectPath` 会在首帧抛 TypeError，被 React 错误边界吞掉后整个设置面板空白。
      const writeLayerLabel = scope === undefined
        ? '正在读取配置来源…'
        : scope.projectLayer === true ? '写入项目层' : '写入全局层';
      const writeLayerPath = scope === undefined
        ? ''
        : scope.projectLayer === true ? scope.projectPath : scope.globalPath;
      const workspacePath = typeof scope?.cwd === 'string' && scope.cwd !== '' ? scope.cwd : cwd;
      const fieldLabel = { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: COLORS.dim, whiteSpace: 'nowrap' };
      const fieldSelect = { height: '28px', padding: '0 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`, background: COLORS.layer, color: COLORS.text, font: 'inherit', fontSize: '12px', cursor: 'pointer' };
      const infoButton = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '16px',
        height: '16px',
        padding: 0,
        borderRadius: '50%',
        border: `1px solid ${COLORS.borderStrong}`,
        background: 'transparent',
        color: COLORS.dim,
        font: 'inherit',
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: 1,
        cursor: 'help',
      };
      // 设置面板的内容列只有 ~588px，绝对定位的 tooltip 会被面板的 overflow:hidden 裁掉。
      // 改成 fixed + 视口坐标（与描述浮层同一套做法），坐标由面板在 hover/focus 时算好。
      const tipBox = {
        position: 'fixed',
        left: `${infoTip?.left ?? INFO_TIP_MARGIN}px`,
        top: `${infoTip?.top ?? INFO_TIP_MARGIN}px`,
        width: `${infoTip?.width ?? INFO_TIP_WIDTH}px`,
        maxHeight: 'min(320px, 55vh)',
        overflow: 'auto',
        boxSizing: 'border-box',
        padding: '9px 11px',
        borderRadius: '8px',
        border: `1px solid ${COLORS.borderStrong}`,
        background: COLORS.layer,
        boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
        fontSize: '11px',
        lineHeight: 1.55,
        color: COLORS.text,
        textAlign: 'left',
        whiteSpace: 'normal',
        zIndex: 90,
        // 说明只读；不让它挡住下方的下拉与工具栏，鼠标停在图标上就能读完。
        pointerEvents: 'none',
      };
      const tipTitle = { fontSize: '11px', fontWeight: 600, color: COLORS.text };
      const tipMono = { fontFamily: 'ui-monospace, monospace', fontSize: '10px', lineHeight: 1.5, color: COLORS.dim, wordBreak: 'break-all' };
      const tipSection = { display: 'flex', flexDirection: 'column', gap: '1px', marginTop: '6px' };
      const tipContent = (kind) => {
        if (kind === 'workspace') {
          // 首帧还没有 scope：只说"正在读取"，不拿空字符串拼出一组标题。
          if (scope === undefined) return [h('div', { key: 'loading', style: tipTitle }, writeLayerLabel)];
          return [
            h('div', { key: 'path-title', style: tipTitle }, '工作区路径'),
            h('div', { key: 'path', style: tipMono }, workspacePath === '' ? '—' : workspacePath),
            scope?.projectRoot !== undefined && scope.projectRoot !== workspacePath
              ? h('div', { key: 'root', style: tipSection },
                  h('div', { style: tipTitle }, '项目根'),
                  h('div', { style: tipMono }, scope.projectRoot))
              : null,
            h('div', { key: 'layer', style: tipSection },
              h('div', { style: tipTitle }, writeLayerLabel),
              h('div', { style: tipMono }, writeLayerPath === '' ? '正在读取配置来源…' : writeLayerPath)),
          ];
        }
        return [
          h('div', { key: 'title', style: { ...tipTitle, marginBottom: '3px' } }, '默认状态（未显式配置的技能）'),
          ...STATE_ORDER.map((value) => h('div', { key: value },
            h('span', { style: { color: STATE_META[value].color, fontWeight: 500 } }, STATE_META[value].label),
            '：',
            h('span', { style: { color: COLORS.dim } }, STATE_META[value].hint))),
        ];
      };
      /** 一个信息图标；说明浮层由面板按视口坐标统一渲染，避免被设置面板裁切。 */
      const infoIcon = (kind, label) => h('button', {
        type: 'button',
        'aria-label': label,
        'aria-describedby': infoTip?.kind === kind ? 'workspace-scope-info-tip' : undefined,
        onMouseEnter: (event) => onInfoEnter(kind, event),
        onMouseLeave: () => onInfoLeave(kind),
        onFocus: (event) => onInfoEnter(kind, event),
        onBlur: () => onInfoLeave(kind),
        style: infoButton,
      }, 'i');
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600, color: COLORS.text } }, '工作区能力'),
          h('p', { style: { margin: 0, fontSize: '13px', color: COLORS.tertiary } }, '按当前项目目录决定技能是否自动注入、以及哪些 MCP 服务器工具可见')),
        // 生效时机与代价：宿主在每个模型步重算技能目录，变了就**追加**一条带全量
        // <available_skills> 的替代消息（不就地替换）。不写清楚，使用者会以为改配置是零成本的。
        h('div', { style: { fontSize: '11px', color: COLORS.dim, lineHeight: 1.55 } },
          '改动立即生效：本工作区的会话在下一个模型步就会用新目录（无需重启或重开会话）；每次目录变化会在每个受影响会话里追加一份完整目录。'),
        // 配置区：工作区 / 默认状态各占一行。写入层与完整路径收进工作区右侧的信息图标，
        // 默认状态的定义也走同一套图标，避免常驻一段解释性长文案。
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '9px 12px', border: `1px solid ${COLORS.border}`, borderRadius: '8px', background: COLORS.layer2 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('label', { style: fieldLabel },
              '工作区',
              h('select', {
                value: cwd,
                'aria-label': '选择工作区',
                onChange: (event) => onChoose(event.target.value),
                style: { ...fieldSelect, maxWidth: '340px' },
              },
              // 只显示名称：路径与写入层是低频上下文，默认收进右侧信息图标。
              workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.path }, workspace.title || shortenPath(workspace.path))))),
            infoIcon('workspace', '工作区路径与写入层信息')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('label', { style: fieldLabel },
              '默认状态',
              h('select', {
                value: state?.defaultState ?? 'pinned',
                disabled: state === undefined,
                title: '未显式配置的技能默认落到的状态',
                'aria-label': '默认状态',
                onChange: (event) => void onDefault(event.target.value),
                style: { ...fieldSelect, opacity: state === undefined ? 0.6 : 1 },
              },
              STATE_ORDER.map((value) => h('option', { key: value, value }, STATE_META[value].label)))),
            infoIcon('default', '默认状态说明')),
        ),
        state?.scope?.notice !== undefined ? h('div', { style: { fontSize: '11px', color: COLORS.warn } }, state.scope.notice) : null,
        state?.catalog?.notice !== undefined ? h('div', { style: { fontSize: '11px', color: COLORS.dim } }, state.catalog.notice) : null,
        state?.scope?.readError === undefined
          ? null
          : h('div', { style: { fontSize: '11px', color: COLORS.error } }, `配置文件有问题：${state.scope.readError}`),
        error !== undefined ? h('div', { style: { fontSize: '12px', color: COLORS.error } }, error) : null,
        infoTip === undefined ? null : h('div', { role: 'tooltip', id: 'workspace-scope-info-tip', style: tipBox }, tipContent(infoTip.kind)),
      );
    }

    /** 来源胶囊的固定样式（每行共用，避免每次渲染新建对象）。 */
    const SOURCE_CHIP = {
      display: 'inline-block',
      maxWidth: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      padding: '1px 6px',
      borderRadius: '4px',
      border: `1px solid ${COLORS.border}`,
      background: COLORS.layer,
      color: COLORS.dim,
      fontSize: '10px',
      lineHeight: '16px',
    };

    /**
     * 描述单元格：默认 2 行截断，hover 400ms 弹完整描述与来源路径。
     *
     * 不再提供「展开 / 收起」：右上角那个入口既占宽度又让表格多一层状态，而描述全文
     * 已经由 hover 浮层稳定给出。单元格保持纯展示，浮层状态提到面板顶层 —— 行组件无
     * 状态，列表滚动时不会因为每行各持一份 hover 状态而互相干扰。
     */
    function DescriptionCell({ skill, onShowTip, onHideTip }) {
      const description = skill.description ?? '';
      return h(
        'div',
        {
          style: { position: 'relative', minWidth: 0 },
          onMouseEnter: (event) => onShowTip(skill, event),
          onMouseLeave: onHideTip,
        },
        h(
          'div',
          {
            style: {
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: DESCRIPTION_MAX_LINES,
              overflow: 'hidden',
              // 短描述也占满两行高度：表格行高一致，扫读时不会一跳一跳。
              minHeight: '31px',
              fontSize: '11px',
              lineHeight: 1.4,
              color: COLORS.dim,
            },
          },
          description === '' ? '（无描述）' : description,
        ),
      );
    }

    /**
     * 描述浮层：全量描述 + 来源路径。定位与内容都由顶层状态驱动，同一时刻只会有一个。
     *
     * 浮层本身可交互：鼠标进入会取消 140ms 的关闭计时器，于是长描述能在浮层里滚动、
     * 也能选中复制；离开浮层再按计时器关闭。
     */
    function DescriptionTooltip({ tip, onMouseEnter, onMouseLeave }) {
      const description = tip.skill.description ?? '';
      const sourceLine = [tip.skill.sourceLabel, tip.skill.path].filter(Boolean).join(' — ');
      return h(
        'div',
        {
          role: 'tooltip',
          id: 'workspace-scope-desc-tip',
          onMouseEnter,
          onMouseLeave,
          style: {
            position: 'fixed',
            left: `${tip.left}px`,
            top: `${tip.top}px`,
            width: `${tip.width}px`,
            maxHeight: 'min(320px, 55vh)',
            overflow: 'auto',
            padding: '10px 12px',
            boxSizing: 'border-box',
            background: COLORS.layer,
            border: `1px solid ${COLORS.borderStrong}`,
            borderRadius: '8px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
            zIndex: 90,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          },
        },
        h('div', { style: { fontSize: '12px', lineHeight: 1.55, color: COLORS.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, description === '' ? '（无描述）' : description),
        sourceLine === ''
          ? null
          : h('div', { style: { fontSize: '10px', fontFamily: 'ui-monospace, monospace', color: COLORS.dim, wordBreak: 'break-all' } }, sourceLine),
      );
    }

    /** 技能表格的一行：勾选 / 名称与元信息 / 来源 / 描述 / 状态下拉。 */
    function SkillRow({ skill, selected, onSelect, onApply, busy, onShowTip, onHideTip }) {
      const badge = (color) => ({ fontSize: '10px', color, border: `1px solid ${color}`, borderRadius: '4px', padding: '0 4px', whiteSpace: 'nowrap' });
      return h(
        'div',
        {
          // hover 背景直接写 DOM style 而不是 state：40 行各持一份 hover 状态会让整张表
          // 在鼠标扫过时逐行重渲染，收益只有一条背景色。
          onMouseEnter: (event) => { event.currentTarget.style.background = COLORS.layer2; },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent'; },
          style: {
            display: 'grid',
            gridTemplateColumns: GRID_COLUMNS,
            gap: '8px',
            // 描述不再需要给「展开」留位置，行内上下 padding 收一档，一屏能多放半行。
            padding: '6px 10px',
            alignItems: 'center',
            borderTop: `1px solid ${COLORS.border}`,
            transition: 'background 120ms',
            opacity: skill.manageable ? 1 : 0.62,
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
        // 来源独立成列：它是技能的属性，不是描述的一部分。完整路径放 title，避免长来源挤掉描述。
        h('div', { style: { minWidth: 0 } },
          h('span', {
            style: SOURCE_CHIP,
            title: `${skill.sourceLabel ?? '未知来源'}${skill.path === undefined ? '' : ` — ${skill.path}`}`,
          }, skill.sourceLabel ?? '未知来源')),
        // 描述恒显示 description —— 早先这里是 `reason ?? description`，于是**不可管理技能
        // 永远看不到自己的描述**。原因挪到"不可管理"徽标的 title 上。
        h(DescriptionCell, {
          skill,
          onShowTip,
          onHideTip,
        }),
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
      /** 顶部信息图标的当前说明：`{ kind, left, top, width } | undefined`。 */
      const [infoTip, setInfoTip] = useState(undefined);
      /** 说明浮层的锚点（信息图标），滚动时据此重新定位而不是直接关掉。 */
      const infoAnchorRef = useRef(undefined);
      /** 不可管理分组默认折叠：它们的正文不在磁盘上，日常操作不需要展开。 */
      const [showUnmanageable, setShowUnmanageable] = useState(false);
      /** hover 浮层：`{ skill, left, top, width }`，同一时刻只有一个。 */
      const [tip, setTip] = useState(undefined);
      const tipTimerRef = useRef(undefined);
      /** 鼠标从描述移到浮层上时的延迟关闭计时器（跨过 8px 间隙不被误关）。 */
      const closeTimerRef = useRef(undefined);

      const cancelHideTip = useCallback(() => {
        if (closeTimerRef.current !== undefined) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;
      }, []);

      /** 立即清掉浮层与两个计时器：滚动、筛选、切换工作区、卸载时用。 */
      const clearTip = useCallback(() => {
        cancelHideTip();
        if (tipTimerRef.current !== undefined) clearTimeout(tipTimerRef.current);
        tipTimerRef.current = undefined;
        setTip(undefined);
      }, [cancelHideTip]);

      /** 延迟关闭：鼠标进入浮层会取消它，这样浮层里的长描述可以滚动、可以选中复制。 */
      const scheduleHideTip = useCallback(() => {
        cancelHideTip();
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = undefined;
          setTip(undefined);
        }, 140);
      }, [cancelHideTip]);

      // 组件卸载时清掉未到期的计时器，避免在已卸载的树上 setState。
      useEffect(() => () => {
        if (tipTimerRef.current !== undefined) clearTimeout(tipTimerRef.current);
        if (closeTimerRef.current !== undefined) clearTimeout(closeTimerRef.current);
      }, []);

      /** hover 400ms 后才出浮层：扫过整张表时不至于每行都闪一下。 */
      const showTipFor = useCallback((skill, event) => {
        const rect = event?.currentTarget?.getBoundingClientRect?.();
        if (rect === undefined) return;
        cancelHideTip();
        if (tipTimerRef.current !== undefined) clearTimeout(tipTimerRef.current);
        tipTimerRef.current = setTimeout(() => {
          const width = 420;
          const margin = 12;
          const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1280;
          const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 800;
          const left = Math.max(margin, Math.min(rect.left ?? margin, viewportWidth - width - margin));
          const top = Math.max(margin, Math.min((rect.bottom ?? 0) + 8, viewportHeight - 340));
          setTip({ skill, left, top, width: Math.min(width, viewportWidth - margin * 2) });
        }, 400);
      }, [cancelHideTip]);

      /**
       * 说明浮层的视口坐标。
       *
       * 设置面板的内容列窄、外层还是 `overflow:hidden`，所以浮层用 fixed + 视口坐标，
       * 并把坐标夹在视口内；图标在窄面板里靠右时也不会被裁掉。
       */
      const infoPositionOf = useCallback((rect, width) => {
        const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1280;
        const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 800;
        const margin = INFO_TIP_MARGIN;
        // 以图标中心对齐浮层中心：工作区图标在窄面板里靠右时向左展开，不会被裁切。
        const anchorX = rect === undefined ? margin : (rect.left ?? margin) + (rect.width ?? 0) / 2;
        const left = Math.max(margin, Math.min(anchorX - width / 2, viewportWidth - width - margin));
        // 默认状态说明最多三行，留 240px 余量；放不下就整体上移。
        const top = rect === undefined
          ? margin
          : Math.max(margin, Math.min((rect.bottom ?? 0) + 6, viewportHeight - INFO_TIP_VERTICAL_RESERVE));
        return { left, top };
      }, []);
      const infoWidthOf = useCallback(() => {
        const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1280;
        return Math.max(INFO_TIP_MIN_WIDTH, Math.min(INFO_TIP_WIDTH, viewportWidth - INFO_TIP_MARGIN * 2));
      }, []);

      // 页面滚动 / 窗口缩放后 fixed 浮层的坐标会失真：说明浮层跟着锚点重新定位，
      // 描述浮层仍然直接关掉。测试替身的 window 没有 addEventListener，这里防御一下。
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const reposition = () => {
          clearTip();
          const anchor = infoAnchorRef.current;
          if (anchor === undefined) return;
          const rect = anchor.getBoundingClientRect?.();
          const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 800;
          // 锚点滚出视口就关掉，避免浮层停在一个已不可见的位置。
          if (rect === undefined || rect.bottom < 0 || rect.top > viewportHeight) {
            setInfoTip(undefined);
            infoAnchorRef.current = undefined;
            return;
          }
          const width = infoWidthOf();
          const position = infoPositionOf(rect, width);
          setInfoTip((current) => (current === undefined ? current : { ...current, width, ...position }));
        };
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
          window.removeEventListener('scroll', reposition, true);
          window.removeEventListener('resize', reposition);
        };
      }, [clearTip, infoPositionOf, infoWidthOf]);

      /** 打开顶部说明浮层，并记住锚点供滚动时重定位。 */
      const showInfo = useCallback((kind, event) => {
        const anchor = event?.currentTarget;
        infoAnchorRef.current = anchor;
        const width = infoWidthOf();
        const position = infoPositionOf(anchor?.getBoundingClientRect?.(), width);
        setInfoTip({ kind, width, ...position });
      }, [infoPositionOf, infoWidthOf]);
      const hideInfo = useCallback((kind) => {
        setInfoTip((current) => (current?.kind === kind ? undefined : current));
        // 不在这里清锚点：工作区图标失焦时可能已经切到默认状态图标，清掉会让
        // 新浮层失去滚动重定位的基准。锚点由下一次 showInfo 覆盖、切换工作区时清空。
      }, []);

      const toggleUnmanageable = useCallback(() => {
        clearTip();
        setShowUnmanageable((current) => !current);
      }, [clearTip]);

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
      // 工作区的配置，留着会让"应用"改到看不见的行。分组折叠态、顶部说明与浮层同理 ——
      // 同名技能在新工作区里是另一份配置，不该继承上一份的界面状态。
      const chooseWorkspace = useCallback((path) => {
        setSelected(new Set());
        setNotice(undefined);
        setShowUnmanageable(false);
        setInfoTip(undefined);
        infoAnchorRef.current = undefined;
        clearTip();
        choose(path);
      }, [choose, clearTip]);

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

      const clearFilters = useCallback(() => {
        setQuery('');
        setOnlyProblem(false);
        clearTip();
      }, [clearTip]);

      // 搜索/筛选变化后旧浮层指向的行可能已被滤掉：先关掉再重算。
      const changeQuery = useCallback((value) => {
        setQuery(value);
        clearTip();
      }, [clearTip]);

      const changeOnlyProblem = useCallback((value) => {
        setOnlyProblem(value);
        clearTip();
      }, [clearTip]);

      /**
       * 技能写操作（单行下拉 / 批量）：成功后清空勾选。
       *
       * 单行与批量共用同一条出口：写盘之后表格会重排，留着旧勾选会让下一次"应用"改到
       * 使用者已经忘记的行。`setDefault` / `setMcp` 不走这里 —— 它们与勾选无关。
       */
      const applySkill = useCallback(async (method, args) => {
        const result = await apply(method, args);
        if (result !== undefined) {
          setSelected(new Set());
          clearTip();
        }
        return result;
      }, [apply, clearTip]);

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

      const header = h(ScopeHeader, {
        state,
        workspaces,
        cwd,
        onChoose: chooseWorkspace,
        onDefault: (next) => void apply('setDefault', { state: next }),
        error,
        infoTip,
        onInfoEnter: showInfo,
        onInfoLeave: hideInfo,
      });

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
          onQuery: changeQuery,
          onlyProblem,
          onOnlyProblem: changeOnlyProblem,
          onClearFilters: clearFilters,
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
          showUnmanageable,
          onToggleUnmanageable: toggleUnmanageable,
          tip,
          onShowTip: showTipFor,
          onHideTip: scheduleHideTip,
          onClearTip: clearTip,
          onCancelHideTip: cancelHideTip,
          onMouseLeaveTip: scheduleHideTip,
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
    exports.__logic = { insertSkill, shortenPath, readableSize, STATE_META, formatChars, signedChars, stateCountsOf, batchDeltaOf, CLEAR_VALUE, GRID_COLUMNS, GRID_MIN_WIDTH };
    return module.exports;
  },
});
