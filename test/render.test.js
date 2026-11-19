/**
 * settings.section 组件的渲染契约测试。
 *
 * 回归靶子：`state` 尚未到达时必须能渲染。
 * 此前 header 的"写入哪一层"三元表达式在**两个分支都裸访问 `state.scope`**
 * （只有条件用了可选链），首帧必抛 TypeError；React 错误边界把它吞掉，
 * 于是设置面板只剩侧栏 label、内容区整个空白，且 useEffect 再没机会把数据带进来。
 *
 * 组件是闭包内的，不对外导出，所以这里走真实入口：mock `ctx.slots` 捕获
 * `apply` 注册进来的组件，再用替身 React 渲染它。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBundleEntry, seedRequire } from './helpers/client-bundle.js';

/** ref 替身的 `contains` 结果：测试里改它来模拟"点在浮层里/外"。 */
const refControl = { contains: true };

/** 替身 React：hooks 每次 render 重置游标、跨 render 保留槽位；effect 只收集不执行。 */
function createReact() {
  let hooks = [];
  let hookIndex = 0;
  let effects = [];
  return {
    api: {
      createElement: (type, props, ...children) => {
        const element = { type, props: props ?? {}, children: children.flat() };
        // 替身 React 不 attach ref：补一个最小 DOM 替身，让依赖 ref 的分支也能被走到。
        if (element.props.ref !== undefined && typeof element.props.ref === 'object') {
          element.props.ref.current = {
            getBoundingClientRect: () => ({ top: 120 }),
            contains: () => refControl.contains,
            closest: () => null,
            querySelector: () => null,
          };
        }
        return element;
      },
      useState(init) {
        const i = hookIndex++;
        if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
        const set = (value) => {
          hooks[i] = typeof value === 'function' ? value(hooks[i]) : value;
        };
        return [hooks[i], set];
      },
      useCallback: (fn) => fn,
      useEffect: (fn) => {
        effects.push(fn);
      },
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
    },
    render(Component, props) {
      hookIndex = 0;
      effects = [];
      const tree = Component(props);
      return { tree, effects };
    },
  };
}

/** 最小可用的 state 载荷，字段与 host 侧 `state` 方法返回的形状对齐。 */
const MIN_STATE = {
  scope: {
    cwd: '/Users/example/code/demo',
    projectRoot: '/Users/example/code/demo',
    projectLayer: false,
    projectPath: '/Users/example/code/demo/.dsh/skills-scope.json',
    globalPath: '/Users/example/.dsh/settings/skills-scope.json',
  },
  defaultState: 'pinned',
  workspaces: [{ id: 'w1', title: 'demo', path: '/Users/example/code/demo' }],
  catalog: { via: 'preset', incomplete: false, sourceLabels: {} },
  skills: [
    {
      name: 'demo-skill',
      description: '这是一个用来验证描述列会真的渲染出来的技能说明。',
      source: 'user-agents',
      sourceLabel: '~/.agents/skills',
      invocation: { modelInvocable: true, userInvocable: true },
      path: '/Users/example/.agents/skills/demo-skill/SKILL.md',
      manageable: true,
      size: 1024,
      state: 'pinned',
    },
  ],
  mcp: [],
  totals: { total: 1, hidden: 0, off: 0, unmanageable: 0 },
};

/**
 * 加载 bundle 并取出 `settings.section` 注册的组件。
 * @param options - `{ state, storage }`：state 是 host `state` 方法的返回载荷；storage 可注入
 *   localStorage 替身（默认内存 Map，用来验证"记住上次工作区"）。
 * @returns 组件函数与替身 React 的 render 入口。
 */
async function mountSection({ state = MIN_STATE, storage = new Map(), storageThrows = false, onRpc, fetchImpl } = {}) {
  const react = createReact();
  const bundle = await loadBundleEntry();

  globalThis.window = {
    localStorage: storageThrows
      ? { getItem: () => { throw new Error('localStorage 被禁用'); }, setItem: () => { throw new Error('localStorage 被禁用'); } }
      : {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
      },
    // 面板会监听 window 的 scroll/resize 来关闭 fixed 浮层；替身给空实现即可。
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: { load: () => {} },
  };
  globalThis.fetch = fetchImpl ?? (async (_url, init) => {
    const { method, args } = JSON.parse(init.body);
    if (onRpc !== undefined) onRpc(method, args);
    const value = method === 'workspaces'
      ? { workspaces: state.workspaces }
      : state;
    return { status: 200, json: async () => ({ ok: true, value }) };
  });

  const registered = {};
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, Component) => {
        registered[options.name] = { options, Component };
        return () => {};
      },
    },
  };
  const api = bundle.factory((name) => seedRequire(name, { react: react.api }));
  api.apply(ctx);

  const section = registered['settings.section'];
  assert.ok(section !== undefined, 'apply 必须注册 settings.section');
  // `logic` 带出 bundle 的纯函数（面板的排序/分组/体量估算都在里面），供单测直接用。
  return { Component: section.Component, react, storage, logic: api.__logic };
}

/** 把 element 树里的文本节点摊平，用于断言文案。 */
function collectText(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  // 替身 React 不渲染函数组件，这里补上：settings 一节的子组件（ScopeHeader / SkillTable /
  // SkillRow / McpSection / StateSelect / BatchBar）都不含 hook，可以在收集阶段安全展开。
  if (typeof node.type === 'function') return collectText(node.type(node.props), out);
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

/** 收集树里所有 grid 容器的列模板，用于检查表格列定义。 */
function collectGridTemplates(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (typeof node.type === 'function') return collectGridTemplates(node.type(node.props), out);
  const template = node.props?.style?.gridTemplateColumns;
  if (typeof template === 'string') out.push(template);
  for (const child of node.children ?? []) collectGridTemplates(child, out);
  return out;
}

test('state 未到达时也能渲染：不得抛错（回归：首帧裸访问 state.scope）', async () => {
  const { Component, react } = await mountSection();
  const { tree } = react.render(Component, { close: () => {} });
  assert.ok(tree !== undefined && tree !== null, '首帧必须返回元素树');
  const text = collectText(tree).join(' ');
  assert.match(text, /工作区能力/, '首帧应已渲染分区标题');
  // 写入层信息默认收进信息图标：hover（这里用聚焦）后才显示读取占位。
  const info = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '工作区路径与写入层信息');
  assert.ok(info !== undefined, '首帧也应渲染工作区信息图标');
  info.props.onFocus();
  const hovered = react.render(Component, { close: () => {} }).tree;
  assert.match(collectText(hovered).join(' '), /正在读取配置来源/, '信息图标悬停后应显示读取占位而不是崩溃');
});

/**
 * 加载 bundle 并取出 `conversation.input.right` 注册的组件（composer 的 `/技能` 按钮）。
 * @param options - `{ state, fail }`：`state` 覆盖 `state` 方法的返回载荷，`fail` 让 fetch 抛错。
 * @returns 组件函数、替身 React 的 render 入口与回焦记录。
 */
