/**
 * policy.js 的单元测试：缓存命中/失效，以及"在途读不得把已作废的结果写回缓存"。
 *
 * 纯 JS，无宿主依赖。跑法：`npm test`。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPolicyResolver } from '../lib/policy.js';

/** 建一个带项目层的最小工作区（含 `.git`，所以项目层生效）。 */
async function makeWorkspace() {
  const home = await mkdtemp(join(tmpdir(), 'wscope-policy-'));
  const cwd = join(home, 'proj');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await mkdir(join(cwd, '.dsh'), { recursive: true });
  await mkdir(join(home, 'settings'), { recursive: true });
  return { home, cwd, projectPath: join(cwd, '.dsh', 'skills-scope.json') };
}

/** 把某个技能的状态写进项目配置。 */
function writeGlobal(home, state) {
  return writeFile(join(home, 'settings', 'skills-scope.json'), JSON.stringify({ version: 1, skills: { alpha: state }, mcp: {} }));
}

test('TTL 内命中缓存；fresh 与 invalidate 都强制重读盘', async () => {
  const { home, cwd } = await makeWorkspace();
  try {
    await writeGlobal(home, 'pinned');
    const policy = createPolicyResolver({ env: { DSH_HOME: home }, ttlMs: 60_000 });

    assert.equal((await policy.read(cwd)).stateOf('alpha'), 'pinned');
    await writeGlobal(home, 'off');
    assert.equal((await policy.read(cwd)).stateOf('alpha'), 'pinned', 'TTL 内应命中缓存，不重读盘');
    assert.equal((await policy.read(cwd, { fresh: true })).stateOf('alpha'), 'off', 'fresh 必须重读盘');
    policy.invalidate();
    assert.equal((await policy.read(cwd)).stateOf('alpha'), 'off', 'invalidate 后必须重读盘');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('在途 read 不得把 invalidate 之后作废的结果写回缓存', async () => {
  // 回归：`read()` 曾经在 `compute()` 完成后无条件 `cache.set`，于是"写盘 → invalidate"
  // 之后，一条更早发起、尚未完成的读会把旧策略重新写回缓存，让"改配置即时生效"退化成
  // "最多晚一个 TTL"。
  //
  // 窗口很窄，所以这里反复构造：项目层放一份大配置，把 `compute()` 里读盘的时间拉到
  // 毫秒级，在读盘期间改配置并 invalidate。修复正确时**任何**时序都不会污染缓存，因此
  // 断言"0 轮污染"不会误报；修复缺失时只要有一轮命中窗口就会失败。
  const { home, cwd, projectPath } = await makeWorkspace();
  try {
    await writeFile(projectPath, JSON.stringify({ version: 1, skills: {}, mcp: {}, pad: 'x'.repeat(16 * 1024 * 1024) }));

    const ROUNDS = 12;
    let stale = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      await writeGlobal(home, 'pinned');
      const policy = createPolicyResolver({ env: { DSH_HOME: home }, ttlMs: 60_000 });
      const inflight = policy.read(cwd); // 未命中：开始读盘（此刻磁盘上是 pinned）
      await new Promise((resolve) => setTimeout(resolve, 1));
      await writeGlobal(home, 'off'); // 读盘期间写盘方改配置
      policy.invalidate(); // 并打掉缓存
      await inflight; // 在途读完成：修复前会把 pinned 重新写回缓存
      if ((await policy.read(cwd)).stateOf('alpha') !== 'off') stale += 1;
    }

    assert.equal(stale, 0, `${stale}/${ROUNDS} 轮里，作废的在途读把旧策略写回了缓存`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
