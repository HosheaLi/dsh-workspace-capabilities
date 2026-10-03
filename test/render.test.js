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
import { pathToFileURL } from 'node:url';

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url);

/** 单调计数器：`Date.now()` 同毫秒会撞上 ESM 模块缓存，缓存命中的 factory 不再执行。 */
let loadSeq = 0;

/** 替身 React：hooks 每次 render 重置游标、跨 render 保留槽位；effect 只收集不执行。 */
function createReact() {
  let hooks = [];
  let hookIndex = 0;
  let effects = [];
  return {
    api: {
      createElement: (type, props, ...children) => ({
        type,
        props: props ?? {},
        children: children.flat(),
      }),
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
 * @returns 组件函数与替身 React 的 render 入口。
 */
async function mountSection() {
  const react = createReact();
  const storage = new Map();
  let bundle;

  globalThis.window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    __ModuleLoader__: { load: (entry) => { bundle = entry; } },
  };
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const value = method === 'workspaces'
      ? { workspaces: MIN_STATE.workspaces }
      : MIN_STATE;
    return { status: 200, json: async () => ({ ok: true, value }) };
  };

  await import(`${pathToFileURL(CLIENT_PATH.pathname).href}?t=${++loadSeq}`);
  assert.ok(bundle !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load');

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
  bundle.factory((name) => {
    if (name === 'react') return react.api;
    throw new Error(`bundle 不允许 require 平台种子之外的模块：${name}`);
  }).apply(ctx);

  const section = registered['settings.section'];
  assert.ok(section !== undefined, 'apply 必须注册 settings.section');
  return { Component: section.Component, react };
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
 * @returns 组件函数与替身 React 的 render 入口。
 */
async function mountButton() {
  const react = createReact();
  let bundle;

  globalThis.window = {
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (fn) => fn(),
    __ModuleLoader__: { load: (entry) => { bundle = entry; } },
  };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const value = method === 'workspaces'
      ? { workspaces: [{ id: 'w1', title: 'demo', path: '/p' }] }
      : { skills: [{ name: 'alpha', description: '第一个技能', state: 'manual' }] };
    return { status: 200, json: async () => ({ ok: true, value }) };
  };

  await import(`${pathToFileURL(CLIENT_PATH.pathname).href}?t=${++loadSeq}`);
  assert.ok(bundle !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load');

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
  bundle.factory((name) => {
    if (name === 'react') return react.api;
    throw new Error(`bundle 不允许 require 平台种子之外的模块：${name}`);
  }).apply(ctx);

  const button = registered['conversation.input.right'];
  assert.ok(button !== undefined, 'apply 必须注册 conversation.input.right');
  return { Component: button.Component, react };
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