async function mountButton({ state, fail, selectionThrows = false } = {}) {
  const react = createReact();
  const focusCalls = [];
  const documentListeners = [];
  refControl.contains = true;
  const bundle = await loadBundleEntry();

  globalThis.window = {
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (fn) => fn(),
    __ModuleLoader__: { load: () => {} },
  };
  globalThis.document = {
    addEventListener: (type, callback) => documentListeners.push({ type, callback }),
    removeEventListener: (type, callback) => {
      const index = documentListeners.findIndex((entry) => entry.type === type && entry.callback === callback);
      if (index >= 0) documentListeners.splice(index, 1);
    },
    querySelector: () => ({
      focus: () => focusCalls.push('focus'),
      setSelectionRange: () => {
        if (selectionThrows) throw new Error('富文本编辑器不接受 selectionRange');
        focusCalls.push('selection');
      },
      value: '草稿',
    }),
  };
  globalThis.fetch = async (_url, init) => {
    if (fail !== undefined) throw fail;
    const { method } = JSON.parse(init.body);
    const value = method === 'workspaces'
      ? { workspaces: [{ id: 'w1', title: 'demo', path: '/p' }] }
      : state ?? { skills: [{ name: 'alpha', description: '第一个技能', state: 'manual' }] };
    return { status: 200, json: async () => ({ ok: true, value }) };
  };

  const registered = {};
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, Component) => {
        registered[options.name] = { options, Component };
        return () => {};
      },
    },
  };
  bundle.factory((name) => seedRequire(name, { react: react.api })).apply(ctx);

  const button = registered['conversation.input.right'];
  assert.ok(button !== undefined, 'apply 必须注册 conversation.input.right');
  return { Component: button.Component, react, focusCalls, documentListeners };
}

/** 收集树里的 element 节点（不展开函数组件，避免重复执行带 hook 的组件）。 */
function collectElements(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children ?? []) collectElements(child, out);
  return out;
}

test('composer 按钮：关闭态只渲染按钮，点开后渲染浮层并拉取候选', async () => {
  const { Component, react } = await mountButton();
  // props 契约与真实宿主一致：session/输入能力来自 session 级 provide，不是 ownerProps。
  const props = {
    sessionId: 'ses-1',
    useSessions: () => '/p',
    useInput: () => ({ draft: '草稿' }),
    inputActions: { setDraft: () => {} },
  };

  const first = react.render(Component, props);
  assert.match(collectText(first.tree).join(' '), /技能/, '关闭态应渲染 /技能 按钮');
  assert.doesNotMatch(collectText(first.tree).join(' '), /加载中/, '关闭态不该渲染浮层');

  // 点开：ScopeIconButton 的 onClick 就是 toggle。
  const icon = collectElements(first.tree).find((node) => node.props?.title === '插入 /技能名');
  assert.ok(icon !== undefined, '应渲染 /技能 图标按钮');
  icon.props.onClick();

  // 第二帧：浮层出现，effect 触发加载。
  const second = react.render(Component, props);
  assert.match(collectText(second.tree).join(' '), /加载中/, '打开后先显示加载态');
  for (const effect of second.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 第三帧：候选取回，manual 技能带"仅手动"标记。
  const third = react.render(Component, props);
  const text = collectText(third.tree).join(' ');
  assert.match(text, /\/alpha/, '候选应列出技能名');
  assert.match(text, /仅手动/, 'manual 技能应带"仅手动"标记');
  assert.match(text, /第一个技能/, '候选应带描述');
});

test('state 到达后渲染完整面板：配置区/统计/来源列/MCP 分区齐备', async () => {
  const { Component, react, logic } = await mountSection();
  const { effects } = react.render(Component, { close: () => {} });
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { tree } = react.render(Component, { close: () => {} });
  const text = collectText(tree).join(' ');
  assert.match(text, /MCP 服务器/, '应渲染 MCP 分区');
  assert.match(text, /技能 1/, '统计胶囊应渲染总数');
  assert.match(text, /自动注入 1/, '统计胶囊应拆分三态');
  assert.match(text, /默认状态/, '默认状态应从统计行里独立出来，带明确标签');

  // 页头排版：标题与简介各占一行，字号对齐原生设置页分区（18px / 13px）。
  const heading = findElement(tree, (element) => element.type === 'h2' && labelOf(element) === '工作区能力');
  const intro = findElement(tree, (element) => element.type === 'p' && labelOf(element).startsWith('按当前项目目录'));
  assert.equal(heading.props.style.fontSize, '18px', '分区标题字号应原生对齐');
  assert.equal(intro.props.style.fontSize, '13px', '分区简介字号应原生对齐');
  assert.notEqual(heading.props.style.display, 'inline', '标题必须独占一行');

  // 退出常驻的写入层信息：默认不出现，hover 工作区信息图标后才出现。
  assert.doesNotMatch(text, /写入全局层/, '写入层信息默认收起');
  assert.doesNotMatch(text, /\/Users\/example\/\.dsh\/settings\/skills-scope\.json/, '配置路径默认收起');
  const workspaceInfo = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '工作区路径与写入层信息');
  assert.ok(workspaceInfo !== undefined, '工作区下拉右侧应有信息图标');
  workspaceInfo.props.onFocus();
  const hoveredText = collectText(react.render(Component, { close: () => {} }).tree).join(' ');
  assert.match(hoveredText, /写入全局层/, '信息图标应显示写入层');
  assert.match(hoveredText, /\/Users\/example\/\.dsh\/settings\/skills-scope\.json/, '信息图标应显示具体配置路径');
  assert.match(hoveredText, /\/Users\/example\/code\/demo/, '信息图标应显示工作区路径');

  // 工作区下拉只显示名称，路径进信息图标。
  const workspaceSelect = findElement(tree, (element) => element.type === 'select' && element.props['aria-label'] === '选择工作区');
  const workspaceOptions = collectElementsDeep(workspaceSelect).filter((element) => element.type === 'option');
  assert.deepEqual(workspaceOptions.map((option) => labelOf(option)), ['demo'], '下拉选项只显示工作区名称');

  // 回归：列模板原来把描述列写成裸 `1fr`，而描述单元格带 overflow:hidden（自动最小
  // 尺寸为 0），面板不够宽时它被压成 0 宽、内容被裁光 —— 整个描述列空白。
  assert.equal(
    logic.GRID_COLUMNS,
    '24px minmax(132px, 184px) minmax(92px, 112px) minmax(164px, 1fr) 96px',
    '列顺序必须是 勾选 / 技能 / 来源 / 描述 / 状态',
  );
  const templates = collectGridTemplates(tree);
  assert.ok(templates.length >= 2, '表格应有表头行与数据行');
  for (const template of templates) {
    assert.match(template, /minmax\(164px, 1fr\)/, '描述列必须带宽度下限，否则会被压成 0 宽');
    assert.match(template, /minmax\(92px, 112px\)/, '来源必须是独立列，并带宽度下限');
    assert.match(template, /^24px /, '最左列是批量勾选框');
  }
  assert.equal(new Set(templates).size, 1, '表头与数据行必须共用同一套列模板，否则会列错位');
  assert.match(text, /描述/, '列头应包含描述列');
  assert.match(text, /来源/, '列头应包含来源列');
  assert.match(text, /这是一个用来验证描述列会真的渲染出来的技能说明/, '描述必须真的渲染进树里');
  assert.match(text, /~\/\.agents\/skills/, '来源应渲染在独立来源列里');
  assert.doesNotMatch(text, /展开/, '描述列不再有展开入口');
  assert.match(text, /目录 ≈ .+ 字符 \/ \d+ 条/, '应显示目录体量估算');
  assert.match(text, /改动立即生效/, '应说明生效时机与代价');
});

