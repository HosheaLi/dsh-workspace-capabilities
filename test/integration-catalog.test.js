/**
 * 集成测试：技能目录（`<available_skills>`）的**发布语义**。
 *
 * 这里锁的是宿主 0.2.0-rc.2 的行为（发布者在 `dsh-tool-skill` 的 `agent/pre-step` 上），
 * 本插件只决定"哪些技能对模型可见"。之所以要固化成测试：宿主升级时这些语义一旦变化，
 * 面板开关就会静默失效或让模型抱着过期目录不放 —— 那是看不见的回归。
 *
 * 实测结论（见 docs/probe-skill-catalog-publish.mjs）：
 *  1. 首次发布是一条 **durable user 消息**（`source.kind='skill-catalog'`，无 `update`）；
 *  2. 目录没变时**完全静默**，一条消息都不追加；
 *  3. 目录变化时发布 `update`（带**全量** entries），并且**追加**为新消息，不就地替换；
 *  4. 面板 RPC 写盘后，下一个 `pre-step` 就能看到新目录（不需要重启/新开会话）。
 *
 * 跑法：DSH_RUNTIME_DIR=/tmp/dshref/runtime node --test test/integration-catalog.test.js
 * 缺解包运行时整组 skip，新克隆上 `npm test` 不会因此变红。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_READY, SKIP_REASON, makeCatalogHarness, writeSkill } from './helpers/catalog-harness.js';

/**
 * 集成用例入口。
 * @param name - 用例名。
 * @param fn - 用例体。
 * @param options - node:test 选项。
 */
function catalogTest(name, fn, options = {}) {
  return test(name, { skip: RUNTIME_READY ? false : SKIP_REASON, ...options }, fn);
}

