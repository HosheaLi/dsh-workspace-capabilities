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
  bundle.factory((name) => seedRequire(name, { react: react.api })).apply(ctx);

  const section = registered['settings.section'];
  assert.ok(section !== undefined, 'apply 必须注册 settings.section');
  return { Component: section.Component, react, storage };
}

/** 把 element 树里的文本节点摊平，用于断言文案。 */
function collectText(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  // 替身 React 不渲染函数组件，这里补上：settings 一节的子组件（ScopeHeader / SkillTable /
  // SkillRow / McpSection / TriState）都不含 hook，可以在收集阶段安全展开。
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
  assert.match(text, /正在读取配置来源/, '首帧应显示占位而不是崩溃');
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

test('state 到达后渲染完整面板：项目根/写入层/MCP 分区齐备', async () => {
  const { Component, react } = await mountSection();
  const { effects } = react.render(Component, { close: () => {} });
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { tree } = react.render(Component, { close: () => {} });
  const text = collectText(tree).join(' ');
  assert.match(text, /写入全局层/, '应显示配置写入层');
  assert.match(text, /MCP 服务器/, '应渲染 MCP 分区');
  assert.match(text, /共 1 个技能/, '应渲染总数统计');

  // 回归：列模板原来把描述列写成裸 `1fr`，而描述单元格带 overflow:hidden（自动最小
  // 尺寸为 0），面板不够宽时它被压成 0 宽、内容被裁光 —— 整个描述列空白。
  const templates = collectGridTemplates(tree);
  assert.ok(templates.length >= 2, '表格应有表头行与数据行');
  for (const template of templates) {
    assert.match(template, /minmax\(126px/, '描述列必须带宽度下限，否则会被压成 0 宽');
  }
  assert.equal(new Set(templates).size, 1, '表头与数据行必须共用同一套列模板，否则会列错位');
  assert.match(text, /这是一个用来验证描述列会真的渲染出来的技能说明/, '描述必须真的渲染进树里');
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
  const { Component, react, storage } = await mountSection(options);
  const first = react.render(Component, { close: () => {} });
  assert.ok(first.tree !== undefined, '首帧必须能渲染');
  const { effects } = react.render(Component, { close: () => {} });
  for (const effect of effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { Component, react, storage, view: () => react.render(Component, { close: () => {} }).tree };
}

const INTERACTIVE_STATE = {
  ...MIN_STATE,
  skills: [
    { name: 'exact-skill', description: '有精确配置', source: 'custom', sourceLabel: '自定义目录', invocation: { modelInvocable: true, userInvocable: true }, path: '/x/a/SKILL.md', manageable: true, size: 100, state: 'manual', matchedKey: 'exact-skill' },
    { name: 'glob-skill', description: '命中通配符的技能', source: 'custom', sourceLabel: '自定义目录', invocation: { modelInvocable: true, userInvocable: true }, path: '/x/b/SKILL.md', manageable: true, size: 2048, state: 'off', matchedKey: 'glob-*' },
    { name: 'bundled-skill', description: '不可接管', source: 'bundled', sourceLabel: '包内置', invocation: { modelInvocable: true, userInvocable: true }, manageable: false, reason: '包内置技能正文不在磁盘上，接管会让 /名 静默失效', state: 'off' },
    { name: 'not-applied', description: '配置说关了但注册表仍可见', source: 'custom', sourceLabel: '自定义目录', invocation: { modelInvocable: true, userInvocable: true }, path: '/x/c/SKILL.md', manageable: true, size: 300, state: 'manual', matchedKey: undefined },
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

  assert.match(text, /共 4 个技能：隐藏 3（关闭 2），不可管理 1/);
  assert.match(text, /不可管理/, 'bundled 技能应有标记');
  assert.match(text, /未生效\?/, '配置说关了但注册表仍可见时必须提示');
  assert.match(text, /显式配置/, '精确命中显示"显式配置"');
  assert.match(text, /命中 glob-\*/, '通配符命中显示模式名');
  assert.match(text, /2\.0 KB/, '体积可读化');
  assert.match(text, /2 个工具/, 'MCP 分区显示工具数');
  assert.match(text, /可见 0\/2|全部可见/, '有探针时报可见数');

  // 通配符命中的行不该给"清除"（点了没反应）；精确命中才给。
  const clearButtons = collectElementsDeep(tree).filter((element) => element.type === 'button' && labelOf(element) === '清除');
  assert.equal(clearButtons.length, 1, '只有精确键命中才该有清除按钮');
});

test('设置面板：三态/清除/默认/MCP/搜索/切换工作区都会发出对应 RPC', async () => {
  const calls = [];
  const { react, storage, view } = await mountSectionAndWait({ state: INTERACTIVE_STATE, onRpc: (method, args) => calls.push({ method, args }) });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  // 三态：把 exact-skill 切到"关闭"
  const manualToOff = findElement(view(), (element) => element.type === 'button' && labelOf(element) === '关闭');
  assert.ok(manualToOff !== undefined, '应渲染三态按钮');
  manualToOff.props.onClick();
  await flush();
  assert.ok(calls.some((call) => call.method === 'setSkill' && call.args.state === 'off'), JSON.stringify(calls));

  // 清除：精确命中那一行
  findElement(view(), (element) => element.type === 'button' && labelOf(element) === '清除').props.onClick();
  await flush();
  assert.ok(calls.some((call) => call.method === 'setSkill' && call.args.state === 'default'));

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

  // 只看非默认项
  const onlyProblem = findElement(view(), (element) => element.type === 'input' && element.props.type === 'checkbox' && element.props.checked === false);
  onlyProblem.props.onChange({ target: { checked: true } });

  // 切换工作区：写入 localStorage 并重新拉状态
  const workspaceSelect = findElement(view(), (element) => element.type === 'select' && element.props.value === MIN_STATE.scope.cwd);
  workspaceSelect.props.onChange({ target: { value: '/Users/example/code/demo' } });
  await flush();
  assert.equal(storage.get('dsh-workspace-scope.cwd'), '/Users/example/code/demo', '选择的工作区要记住');
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
  findElement(writeFailView(), (element) => element.type === 'button' && labelOf(element) === '关闭').props.onClick();
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
  const { Component, react } = await mountSection();
  const { effects } = react.render(Component, { close: () => {} });
  const cleanups = effects.map((effect) => effect());
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup();
  }
  // 卸载后挂起的异步回调命中 cancelled 分支：不得抛错、不得再 setState
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cleanups.filter((cleanup) => typeof cleanup === 'function').length, 1, 'effect 应返回 cleanup');
});