test('设置面板：工具栏顺序——目录体量纯文本在上、统计胶囊左对齐、搜索下移', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const elements = collectElementsDeep(view());
  const catalogIndex = elements.findIndex((element) => element.type === 'div'
    && element.props.title !== undefined
    && labelOf(element).startsWith('目录 ≈'));
  const chipIndex = elements.findIndex((element) => element.type === 'span' && element.props.style?.borderRadius === '999px');
  const searchIndex = elements.findIndex((element) => element.type === 'input' && element.props.placeholder === '搜索技能…');
  assert.ok(catalogIndex >= 0, '应渲染目录体量');
  assert.ok(chipIndex >= 0, '应渲染统计胶囊');
  assert.ok(searchIndex >= 0, '应渲染搜索框');
  assert.ok(catalogIndex < chipIndex, '目录体量应在统计胶囊上一行');
  assert.ok(chipIndex < searchIndex, '搜索栏应下移到统计胶囊下方');

  const catalog = elements[catalogIndex];
  assert.match(labelOf(catalog), /目录 ≈ 120 字符 \/ 1 条/);
  assert.equal(catalog.props.style.borderRadius, undefined, '目录体量不再使用胶囊样式');
  assert.match(catalog.props.title, /按宿主渲染规则估算的字符数/, '目录体量应保留字符数估算说明');
  assert.match(catalog.props.title, /token 数因语言而异/, 'token 换算说明应保留在 title 里');

  // 统计胶囊不靠右：容器没有 marginLeft:auto，仍从左侧开始排。
  const chipRow = elements.find((element) => element.type === 'div'
    && element.props.style?.display === 'flex'
    && element.props.style?.gap === '6px'
    && element.props.style?.flexWrap === 'wrap'
    && labelOf(element).startsWith('技能'));
  assert.ok(chipRow !== undefined, '统计胶囊应有自己的行容器');
  assert.equal(chipRow.props.style.marginLeft, undefined, '统计胶囊应左对齐，不再靠右');
});

test('设置面板：默认状态信息图标 hover 给出三态定义', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const info = findElement(view(), (element) => element.type === 'button' && element.props['aria-label'] === '默认状态说明');
  assert.ok(info !== undefined, '默认状态下拉右侧应有信息图标');
  info.props.onFocus();
  const text = collectText(view()).join(' ');
  assert.match(text, /自动注入\s*：\s*进 <available_skills>/, '应解释自动注入');
  assert.match(text, /仅手动\s*：\s*不进模型目录/, '应解释仅手动');
  assert.match(text, /关闭\s*：\s*完全无关/, '应解释关闭');
  assert.equal(
    collectElementsDeep(view()).filter((element) => element.props?.role === 'tooltip').length,
    1,
    '同一时刻只应有一个说明浮层',
  );
});

