/**
 * 加载 client bundle 的入口对象（`{ id, factory }`），**同一进程只加载一次**。
 *
 * 为什么需要它：覆盖率按脚本 URL 记录，用 `?t=<n>` 绕过 ESM 缓存会让同一个
 * `lib/client.js` 变成多个实例，报告只保留其中一个（实测全量跑只统计到"从不渲染"
 * 的那个实例，client.js 行覆盖被压到 22%，而真正渲染组件的那次是 61%）。
 *
 * bundle 入口本身与宿主环境无关，加载一次即可；每个用例需要独立环境时，直接再次
 * 调用 `entry.factory(require)` —— factory 会重新执行一遍，产出全新的 exports 与
 * 组件闭包，而 V8 覆盖率仍累积到同一个脚本上。
 */

import { pathToFileURL } from 'node:url';

const CLIENT_PATH = new URL('../../lib/client.js', import.meta.url);

/** @type {Promise<{id: string, factory: (require: (name: string) => unknown) => any}> | undefined} */
let entryPromise;

/** 加载并返回 bundle 入口（幂等）。 */
export async function loadBundleEntry() {
  if (entryPromise === undefined) {
    entryPromise = (async () => {
      let captured;
      const previousWindow = globalThis.window;
      globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
      try {
        await import(pathToFileURL(CLIENT_PATH.pathname).href);
      } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
      }
      if (captured === undefined) throw new Error('bundle 必须调用 window.__ModuleLoader__.load');
      return captured;
    })();
  }
  return entryPromise;
}

/** 只允许 require 平台种子（react）的 require 替身。 */
export function seedRequire(name, seeds) {
  const seed = seeds[name];
  if (seed === undefined) throw new Error(`bundle 不允许 require 平台种子之外的模块：${name}`);
  return seed;
}
