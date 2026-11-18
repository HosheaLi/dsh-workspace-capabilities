#!/usr/bin/env node
/**
 * 用官方校验器检查 index.json（format 1）与 package.json 是否对得上。
 *
 * 校验器不随本包发布，先装到临时目录：
 *   npm install --prefix /tmp/dsh-market-check @deepseek-ai/dsh-plugin-market-index
 *   DSH_MARKET_INDEX_MODULE=/tmp/dsh-market-check/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js \
 *     node tools/check-market-index.mjs
 *
 * 也可以把 @deepseek-ai/dsh-plugin-market-index 装进当前 node_modules，省略环境变量。
 */

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INDEX_URL = process.env.DSH_INDEX_URL
  ?? 'https://cdn.jsdelivr.net/gh/HosheaLi/dsh-workspace-capabilities@main/index.json'
const MODULE = process.env.DSH_MARKET_INDEX_MODULE ?? '@deepseek-ai/dsh-plugin-market-index'

const specifier = MODULE.startsWith('/') ? pathToFileURL(MODULE).href : MODULE
const { parseMarketIndex } = await import(specifier)

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const raw = JSON.parse(await readFile(join(ROOT, 'index.json'), 'utf8'))
const index = parseMarketIndex(raw, INDEX_URL)

if (index.plugins.length !== 1) throw new Error(`索引应只列本插件，实际 ${index.plugins.length} 条`)
const plugin = index.plugins[0]
if (plugin.name !== pkg.name) throw new Error(`索引包名 ${plugin.name} 与 package.json ${pkg.name} 不一致`)

const current = plugin.versions.find((version) => version.version === pkg.version)
if (!current) throw new Error(`索引里没有当前版本 ${pkg.version}`)
if (current.engines.dsh !== pkg.engines?.dsh) {
  throw new Error(`索引 engines.dsh ${current.engines.dsh} 与 package.json ${pkg.engines?.dsh} 不一致`)
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (current.source.type !== 'git') throw new Error('当前版本应使用 git source')
if (current.source.commit !== head) {
  console.warn(`提示：索引钉在 ${current.source.commit.slice(0, 7)}，HEAD 是 ${head.slice(0, 7)}（发布代码后重新生成即可）`)
}

console.log(`索引有效：${index.title.en} / ${index.plugins.length} 个插件`)
for (const version of plugin.versions) {
  console.log(`  ${plugin.name}@${version.version} -> ${version.source.commit.slice(0, 7)} (${new Date(version.publishTimestamp * 1000).toISOString()})`)
}