test('设置面板：不可管理项独立分组、默认折叠，可展开收起且切换工作区后复位', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const toggleOf = (tree) => findElement(tree, (element) => element.type === 'button' && labelOf(element).includes('不可管理 1 项'));
  assert.ok(toggleOf(view()) !== undefined, '不可管理项应有独立分组头');
  assert.equal(toggleOf(view()).props['aria-expanded'], false, '分组默认折叠');
  assert.doesNotMatch(collectText(view()).join(' '), /bundled-skill/, '折叠时不可管理行不渲染');

  toggleOf(view()).props.onClick();
  assert.equal(toggleOf(view()).props['aria-expanded'], true, '点击组头应展开');
  const expandedText = collectText(view()).join(' ');
  assert.match(expandedText, /bundled-skill/, '展开后显示不可管理行');
  assert.match(expandedText, /正文不在磁盘上，配置对它无效/, '组头说明配置为何无效');
  assert.ok(expandedText.indexOf('not-applied') < expandedText.indexOf('bundled-skill'), '分组始终排在可管理行之后');

  toggleOf(view()).props.onClick();
  assert.doesNotMatch(collectText(view()).join(' '), /bundled-skill/, '再次点击应收起分组');

  // 切换工作区后折叠态复位：新工作区的同名技能是另一份配置，不该继承展开状态。
  toggleOf(view()).props.onClick();
  assert.match(collectText(view()).join(' '), /bundled-skill/);
  findElement(view(), (element) => element.type === 'select' && element.props['aria-label'] === '选择工作区')
    .props.onChange({ target: { value: MIN_STATE.scope.cwd } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(toggleOf(view()).props['aria-expanded'], false, '切换工作区后折叠态复位');
});

// ── 面板的纯函数：三态计数、体量估算、批量增量 ──────────────────────────────

test('面板纯逻辑：三态计数、体量估算与批量增量', async () => {
  const { logic } = await mountSection();
  assert.equal(logic.formatChars(0), '0');
  assert.equal(logic.formatChars(999), '999');
  assert.equal(logic.formatChars(1234), '1.2k');
  assert.equal(logic.formatChars(undefined), '0');
  assert.equal(logic.signedChars(0), '目录大小不变');
  assert.equal(logic.signedChars(-1200), '目录 -1.2k 字符');
  assert.equal(logic.signedChars(500), '目录 +500 字符');

  // 三态计数只算可管理行：不可管理有 state 但配置对它们无效，算进来只会让数字虚高。
  assert.deepEqual(
    logic.stateCountsOf([
      { name: 'a', manageable: true, state: 'pinned' },
      { name: 'b', manageable: true, state: 'manual' },
      { name: 'c', manageable: true, state: 'off' },
      { name: 'd', manageable: false, state: 'off' },
    ]),
    { total: 4, pinned: 1, manual: 1, off: 1, unmanageable: 1 },
  );
  assert.deepEqual(logic.stateCountsOf([]), { total: 0, pinned: 0, manual: 0, off: 0, unmanageable: 0 });

  // 批量增量：只统计选中行，default 用 fallbackState 推算落点
  const skills = [
    { name: 'on', catalogChars: 100, inCatalog: true, state: 'pinned', invocation: { modelInvocable: true } },
    { name: 'off', catalogChars: 60, inCatalog: false, state: 'off', invocation: { modelInvocable: true } },
    { name: 'back', catalogChars: 40, inCatalog: false, state: 'manual', fallbackState: 'pinned', invocation: { modelInvocable: true } },
  ];
  assert.equal(logic.batchDeltaOf(skills, new Set(['on']), 'manual'), -100, '关掉自动注入应让目录变小');
  assert.equal(logic.batchDeltaOf(skills, new Set(['off']), 'pinned'), 60, '设为自动注入应让目录变大');
  assert.equal(logic.batchDeltaOf(skills, new Set(['back']), 'default'), 40, '恢复默认按 fallbackState 推算');
  assert.equal(logic.batchDeltaOf(skills, new Set(), 'off'), 0, '没选中就不该有增量');
});

// ── 交互分支：设置面板的写操作与 composer 浮层 ──────────────────────────────

/** 深度遍历（会展开无 hook 的函数组件），用来找到可以触发事件的元素。 */
function collectElementsDeep(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (typeof node.type === 'function') return collectElementsDeep(node.type(node.props), out);
  out.push(node);
  for (const child of node.children ?? []) collectElementsDeep(child, out);
  return out;
}

/** 树里第一个满足条件的元素。 */
const findElement = (tree, predicate) => collectElementsDeep(tree).find(predicate);

/** 面包屑文本，用于按文案定位按钮。 */
const labelOf = (element) => collectText(element).join('');

/** 渲染一帧并执行收集到的 effects（模拟挂载 + 数据到达）。 */
async function mountSectionAndWait(options) {
  const { Component, react, storage, logic } = await mountSection(options);
  const first = react.render(Component, { close: () => {} });
  assert.ok(first.tree !== undefined, '首帧必须能渲染');
  const { effects } = react.render(Component, { close: () => {} });
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { Component, react, storage, logic, view: () => react.render(Component, { close: () => {} }).tree };
}

const INTERACTIVE_STATE = {
  ...MIN_STATE,
  catalog: { via: 'agent', incomplete: false, entries: 1, chars: 120 },
  skills: [
    { name: 'exact-skill', description: '有精确配置', source: 'custom', sourceLabel: '自定义目录', invocation: { modelInvocable: true, userInvocable: true }, path: '/x/a/SKILL.md', manageable: true, size: 100, state: 'manual', matchedKey: 'exact-skill', fallbackState: 'pinned', catalogChars: 120, inCatalog: false },
    { name: 'glob-skill', description: '命中通配符的技能', source: 'custom', sourceLabel: '自定义目录', invocation: { modelInvocable: true, userInvocable: true }, path: '/x/b/SKILL.md', manageable: true, size: 2048, state: 'off', matchedKey: 'glob-*', catalogChars: 80, inCatalog: false },
    { name: 'bundled-skill', description: '不可接管', source: 'bundled', sourceLabel: '包内置', invocation: { modelInvocable: true, userInvocable: true }, manageable: false, reason: '包内置技能正文不在磁盘上，接管会让 /名 静默失效', state: 'off', catalogChars: 60, inCatalog: true },
    { name: 'not-applied', description: '配置说关了但注册表仍可见', source: 'custom', sourceLabel: '自定义目录', invocation: { modelInvocable: true, userInvocable: true }, path: '/x/c/SKILL.md', manageable: true, size: 300, state: 'manual', matchedKey: undefined, catalogChars: 90, inCatalog: false },
  ],
  mcp: [
    { name: 'comfy', toolCount: 2, enabled: false, explicit: true, visibleTools: 0 },
    { name: 'other', toolCount: 1, enabled: true, explicit: false, visibleTools: 1 },
  ],
  mcpProbe: { agentId: 'ses-1' },
  totals: { total: 4, hidden: 3, off: 2, unmanageable: 1 },
};

test('设置面板：渲染可管理/不可管理/命中来源与"未生效?"标记', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const tree = view();
  const text = collectText(tree).join(' ');

  assert.match(text, /技能 4/);
  assert.match(text, /自动注入 0/);
  assert.match(text, /仅手动 2/);
  assert.match(text, /关闭 1/);
  assert.match(text, /不可管理 1/);
  assert.match(text, /未生效\?/, '配置说关了但注册表仍可见时必须提示');
  assert.match(text, /显式配置/, '精确命中显示"显式配置"');
  assert.match(text, /命中 glob-\*/, '通配符命中显示模式名');
  assert.match(text, /2\.0 KB/, '体积可读化');
  assert.match(text, /2 个工具/, 'MCP 分区显示工具数');
  assert.match(text, /可见 0\/2|全部可见/, '有探针时报可见数');

  // 不可管理项默认折叠：组头的数量与原因在，但行本身不在树里。
  assert.doesNotMatch(text, /bundled-skill/, '不可管理分组默认折叠');
  assert.match(text, /不可管理 1 项/, '组头应给出不可管理数量');
  const groupToggle = findElement(tree, (element) => element.type === 'button' && labelOf(element).includes('不可管理 1 项'));
  assert.ok(groupToggle !== undefined, '应渲染不可管理分组头');
  assert.equal(groupToggle.props['aria-expanded'], false);
  groupToggle.props.onClick();
  const expandedTree = view();
  const expandedText = collectText(expandedTree).join(' ');
  assert.match(expandedText, /bundled-skill/, '展开后应显示不可管理行');
  assert.equal(
    findElement(expandedTree, (element) => element.type === 'button' && labelOf(element).includes('不可管理 1 项')).props['aria-expanded'],
    true,
  );

  assert.match(expandedText, /不可管理/, 'bundled 技能应有标记');
  // 回归：描述列原来渲染 `reason ?? description`，不可管理技能因此永远看不到自己的描述。
  assert.match(expandedText, /不可接管/, '不可管理行也要显示自己的描述');
  const badge = findElement(expandedTree, (element) => element.type === 'span' && labelOf(element) === '不可管理');
  assert.match(badge.props.title, /正文不在磁盘上/, '不可管理的原因应进 title');

  // host 的排序是 可管理 → 来源 → 名称；面板再把不可管理收进末尾的独立分组。
  assert.ok(expandedText.indexOf('exact-skill') < expandedText.indexOf('bundled-skill'), '可管理行必须排在不可管理行之前');

  const optionsOf = (name) => collectElementsDeep(
    findElement(expandedTree, (element) => element.type === 'select' && element.props['aria-label'] === `技能 ${name} 的注入状态`),
  ).filter((element) => element.type === 'option');
  // "删除显式配置"只对**精确键**有意义：命中的是通配符时配置里没有以技能名命名的键。
  assert.equal(optionsOf('exact-skill').length, 4, '精确命中的行应有"删除显式配置"这一项');
  assert.equal(optionsOf('glob-skill').length, 3, '通配符命中没有可删的键，不该给第 4 项');

  // 勾选框：不可管理的行不能选（批量修改对它没有意义）
  const disabled = findElement(expandedTree, (element) => element.type === 'input' && element.props['aria-label'] === '选择技能 bundled-skill');
  assert.equal(disabled.props.disabled, true, '不可管理行的勾选框必须禁用');
  const enabled = findElement(expandedTree, (element) => element.type === 'input' && element.props['aria-label'] === '选择技能 exact-skill');
  assert.equal(enabled.props.disabled, false);
});