/** 每个用例一套临时目录：DSH_HOME、项目（有 `.git` 才有项目层）、自定义技能根。 */
async function withProject(run) {
  const base = await mkdtemp(join(tmpdir(), 'wscope-catalog-'));
  const previousHome = process.env.DSH_HOME;
  const dshHome = join(base, 'dsh-home');
  const projectDir = join(base, 'project');
  const customDir = join(base, 'custom');
  process.env.DSH_HOME = dshHome;
  for (const dir of [
    join(dshHome, 'settings'),
    join(dshHome, 'skills'),
    join(projectDir, '.git'),
    join(projectDir, '.dsh', 'skills'),
    customDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  try {
    await run({ base, dshHome, customDir, projectDir });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  }
}

/** 三个项目级技能 + 一套 harness，退出时保证 dispose。 */
async function withCatalogHarness(run, { skills = ['alpha-skill', 'beta-skill', 'gamma-skill'] } = {}) {
  await withProject(async ({ dshHome, customDir, projectDir }) => {
    for (const name of skills) await writeSkill(join(projectDir, '.dsh', 'skills'), name);
    const harness = await makeCatalogHarness({ dshHome, customDir, projectDir });
    try {
      await run(harness, { dshHome, customDir, projectDir });
    } finally {
      await harness.dispose();
    }
  });
}

/** 一条目录消息里的技能名（排序后便于比对）。 */
const namesOf = (message) => message.source.entries.map((entry) => entry.name).sort();

catalogTest('首次发布：追加一条 source.kind=skill-catalog 的 durable user 消息（不带 update 标记）', async () => {
  await withCatalogHarness(async (harness) => {
    const result = await harness.preStep({ claims: [harness.userMessage('帮我看下这些技能')], step: 1 });

    assert.equal(result.published.length, 1, `首次应发布且只发布一条目录消息：${JSON.stringify(result.published)}`);
    const [catalog] = result.published;
    assert.equal(catalog.source.kind, 'skill-catalog');
    assert.notEqual(catalog.source.update, true, '首次发布是初始目录，不带 update 标记');
    assert.equal(catalog.source.form, 'catalog', 'source.form 应标明这是目录形态');
    assert.deepEqual(namesOf(catalog), ['alpha-skill', 'beta-skill', 'gamma-skill'], '初始目录应包含全部 pinned 技能');
    for (const entry of catalog.source.entries) {
      assert.equal(typeof entry.description, 'string', 'entries 必须带 description（模型只看这份投影）');
    }

    // durable：它是会话里的一条 user/message，排在 claims 之后，不是系统提示词里的片段。
    const events = harness.catalogEvents();
    assert.equal(events.length, 1, '目录消息必须落进会话事件');
    assert.equal(events[0].type, 'user/message');
    assert.equal(events[0].seq, 1, '会话顺序：先 claims 的 user 消息（seq 0），再目录消息（seq 1）');
    assert.ok(harness.session.surface.nodes.includes(events[0].seq), '目录消息必须落在会话可见面上');

    const text = harness.catalogTexts()[0];
    assert.match(text, /<available_skills>/, '正文里应有模型可见的技能清单');
    for (const name of ['alpha-skill', 'beta-skill', 'gamma-skill']) {
      assert.match(text, new RegExp(name), `${name} 应出现在目录正文里`);
    }
  });
});

catalogTest('目录未变：后续 pre-step 完全静默（不产生任何消息、会话不增长）', async () => {
  await withCatalogHarness(async (harness) => {
    const first = await harness.preStep({ claims: [harness.userMessage('开始')], step: 1 });
    assert.equal(first.published.length, 1, '前置：首次必须发布');
    const seqAfterFirst = harness.session.seq;
    const catalogSeq = harness.catalogEvents()[0].seq;

    for (const step of [2, 3]) {
      const silent = await harness.preStep({ step });
      assert.equal(silent.published.length, 0, `第 ${step} 步目录没变，不该发布目录消息`);
      assert.equal(silent.appended.length, 0, `第 ${step} 步目录没变，一条消息都不该追加`);
    }

    assert.equal(harness.session.seq, seqAfterFirst, '静默意味着会话长度不变');
    assert.equal(harness.catalogEvents().length, 1, '会话里仍然只有首次那一条目录消息');
    assert.equal(harness.catalogEvents()[0].seq, catalogSeq, '已有的目录消息不该被改动');
  });
});

catalogTest('目录变化：update 带全量 entries，并作为新消息追加（不就地替换）', async () => {
  await withCatalogHarness(async (harness, { projectDir }) => {
    await harness.preStep({ claims: [harness.userMessage('开始')], step: 1 });
    const [initial] = harness.catalogEvents();
    const initialText = initial.data.content[0].text;

    const written = await harness.callRpc('setSkill', { cwd: projectDir, name: 'beta-skill', state: 'off' });
    assert.equal(written.ok, true, JSON.stringify(written));

    const changed = await harness.preStep({ step: 2 });
    assert.equal(changed.published.length, 1, '目录变化后应发布一条');
    const [update] = changed.published;
    assert.equal(update.source.update, true, '变化后发布的必须是 update 形态');
    assert.deepEqual(
      namesOf(update),
      ['alpha-skill', 'gamma-skill'],
      '未变化的技能也必须在 entries 里 —— 这是全量目录，不是"只报被改的那个"',
    );
    for (const entry of update.source.entries) {
      assert.equal(typeof entry.description, 'string', '全量 entries 同样要带 description');
    }

    // 追加，而不是就地替换：旧消息 seq 与内容原封不动，新消息排在它后面。
    const events = harness.catalogEvents();
    assert.equal(events.length, 2, '会话里目录消息数 +1，而不是被替换');
    assert.equal(events[0].seq, initial.seq, '旧目录消息的 seq 不得被改写');
    assert.equal(events[0].data.content[0].text, initialText, '旧目录消息的内容不得被就地覆盖');
    assert.ok(events[1].seq > events[0].seq, '新目录消息必须追加在旧消息之后');
    assert.ok(harness.session.surface.nodes.includes(events[1].seq), '新目录消息也落在可见面上');
    assert.deepEqual(
      harness.session.events.map((event) => event.data.source?.kind ?? event.data.role),
      ['user', 'skill-catalog', 'skill-catalog'],
      '会话顺序：user → 初始目录 → 更新目录',
    );

    // update 是"替换语义"的完整目录：正文里不该再出现被关掉的技能。
    const text = harness.catalogTexts()[1];
    assert.match(text, /<available_skills>/);
    assert.doesNotMatch(text, /beta-skill/, '被 off 的技能不得出现在新目录正文里');
    assert.match(text, /alpha-skill/);
    assert.match(text, /gamma-skill/);
  });
});

catalogTest('生效时机：面板 RPC 写盘后，下一个 pre-step 立刻看到新目录（无需重启/新开会话）', async () => {
  await withCatalogHarness(async (harness, { projectDir }) => {
    await harness.preStep({ claims: [harness.userMessage('开始')], step: 1 });

    // 立刻改，不等待、不重启、不新开会话。
    const off = await harness.callRpc('setSkill', { cwd: projectDir, name: 'beta-skill', state: 'off' });
    assert.equal(off.ok, true, JSON.stringify(off));
    const afterOff = await harness.preStep({ step: 2 });
    assert.equal(afterOff.published.length, 1, '写盘后的下一步必须发布更新');
    assert.deepEqual(namesOf(afterOff.published[0]), ['alpha-skill', 'gamma-skill'], '关掉的技能必须立刻从目录里消失');

    // 改回来同样立即生效（不是单向的一次性快照）。
    const pinned = await harness.callRpc('setSkill', { cwd: projectDir, name: 'beta-skill', state: 'pinned' });
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    const afterPinned = await harness.preStep({ step: 3 });
    assert.equal(afterPinned.published.length, 1, '改回来也要发布更新');
    assert.deepEqual(
      namesOf(afterPinned.published[0]),
      ['alpha-skill', 'beta-skill', 'gamma-skill'],
      '改回 pinned 后技能必须立刻回到目录里',
    );

    // 已发布的目录又稳定下来 → 回到静默，不反复重发。
    const settled = await harness.preStep({ step: 4 });
    assert.equal(settled.published.length, 0, '目录稳定后必须静默');
    assert.equal(harness.catalogEvents().length, 3, '累计 3 条：初始 + off + 回到 pinned');
  });
});

catalogTest('批量 setSkills：一次调用改 N 个技能，只追加一条 update 目录消息', async () => {
  await withCatalogHarness(async (harness, { projectDir }) => {
    await harness.preStep({ claims: [harness.userMessage('开始')], step: 1 });
    assert.equal(harness.catalogEvents().length, 1, '前置：只有初始目录');

    // 一次调用把两个技能设为 manual：写盘一次、缓存失效一次、目录只该变一次。
    const written = await harness.callRpc('setSkills', {
      cwd: projectDir,
      names: ['alpha-skill', 'gamma-skill'],
      state: 'manual',
    });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(written.value.noop, false, '两个名字都该真实落盘');
    assert.deepEqual([...written.value.applied].sort(), ['alpha-skill', 'gamma-skill'], '整批名字都要生效');
    assert.deepEqual(written.value.skipped, [], '没有该被跳过的名字');

    // 一次写盘：两个键在同一个配置文件里。
    const config = JSON.parse(await readFile(join(projectDir, '.dsh', 'skills-scope.json'), 'utf8'));
    assert.deepEqual(config.skills, { 'alpha-skill': 'manual', 'gamma-skill': 'manual' });

    const changed = await harness.preStep({ step: 2 });
    assert.equal(changed.published.length, 1, '整批改动只应发布一条目录消息，而不是每个名字一条');
    assert.equal(changed.published[0].source.update, true);
    assert.deepEqual(namesOf(changed.published[0]), ['beta-skill'], 'update 仍是全量：只剩未被改动的那个技能');
    assert.equal(harness.catalogEvents().length, 2, '会话里目录消息数 +1');

    // 稳定后静默，不因为"批量"而反复重发。
    const settled = await harness.preStep({ step: 3 });
    assert.equal(settled.published.length, 0, '目录稳定后必须静默');
    assert.equal(harness.catalogEvents().length, 2);
  });
});
