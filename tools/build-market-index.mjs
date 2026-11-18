#!/usr/bin/env node
/**
 * 生成 DSH 插件市场 format 1 索引（index.json）。
 *
 * 索引与服务端无关：一个 JSON 文件 + 同目录的 icon.svg 放在任何静态托管上即可，
 * 用户把它加进「插件 / 发现 / 索引源」后就能浏览和安装。
 *
 * 版本来自 git 提交：每个 index.json 里的版本都钉在发布代码的那个 commit 上，
 * 所以索引更新不会改变已经发布的版本。首次发布前先提交代码，再跑本脚本并提交 index.json。
 *
 * 用法：
 *   npm run build:index
 *   node tools/build-market-index.mjs --commit <sha> --timestamp <unix 秒>   # 预演/补录
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INDEX_PATH = join(ROOT, 'index.json')
const iconPath = join(ROOT, 'icon.svg')

const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const git = (...argv) => execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).trim()

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
if (pkg.private === true) throw new Error('package.json 仍标记 private，市场不会收录')
if (!pkg.dsh?.bundle?.patch) throw new Error('package.json 缺少 dsh.bundle.patch，不是可安装的 bundle')
if (!existsSync(iconPath)) throw new Error('缺少 icon.svg（索引里的相对图标路径）')

const repositoryUrl = pkg.repository.url.replace(/^git\+/u, '').replace(/\.git$/u, '')
const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u.exec(repositoryUrl)
if (!match) throw new Error(`repository 需为 https://github.com/<owner>/<repo>：${repositoryUrl}`)
const [, owner, repo] = match
const homepage = pkg.homepage ?? `${repositoryUrl}#readme`

const commit = option('commit') ?? git('rev-parse', 'HEAD')
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`commit 不是 40 位小写 SHA：${commit}`)
const timestamp = Number(option('timestamp') ?? git('show', '-s', '--format=%ct', commit))
if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error(`publishTimestamp 非法：${timestamp}`)

const previous = existsSync(INDEX_PATH) ? JSON.parse(await readFile(INDEX_PATH, 'utf8')) : undefined
const previousVersions = previous?.format === 1
  ? (previous.plugins ?? []).find((plugin) => plugin.name === pkg.name)?.versions ?? []
  : []
const versions = [
  ...previousVersions.filter((version) => version.version !== pkg.version),
  {
    version: pkg.version,
    publishTimestamp: timestamp,
    source: { type: 'git', url: repositoryUrl, commit },
    ...pkg.engines?.dsh === undefined ? {} : { engines: { dsh: pkg.engines.dsh } },
  },
]

const index = {
  format: 1,
  title: { en: 'HosheaLi DSH plugins', zh: 'HosheaLi 的 DSH 插件' },
  description: {
    en: 'Independent DeepSeek Harness bundles by HosheaLi.',
    zh: 'HosheaLi 维护的 DeepSeek Harness 插件。',
  },
  metadata: {
    categories: {
      context: { title: { en: 'Skills and context', zh: '技能与上下文' } },
    },
    labels: {
      skills: { title: { en: 'Skills', zh: '技能' } },
      mcp: { title: { en: 'MCP', zh: 'MCP' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Workspace capabilities', zh: '工作区能力' },
      description: {
        en: 'Per-workspace control over which skills the model auto-loads and which MCP servers stay hidden. Manual /skill calls still work.',
        zh: '按工作区决定哪些技能自动进入模型目录、哪些 MCP 服务器被隐藏；手打 /技能名 仍可调用。',
      },
      icon: 'icon.svg',
      author: pkg.author ?? owner,
      homepage,
      repository: { url: repositoryUrl },
      metadata: { category: 'context', labels: ['skills', 'mcp'] },
      versions,
    },
  ],
}

await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`已写入 ${INDEX_PATH}`)
console.log(`插件 ${pkg.name}@${pkg.version} -> ${repositoryUrl}#${commit}`)