test('设置面板：状态下拉/删除显式配置/批量/默认/MCP/搜索/切换工作区都会发出对应 RPC', async () => {
  const calls = [];
  const { storage, view, logic } = await mountSectionAndWait({ state: INTERACTIVE_STATE, onRpc: (method, args) => calls.push({ method, args }) });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  const stateSelectOf = (name) => findElement(view(), (element) => element.type === 'select' && element.props['aria-label'] === `技能 ${name} 的注入状态`);

  // 状态下拉：把 exact-skill 切到"关闭"
  assert.ok(stateSelectOf('exact-skill') !== undefined, '应渲染状态下拉');
  stateSelectOf('exact-skill').props.onChange({ target: { value: 'off' } });
  await flush();
  assert.ok(calls.some((call) => call.method === 'setSkill' && call.args.name === 'exact-skill' && call.args.state === 'off'), JSON.stringify(calls));

  // 删除显式配置：下拉第 4 项
  stateSelectOf('exact-skill').props.onChange({ target: { value: logic.CLEAR_VALUE } });
  await flush();
  assert.ok(calls.some((call) => call.method === 'setSkill' && call.args.state === 'default'), JSON.stringify(calls));

  // 默认状态
  const defaultSelect = findElement(view(), (element) => element.type === 'select' && element.props.value === 'pinned');
  defaultSelect.props.onChange({ target: { value: 'manual' } });
  await flush();
  assert.ok(calls.some((call) => call.method === 'setDefault' && call.args.state === 'manual'));

  // MCP 开关：comfy 当前关闭 → 打开（按 label 文案定位，避免撞上"只看非默认项"那个 checkbox）
  const mcpLabel = findElement(view(), (element) => element.type === 'label' && labelOf(element).includes('comfy'));
  assert.ok(mcpLabel !== undefined, '应渲染 comfy 开关');
  const mcpCheckbox = collectElementsDeep(mcpLabel).find((element) => element.type === 'input');
  mcpCheckbox.props.onChange({ target: { checked: true } });
  await flush();
  assert.ok(calls.some((call) => call.method === 'setMcp' && call.args.server === 'comfy' && call.args.enabled === true), JSON.stringify(calls));

  // 搜索过滤：只剩一条
  const search = findElement(view(), (element) => element.type === 'input' && element.props.placeholder === '搜索技能…');
  search.props.onChange({ target: { value: 'glob' } });
  const filtered = collectText(view()).join(' ');
  assert.match(filtered, /glob-skill/);
  assert.doesNotMatch(filtered, /exact-skill/, '搜索应过滤掉不匹配的行');
  // 统计必须基于全量 state.skills，不能被筛选后的 rows 带着变。
  assert.match(filtered, /技能 4/);
  assert.match(filtered, /仅手动 2/);
  assert.match(filtered, /关闭 1/);
  assert.match(filtered, /不可管理 1/);

  // 只看非默认项
  const onlyProblem = findElement(view(), (element) => element.type === 'input' && element.props['aria-label'] === '只看非默认项');
  onlyProblem.props.onChange({ target: { checked: true } });

  // 切换工作区：写入 localStorage 并重新拉状态
  const workspaceSelect = findElement(view(), (element) => element.type === 'select' && element.props.value === MIN_STATE.scope.cwd);
  workspaceSelect.props.onChange({ target: { value: '/Users/example/code/demo' } });
  await flush();
  assert.equal(storage.get('dsh-workspace-capabilities.cwd'), '/Users/example/code/demo', '选择的工作区要记住');
});

test('设置面板：勾选与批量条——全选只覆盖可管理行，应用后清空勾选并回报结果', async () => {
  const calls = [];
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE, onRpc: (method, args) => calls.push({ method, args }) });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  const checkboxOf = (tree, label) => findElement(tree, (element) => element.type === 'input' && element.props['aria-label'] === label);

  // 未选中任何行时不显示批量条
  assert.doesNotMatch(collectText(view()).join(' '), /已选/, '没有勾选时不该占位');

  // 表头全选：只勾可管理的三行（bundled 不可管理，且默认折叠）
  checkboxOf(view(), '全选当前筛选内的可管理技能').props.onChange({ target: { checked: true } });
  await flush();
  let text = collectText(view()).join(' ');
  assert.match(text, /已选 3 项（当前筛选 4 项）/, '表头全选应只覆盖可管理行');
  assert.equal(checkboxOf(view(), '选择技能 bundled-skill'), undefined, '不可管理行默认折叠，不在树里');
  findElement(view(), (element) => element.type === 'button' && labelOf(element).includes('不可管理 1 项')).props.onClick();
  await flush();
  assert.equal(checkboxOf(view(), '选择技能 bundled-skill').props.checked, false, '不可管理行不该被全选');

  // 批量条给出目录体量增量（三行都不在目录里 → 设为 manual 不改变目录）
  assert.match(text, /本次：目录大小不变/, '批次里没有在目录中的行');

  // 改成"关闭"再应用
  findElement(view(), (element) => element.type === 'select' && element.props['aria-label'] === '批量设置的状态')
    .props.onChange({ target: { value: 'off' } });
  const applyButton = findElement(view(), (element) => element.type === 'button' && labelOf(element) === '应用');
  applyButton.props.onClick();
  await flush();
  const batch = calls.find((call) => call.method === 'setSkills');
  assert.ok(batch !== undefined, '应发出 setSkills');
  assert.deepEqual([...batch.args.names].sort(), ['exact-skill', 'glob-skill', 'not-applied'], '批量名必须是勾选的可管理行');
  assert.equal(batch.args.state, 'off');
  assert.doesNotMatch(collectText(view()).join(' '), /已选 \d+ 项/, '写盘成功后必须清空勾选');

  // 恢复默认：同一个批量入口，state 为 default
  checkboxOf(view(), '选择技能 exact-skill').props.onChange({ target: { checked: true } });
  await flush();
  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '恢复默认').props.onClick();
  await flush();
  assert.ok(calls.some((call) => call.method === 'setSkills' && call.args.state === 'default'), JSON.stringify(calls));

  // 取消勾选：单行取消、表头取消、清除选择三条路径都要能清干净
  checkboxOf(view(), '选择技能 exact-skill').props.onChange({ target: { checked: true } });
  checkboxOf(view(), '选择技能 glob-skill').props.onChange({ target: { checked: true } });
  await flush();
  assert.match(collectText(view()).join(' '), /已选 2 项/);
  checkboxOf(view(), '选择技能 glob-skill').props.onChange({ target: { checked: false } });
  await flush();
  assert.match(collectText(view()).join(' '), /已选 1 项/, '取消单行必须减少计数');

  checkboxOf(view(), '全选当前筛选内的可管理技能').props.onChange({ target: { checked: true } });
  await flush();
  assert.match(collectText(view()).join(' '), /已选 3 项/);
  checkboxOf(view(), '全选当前筛选内的可管理技能').props.onChange({ target: { checked: false } });
  await flush();
  assert.doesNotMatch(collectText(view()).join(' '), /已选 \d+ 项/, '表头取消全选后批量条应消失');

  checkboxOf(view(), '选择技能 exact-skill').props.onChange({ target: { checked: true } });
  await flush();
  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '清除选择').props.onClick();
  await flush();
  assert.doesNotMatch(collectText(view()).join(' '), /已选 \d+ 项/, '"清除选择"必须清空勾选');
});

test('设置面板：批量条分三行——本次说明在第二行左对齐，三个操作按钮在底部', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  findElement(view(), (element) => element.type === 'input' && element.props['aria-label'] === '选择技能 exact-skill')
    .props.onChange({ target: { checked: true } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const bar = findElement(view(), (element) => element.type === 'div'
    && element.props.style?.flexDirection === 'column'
    && element.props.style?.padding === '8px 10px'
    && element.props.style?.borderRadius === '8px'
    && labelOf(element).startsWith('已选 1 项'));
  assert.ok(bar !== undefined, '勾选后应出现批量条');
  assert.equal(bar.children.length, 3, '批量条应拆成选中/本次说明/操作按钮三行');

  const [summaryRow, deltaLine, actionRow] = bar.children;
  assert.match(labelOf(summaryRow), /已选 1 项/, '第一行保留选中数量');
  assert.match(labelOf(summaryRow), /设为/, '第一行保留目标状态下拉');
  assert.equal(deltaLine.type, 'span', '第二行是本次目录变化说明');
  assert.match(labelOf(deltaLine), /^本次：/, '本次说明应作为独立第二行');
  assert.equal(deltaLine.props.style.marginLeft, undefined, '本次说明必须左对齐，不能再被顶到右边');
  assert.equal(actionRow.children.length, 3, '第三行应放三个操作按钮');
  assert.deepEqual(actionRow.children.map((element) => labelOf(element)), ['应用', '恢复默认', '清除选择'], '按钮顺序保持不变');
  assert.equal(bar.children.at(-1), actionRow, '三个按钮所在的行动条必须位于批量条最下方');
});

test('设置面板：批量写盘后按回执显示已改/跳过/noop', async () => {
  const setSkillsReply = { value: undefined };
  const fetchImpl = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    if (method === 'setSkills') return { status: 200, json: async () => ({ ok: true, value: setSkillsReply.value }) };
    const value = method === 'workspaces' ? { workspaces: INTERACTIVE_STATE.workspaces } : INTERACTIVE_STATE;
    return { status: 200, json: async () => ({ ok: true, value }) };
  };
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE, fetchImpl });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  const selectFirst = () => findElement(view(), (element) => element.type === 'input' && element.props['aria-label'] === '选择技能 exact-skill')
    .props.onChange({ target: { checked: true } });

  setSkillsReply.value = { layer: 'project', path: '/p/.dsh/skills-scope.json', applied: ['exact-skill'], skipped: [{ name: 'glob-skill', reason: '命中的是通配符/默认' }], noop: false };
  selectFirst();
  await flush();
  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '应用').props.onClick();
  await flush();
  assert.match(collectText(view()).join(' '), /已改 1 项；跳过 1 项：glob-skill（命中的是通配符\/默认）/, '必须把跳过原因回报给使用者');

  setSkillsReply.value = { layer: 'project', applied: [], skipped: [], noop: true };
  selectFirst();
  await flush();
  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '应用').props.onClick();
  await flush();
  assert.match(collectText(view()).join(' '), /已经是目标状态，未写盘/, 'no-op 要说清楚没有写盘');

  // 全部被跳过：绝不能说成"已经是目标状态"，那会和紧随其后的跳过明细自相矛盾
  setSkillsReply.value = { layer: 'project', applied: [], skipped: [{ name: 'exact-skill', reason: '显式配置不在写入层（项目层）' }], noop: true };
  selectFirst();
  await flush();
  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '应用').props.onClick();
  await flush();
  const skippedText = collectText(view()).join(' ');
  assert.match(skippedText, /未做任何改动；跳过 1 项/);
  assert.doesNotMatch(skippedText, /已经是目标状态/, '两种 noop 的文案必须分开');
});

test('设置面板：描述默认 2 行截断、仅 hover 出全文，来源独立成列', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const tree = view();

  // 默认 2 行截断：找到包含"有精确配置"的文本容器。
  const clamped = findElement(tree, (element) => element.type === 'div' && labelOf(element) === '有精确配置' && element.props.style?.WebkitLineClamp === 2);
  assert.ok(clamped !== undefined, '描述必须给 2 行预览，全文由 hover 浮层给出');
  assert.equal(clamped.props.style.display, '-webkit-box');
  assert.equal(clamped.props.style.WebkitBoxOrient, 'vertical');
  assert.equal(clamped.props.style.minHeight, '31px', '短描述也保持两行行高');
  assert.doesNotMatch(collectText(tree).join(' '), /展开|收起/, '描述列不再有展开/收起入口');

  // 来源独立成列：胶囊自己的省略号样式齐全。
  const source = findElement(tree, (element) => element.type === 'span' && labelOf(element) === '自定义目录' && element.props.title?.includes('/x/a/SKILL.md'));
  assert.ok(source !== undefined, '来源应是独立胶囊，title 带完整路径');
  assert.equal(source.props.style.maxWidth, '100%', '来源胶囊宽度受列宽约束');
  assert.equal(source.props.style.overflow, 'hidden');
  assert.equal(source.props.style.textOverflow, 'ellipsis');
  assert.equal(source.props.style.whiteSpace, 'nowrap');
  assert.equal(
    findElement(tree, (element) => element.type === 'div' && element.props.role === 'button' && labelOf(element).includes('有精确配置')),
    undefined,
    '描述单元格不再伪装成展开按钮',
  );

  // hover 400ms 才出浮层：刚触发时不应出现，避免扫过整张表时每行闪一下。
  const hoverSurface = findElement(view(), (element) => element.type === 'div' && element.props.style?.position === 'relative' && typeof element.props.onMouseEnter === 'function');
  assert.ok(hoverSurface !== undefined, '描述单元格应挂 hover 浮层');
  const hoverEvent = { currentTarget: { getBoundingClientRect: () => ({ left: 120, bottom: 260 }) } };
  hoverSurface.props.onMouseEnter(hoverEvent);
  assert.equal(findElement(view(), (element) => element.props.role === 'tooltip'), undefined, '400ms 前不应出浮层');
  await new Promise((resolve) => setTimeout(resolve, 450));
  const tooltip = findElement(view(), (element) => element.props.role === 'tooltip');
  assert.ok(tooltip !== undefined, 'hover 后应渲染详情浮层');
  const tipText = labelOf(tooltip);
  assert.match(tipText, /有精确配置/, '浮层给完整描述');
  assert.match(tipText, /\/x\/a\/SKILL\.md/, '浮层给来源路径');
  assert.match(tipText, /自定义目录/, '浮层给来源名');

  // 浮层可交互：鼠标进入后取消关闭计时器，长描述可以在浮层里滚动、选中复制。
  tooltip.props.onMouseEnter();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(findElement(view(), (element) => element.props.role === 'tooltip') !== undefined, '鼠标进入浮层后不能立刻关掉');

  // 离开描述单元格 → 140ms 延迟关闭。
  findElement(view(), (element) => element.type === 'div' && element.props.style?.position === 'relative' && typeof element.props.onMouseLeave === 'function').props.onMouseLeave();
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(findElement(view(), (element) => element.props.role === 'tooltip'), undefined, 'mouseleave 后浮层应消失');
});

test('设置面板：筛选无结果时给空状态，并能一键清除筛选（含只看非默认项）', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  findElement(view(), (element) => element.type === 'input' && element.props['aria-label'] === '只看非默认项')
    .props.onChange({ target: { checked: true } });
  findElement(view(), (element) => element.type === 'input' && element.props.placeholder === '搜索技能…')
    .props.onChange({ target: { value: '不存在的技能' } });
  const emptyText = collectText(view()).join(' ');
  assert.match(emptyText, /没有匹配的技能/);
  assert.match(emptyText, /清除筛选/, '有筛选条件时必须给一键清除入口');

  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '清除筛选').props.onClick();
  const restored = view();
  assert.equal(
    findElement(restored, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…').props.value,
    '',
    '清除筛选应把搜索词清空',
  );
  assert.equal(
    findElement(restored, (element) => element.type === 'input' && element.props['aria-label'] === '只看非默认项').props.checked,
    false,
    '清除筛选也要重置只看非默认项',
  );
  assert.match(collectText(restored).join(' '), /exact-skill/, '清除筛选后列表恢复');
});

test('设置面板：行数超过一屏时显示表格内滚动提示（反例不显示）', async () => {
  // 面板内滚动没有常驻滚动条（macOS overlay），条目多时必须明说"下面还有"。
  const rowsOf = (count) => ({
    ...INTERACTIVE_STATE,
    skills: Array.from({ length: count }, (_, index) => ({ ...INTERACTIVE_STATE.skills[0], name: `skill-${index}` })),
  });
  const many = await mountSectionAndWait({ state: rowsOf(13) });
  const manyText = collectText(many.view()).join(' ');
  assert.match(manyText, /当前筛选 13 项/);
  assert.match(manyText, /表格内可滚动查看全部/);

  // 46vh / 44px 行高在替身默认 900px 视口下约 9 行：正好一屏时不该出现提示。
  const few = await mountSectionAndWait({ state: rowsOf(9) });
  assert.doesNotMatch(collectText(few.view()).join(' '), /表格内可滚动查看全部/, '没有溢出时不提示');
});

test('设置面板：单行状态下拉写盘后也清空勾选', async () => {
  const { view } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  findElement(view(), (element) => element.type === 'input' && element.props['aria-label'] === '选择技能 exact-skill')
    .props.onChange({ target: { checked: true } });
  await flush();
  assert.match(collectText(view()).join(' '), /已选 1 项/);

  findElement(view(), (element) => element.type === 'select' && element.props['aria-label'] === '技能 exact-skill 的注入状态')
    .props.onChange({ target: { value: 'off' } });
  await flush();
  assert.doesNotMatch(collectText(view()).join(' '), /已选 \d+ 项/, '单行写盘成功后同样要清空勾选（与批量同一条出口）');
});

test('设置面板：批量条按 inCatalog/catalogChars 估算目录增量', async () => {
  const { view, logic } = await mountSectionAndWait({ state: INTERACTIVE_STATE });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  // exact-skill 此刻不在目录里（manual），设为"自动注入"会让目录 +120 字符
  findElement(view(), (element) => element.type === 'input' && element.props['aria-label'] === '选择技能 exact-skill')
    .props.onChange({ target: { checked: true } });
  findElement(view(), (element) => element.type === 'select' && element.props['aria-label'] === '批量设置的状态')
    .props.onChange({ target: { value: 'pinned' } });
  await flush();
  const text = collectText(view()).join(' ');
  assert.match(text, /本次：目录 \+120 字符/, '选中 manual 行设为自动注入应显示目录变大');
  assert.match(text, /目录变化会在会话里追加 1 份完整目录/, '必须提示一次性代价');
  assert.equal(logic.formatChars(120), '120');
});

test('设置面板：localStorage 不可用与 RPC 失败都降级到可见提示，不崩', async () => {
  // localStorage 抛错：仍能渲染，且用工作区列表的第一项
  const degraded = await mountSectionAndWait({ state: MIN_STATE, storageThrows: true });
  assert.match(collectText(degraded.view()).join(' '), /工作区能力/);
  assert.equal(findElement(degraded.view(), (element) => element.type === 'select' && element.props.value === MIN_STATE.scope.cwd) !== undefined, true);

  // RPC 失败：显示错误文案，不抛
  const failing = await mountSectionAndWait({
    state: MIN_STATE,
    fetchImpl: async () => ({ status: 500, json: async () => { throw new Error('not json'); } }),
  });
  assert.match(collectText(failing.view()).join(' '), /非 JSON/);

  // 后端返回 ok:false：显示服务端错误
  const rejected = await mountSectionAndWait({
    state: MIN_STATE,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: false, error: '配置读不动' }) }),
  });
  assert.match(collectText(rejected.view()).join(' '), /配置读不动/);
});

test('composer 浮层：搜索、键盘与点选插入、回焦、错误与超时都覆盖', async () => {
  const props = { sessionId: 'ses-1', useSessions: () => '/p', useInput: () => ({ draft: '已有草稿' }), inputActions: { setDraft: (text) => inserts.push(text) } };
  const inserts = [];

  const { Component, react, focusCalls } = await mountButton();
  const first = react.render(Component, props);
  const icon = findElement(first.tree, (element) => element.props?.title === '插入 /技能名');
  icon.props.onClick();

  let frame = react.render(Component, props);
  for (const effect of frame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  frame = react.render(Component, props);

  // 搜索过滤
  const search = findElement(frame.tree, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…');
  search.props.onChange({ target: { value: 'alp' } });
  frame = react.render(Component, props);
  assert.match(collectText(frame.tree).join(' '), /\/alpha/);

  // 搜索无结果
  findElement(frame.tree, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…').props.onChange({ target: { value: 'zzz' } });
  frame = react.render(Component, props);
  assert.match(collectText(frame.tree).join(' '), /没有匹配的技能/);

  // 回车：插入第一条
  const input = findElement(frame.tree, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…');
  input.props.onChange({ target: { value: '' } });
  frame = react.render(Component, props);
  findElement(frame.tree, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…')
    .props.onKeyDown({ key: 'Enter' });
  assert.equal(inserts.at(-1), '已有草稿 /alpha ', '插入应接在现有草稿之后并回焦');
  assert.deepEqual(focusCalls, ['focus', 'selection'], '插入后要把焦点还给 composer');

  // Escape：关闭浮层
  frame = react.render(Component, props);
  const icon2 = findElement(frame.tree, (element) => element.props?.title === '插入 /技能名');
  icon2.props.onClick();
  frame = react.render(Component, props);
  findElement(frame.tree, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…')
    .props.onKeyDown({ key: 'Escape' });
  frame = react.render(Component, props);
  assert.doesNotMatch(collectText(frame.tree).join(' '), /搜索技能/, 'Escape 应关闭浮层');

  // 点选候选按钮（含"仅手动"标记）
  const icon3 = findElement(frame.tree, (element) => element.props?.title === '插入 /技能名');
  icon3.props.onClick();
  frame = react.render(Component, props);
  for (const effect of frame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  frame = react.render(Component, props);
  const choice = findElement(frame.tree, (element) => element.type === 'button' && labelOf(element).includes('/alpha'));
  assert.match(labelOf(choice), /仅手动/, 'manual 技能带标记');
  choice.props.onClick();
  assert.equal(inserts.at(-1), '已有草稿 /alpha ');

  // 加载失败：显示错误文案
  const failing = await mountButton({ fail: new Error('boom') });
  const failedFirst = failing.react.render(failing.Component, props);
  findElement(failedFirst.tree, (element) => element.props?.title === '插入 /技能名').props.onClick();
  let failedFrame = failing.react.render(failing.Component, props);
  for (const effect of failedFrame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  failedFrame = failing.react.render(failing.Component, props);
  assert.match(collectText(failedFrame.tree).join(' '), /加载失败：boom/);

  // 超时：fetch 抛 TimeoutError → 转成中文超时提示
  const timeout = await mountButton({ fail: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) });
  const timeoutFirst = timeout.react.render(timeout.Component, props);
  findElement(timeoutFirst.tree, (element) => element.props?.title === '插入 /技能名').props.onClick();
  let timeoutFrame = timeout.react.render(timeout.Component, props);
  for (const effect of timeoutFrame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  timeoutFrame = timeout.react.render(timeout.Component, props);
  assert.match(collectText(timeoutFrame.tree).join(' '), /面板 RPC 超时/);
});

test('composer 按钮：props 缺席时降级（无 useInput / useSessions 走选择器）', async () => {
  const seen = [];
  // useSessions 是选择器 hook：宿主会用它选 cwd，这里顺带覆盖 selector 两条分支。
  const withSelector = await mountButton();
  const props = {
    sessionId: 'ses-1',
    useSessions: (selector) => {
      seen.push(selector({ byId: { 'ses-1': { cwd: '/from-selector' } } }));
      seen.push(selector({ byId: { 'ses-1': { cwd: null } } })); // 非字符串 → ''
      return '/from-selector';
    },
    inputActions: { setDraft: () => {} },
  };
  const first = withSelector.react.render(withSelector.Component, props);
  assert.match(collectText(first.tree).join(' '), /技能/, '缺 useInput 时用占位 hook，仍要能渲染');
  assert.deepEqual(seen, ['/from-selector', '']);

  // 完全没有 useSessions：回落到 rpc('workspaces') 的第一个工作区
  const noSessions = await mountButton();
  const frame = noSessions.react.render(noSessions.Component, { inputActions: { setDraft: () => {} } });
  findElement(frame.tree, (element) => element.props?.title === '插入 /技能名').props.onClick();
  let next = noSessions.react.render(noSessions.Component, {});
  for (const effect of next.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  next = noSessions.react.render(noSessions.Component, {});
  assert.match(collectText(next.tree).join(' '), /\/alpha/, '拿不到 useSessions 时用工作区列表兜底');
});

test('composer 浮层：点击外部关闭、插入失败提示、回焦失败被吞掉', async () => {
  const { Component, react, documentListeners, focusCalls } = await mountButton({ selectionThrows: true });
  const props = { sessionId: 'ses-1', useSessions: () => '/p', useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } };

  findElement(react.render(Component, props).tree, (element) => element.props?.title === '插入 /技能名').props.onClick();
  let frame = react.render(Component, props);
  for (const effect of frame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  frame = react.render(Component, props);
  const popupOpen = (tree) => findElement(tree, (element) => element.type === 'input' && element.props.placeholder === '搜索技能…') !== undefined;
  assert.ok(popupOpen(frame.tree), '浮层已打开');

  // 点在浮层内部：不关闭
  const onDown = documentListeners.find((entry) => entry.type === 'mousedown').callback;
  onDown({ target: {} });
  frame = react.render(Component, props);
  assert.ok(popupOpen(frame.tree), '点在浮层内不该关闭');

  // 点在浮层外部：关闭
  refControl.contains = false;
  onDown({ target: {} });
  frame = react.render(Component, props);
  assert.equal(popupOpen(frame.tree), false, '点击外部应关闭浮层');

  // 插入成功后回焦：setSelectionRange 抛错被吞掉，focus 仍然发生
  const icon = findElement(frame.tree, (element) => element.props?.title === '插入 /技能名');
  icon.props.onClick();
  frame = react.render(Component, props);
  for (const effect of frame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  frame = react.render(Component, props);
  findElement(frame.tree, (element) => element.type === 'button' && labelOf(element).includes('/alpha')).props.onClick();
  assert.deepEqual(focusCalls, ['focus'], 'selectionRange 抛错不该阻断回焦');

  // inputActions 缺失：pick 报错并显示在浮层里（不静默）
  const broken = await mountButton();
  const brokenProps = { sessionId: 'ses-1', useSessions: () => '/p', useInput: () => ({ draft: '' }) };
  findElement(broken.react.render(broken.Component, brokenProps).tree, (element) => element.props?.title === '插入 /技能名').props.onClick();
  let brokenFrame = broken.react.render(broken.Component, brokenProps);
  for (const effect of brokenFrame.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  brokenFrame = broken.react.render(broken.Component, brokenProps);
  findElement(brokenFrame.tree, (element) => element.type === 'button' && labelOf(element).includes('/alpha')).props.onClick();
  brokenFrame = broken.react.render(broken.Component, brokenProps);
  assert.match(collectText(brokenFrame.tree).join(' '), /inputActions\.setDraft/, '缺 setDraft 要显式报错');
});

test('设置面板：没有可配置工作区 / 只有 state 失败 / 写盘失败都给出可见提示', async () => {
  const { view: emptyView } = await mountSectionAndWait({
    state: { ...MIN_STATE, workspaces: [] },
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, value: { workspaces: [] } }) }),
  });
  assert.match(collectText(emptyView()).join(' '), /没有可配置的工作区/);

  // workspaces 成功、state 失败：错误来自 refresh 的 catch
  const { view: stateFailView } = await mountSectionAndWait({
    state: MIN_STATE,
    fetchImpl: async (_url, init) => {
      const { method } = JSON.parse(init.body);
      if (method === 'workspaces') return { status: 200, json: async () => ({ ok: true, value: { workspaces: MIN_STATE.workspaces } }) };
      return { status: 500, json: async () => { throw new Error('boom'); } };
    },
  });
  assert.match(collectText(stateFailView()).join(' '), /非 JSON/);

  // 写操作失败：错误显示在面板上
  const { view: writeFailView } = await mountSectionAndWait({
    state: INTERACTIVE_STATE,
    fetchImpl: async (_url, init) => {
      const { method } = JSON.parse(init.body);
      if (method === 'setSkill') return { status: 200, json: async () => ({ ok: false, error: '写盘被拒' }) };
      const value = method === 'workspaces' ? { workspaces: INTERACTIVE_STATE.workspaces } : INTERACTIVE_STATE;
      return { status: 200, json: async () => ({ ok: true, value }) };
    },
  });
  findElement(writeFailView(), (element) => element.type === 'select' && element.props['aria-label'] === '技能 exact-skill 的注入状态')
    .props.onChange({ target: { value: 'off' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(collectText(writeFailView()).join(' '), /写盘被拒/);

  // localStorage 不可写时切换工作区：仍然照常发请求
  const { view: storageFailView } = await mountSectionAndWait({ state: MIN_STATE, storageThrows: true });
  findElement(storageFailView(), (element) => element.type === 'select' && element.props.value === MIN_STATE.scope.cwd)
    .props.onChange({ target: { value: '/Users/example/code/demo' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(collectText(storageFailView()).join(' '), /工作区能力/);
});

test('设置面板：effect cleanup 可安全执行（卸载后不再更新状态）', async () => {
  const { Component, react, logic } = await mountSection();
  const { effects } = react.render(Component, { close: () => {} });
  const cleanups = effects.map((effect) => effect());
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup();
  }
  // 卸载后挂起的异步回调命中 cancelled 分支：不得抛错、不得再 setState
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    cleanups.filter((cleanup) => typeof cleanup === 'function').length,
    effects.length,
    '每个 effect 都应返回 cleanup（数据加载取消 + hover 计时器清理）',
  );
});

test('设置面板：配置损坏时给出可见提示，并区分是否沿用了上一次有效配置', async () => {
  const broken = await mountSectionAndWait({
    state: { ...MIN_STATE, scope: { ...MIN_STATE.scope, readError: 'JSON 解析失败：坏' } },
  });
  assert.match(collectText(broken.view()).join(' '), /配置文件有问题：JSON 解析失败/, '损坏必须可见');

  const fallback = await mountSectionAndWait({
    state: { ...MIN_STATE, scope: { ...MIN_STATE.scope, readError: 'JSON 解析失败：坏', readFallback: true } },
  });
  assert.match(
    collectText(fallback.view()).join(' '),
    /已沿用上一次有效配置/,
    '沿用了上一次有效值时要说明，避免用户以为策略没生效',
  );
});
