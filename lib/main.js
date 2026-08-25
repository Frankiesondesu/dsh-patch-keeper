/**
 * dsh-patch-keeper —— 补丁包管理（host 插件，纯 JS，零外部依赖）
 *
 * 解决场景：你在网上下载的第三方插件/项目上加了自定义功能，但官方持续更新。
 * 本插件把你的修改提取成「补丁包」单独保存；官方更新时检测并提示，
 * 然后用 AI 把补丁合并到新官方版本上（冲突由 AI 解决），再生成新补丁包。
 *
 * 工具：
 *   patch_init            注册一个被维护的项目（记录官方基线/上游/忽略规则）
 *   patch_extract         把「用户修改 vs 官方基线」提取/重新生成为补丁包
 *   patch_check           检查官方是否有新版本（GitHub releases / npm registry）
 *   patch_merge           把旧补丁应用到新官方版本上（干净处自动，冲突交 AI）
 *   patch_finalize        AI 写完冲突解析文件后，生成新补丁包并更新清单
 *   patch_apply           把当前补丁应用到指定官方版本 → 得到「新官方+我的修改」
 *   patch_status          查看所有被维护项目的状态与待办更新
 *   patch_remove          移除一个项目
 *   patch_notifications   查看更新提醒（守护循环自动检查并写入）
 *
 * 守护循环：定时对每个有远程上游的项目执行 patch_check，发现新版本即
 * console.warn + 写 notifications.jsonl，提醒用户「让 AI 更新补丁包」。
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
  rmSync, copyFileSync, renameSync, appendFileSync,
} from 'node:fs'
import { join, dirname, relative, resolve, sep, extname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-patch-keeper'
export const inject = ['tools', 'timer', 'webServer']

/* ═════════════════════════ 基础工具 ═════════════════════════ */

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE = join(HOME, 'patch-keeper')

function storeDir(...parts) { return join(STORE, ...parts) }
function ensureDir(p) { mkdirSync(p, { recursive: true }); return p }
function safeId(s) {
  const v = String(s || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_')
  return v || 'project'
}
function projDir(id) { return storeDir('projects', safeId(id)) }
function manifestPath(id) { return join(projDir(id), 'manifest.json') }
function patchFile(id) { return join(projDir(id), 'patch', 'main.patch') }
function patchMetaFile(id) { return join(projDir(id), 'patch', 'meta.json') }
function patchBinDir(id) { return join(projDir(id), 'patch', 'bin') }
function mergeRoot(id) { return storeDir('merge', safeId(id)) }
function notifFile() { return storeDir('notifications.jsonl') }
function logFile() { return storeDir('patch-keeper.log') }

function now() { return new Date().toISOString() }

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}
function writeJson(p, obj) {
  ensureDir(dirname(p))
  const tmp = p + '.tmp-' + Date.now()
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  try { renameSync(tmp, p) } catch { rmSync(p, { force: true }); renameSync(tmp, p) }
}
function readText(abs) {
  try { return readFileSync(abs, 'utf8') } catch { return '' }
}
function writeText(abs, content) {
  ensureDir(dirname(abs))
  writeFileSync(abs, content, 'utf8')
}
function logLine(msg) {
  try { ensureDir(STORE); appendFileSync(logFile(), '[' + now() + '] ' + msg + '\n') } catch { /* 静默 */ }
}
function appendNotification(entry) {
  try { ensureDir(STORE); appendFileSync(notifFile(), JSON.stringify(entry) + '\n') } catch { /* 静默 */ }
}

/* ═════════════════════════ 清单读写 ═════════════════════════ */

function loadManifest(id) { return readJson(manifestPath(id), null) }
function saveManifest(m) {
  m.updatedAt = now()
  writeJson(manifestPath(m.id), m)
}
function listProjectIds() {
  const root = storeDir('projects')
  let names = []
  try { names = readdirSync(root) } catch { return [] }
  return names.filter((n) => existsSync(join(root, n, 'manifest.json')))
}

/* ═════════════════════════ 版本/上游探测 ═════════════════════════ */

function gitHeadRef(dir) {
  try {
    const headFile = join(dir, '.git', 'HEAD')
    if (!existsSync(headFile)) return null
    const head = readFileSync(headFile, 'utf8').trim()
    const m = head.match(/^ref:\s*(.+)$/)
    if (m) {
      const ref = m[1].trim()
      const p = join(dir, '.git', ref.split('/').join(sep))
      if (existsSync(p)) return readFileSync(p, 'utf8').trim().slice(0, 12)
      const packed = join(dir, '.git', 'packed-refs')
      if (existsSync(packed)) {
        for (const line of readFileSync(packed, 'utf8').split('\n')) {
          const mm = line.trim().match(/^([0-9a-f]{40})\s+(\S+)$/)
          if (mm && mm[2] === ref) return mm[1].slice(0, 12)
        }
      }
      return ref.split('/').pop().slice(0, 12)
    }
    return head.slice(0, 12)
  } catch { return null }
}

function detectVersion(dir) {
  try {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      const p = JSON.parse(readFileSync(pkg, 'utf8'))
      if (p && typeof p.version === 'string' && p.version) return { kind: 'semver', version: p.version, ref: '' }
    }
  } catch { /* 忽略 */ }
  try {
    const py = join(dir, 'pyproject.toml')
    if (existsSync(py)) {
      const t = readFileSync(py, 'utf8')
      const m = t.match(/version\s*=\s*["']([^"']+)["']/)
      if (m) return { kind: 'semver', version: m[1], ref: '' }
    }
  } catch { /* 忽略 */ }
  const head = gitHeadRef(dir)
  if (head) return { kind: 'commit', version: head, ref: head }
  return { kind: 'unknown', version: 'unknown', ref: '' }
}

function githubFromUrl(url) {
  const m = String(url).match(/github\.com[:\/]([^\/]+)\/([^\/\s]+?)(?:\.git)?$/)
  if (!m) return null
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
}

function detectUpstream(dir) {
  try {
    const cfg = join(dir, '.git', 'config')
    if (!existsSync(cfg)) return null
    const text = readFileSync(cfg, 'utf8')
    const remotes = []
    const re = /\[remote\s+"([^"]+)"\]\s*url\s*=\s*([^\s]+)/g
    let m
    while ((m = re.exec(text))) remotes.push({ name: m[1], url: m[2] })
    const asGithub = remotes.map((r) => {
      const g = githubFromUrl(r.url)
      return g ? { type: 'github', owner: g.owner, repo: g.repo, remote: r.name } : null
    }).filter(Boolean)
    if (!asGithub.length) return null
    // 优先 upstream 远程（官方），其次 origin，最后任意
    const pick = (name) => asGithub.find((u) => u.remote === name)
    return pick('upstream') || pick('origin') || asGithub[0]
  } catch { return null }
}

function detectAllUpstreams(dir) {
  const out = []
  try {
    const cfg = join(dir, '.git', 'config')
    if (!existsSync(cfg)) return out
    const text = readFileSync(cfg, 'utf8')
    const re = /\[remote\s+"([^"]+)"\]\s*url\s*=\s*([^\s]+)/g
    let m
    while ((m = re.exec(text))) {
      const g = githubFromUrl(m[2])
      if (g) out.push({ name: m[1], type: 'github', owner: g.owner, repo: g.repo })
    }
  } catch { /* 忽略 */ }
  return out
}

function normalizeUpstream(input) {
  if (!input) return null
  if (typeof input === 'string') {
    const s = String(input).trim()
    const g = s.match(/^github:([^\/]+)\/([^\/\s]+)$/)
    if (g) return { type: 'github', owner: g[1], repo: g[2].replace(/\.git$/, ''), remote: 'manual' }
    const n = s.match(/^npm:(.+)$/)
    if (n) return { type: 'npm', package: n[1].trim(), remote: 'manual' }
    return null
  }
  if (typeof input === 'object') {
    const t = String(input.type || '')
    if (t === 'github') return { type: 'github', owner: String(input.owner || ''), repo: String(input.repo || '').replace(/\.git$/, ''), remote: String(input.remote || 'manual') }
    if (t === 'npm') return { type: 'npm', package: String(input.package || ''), remote: String(input.remote || 'manual') }
  }
  return null
}

/* ═════════════════════════ 文件遍历与忽略 ═════════════════════════ */

const IGNORE_DIRS = [
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache', '.cache', 'coverage',
  '.next', '.nuxt', '.gradle', '.svn', '.hg', '.DS_Store', '.turbo',
]
const MAX_TEXT_SIZE = 2 * 1024 * 1024

function isIgnoredRel(rel, ignore) {
  if (!ignore || !ignore.length) return false
  for (const rule of ignore) {
    if (rule.exact !== undefined) {
      if (rel === rule.exact || rel.startsWith(rule.exact + '/')) return true
    } else if (rule.re && rule.re.test(rel)) {
      return true
    }
  }
  return false
}

function ignorePatternToRe(pat) {
  let re = '^'
  const parts = pat.split('/')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) re += '/'
    const p = parts[i]
    if (p === '**') { re += '.*'; continue }
    for (const ch of p) {
      if (ch === '*') re += '[^/]*'
      else if (ch === '?') re += '[^/]'
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  re += '$'
  try { return new RegExp(re) } catch { return null }
}

function compileIgnore(ignore) {
  const out = []
  for (const pat of (ignore || [])) {
    if (String(pat).includes('*') || String(pat).includes('?')) {
      const re = ignorePatternToRe(String(pat))
      if (re) out.push({ re })
    } else {
      out.push({ exact: String(pat) })
    }
  }
  return out
}

function walkFiles(root, ignore) {
  const compiled = compileIgnore(ignore)
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (e.isDirectory()) {
        if (IGNORE_DIRS.includes(e.name)) continue
        if (isIgnoredRel(rel, compiled)) continue
        walk(abs)
      } else {
        if (isIgnoredRel(rel, compiled)) continue
        out.push({ rel, abs })
      }
    }
  }
  walk(root)
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

function readTextNorm(abs) {
  try {
    return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch { return '' }
}

function detectEol(abs) {
  try {
    const buf = readFileSync(abs)
    const head = buf.subarray(0, 65536)
    let crlf = 0, lf = 0
    for (let i = 0; i < head.length; i++) {
      if (head[i] === 10) { if (i > 0 && head[i - 1] === 13) crlf++; else lf++ }
    }
    return crlf > lf ? '\r\n' : '\n'
  } catch { return '\n' }
}

function classifyFile(abs) {
  // 'text' | 'binary'（含超大文件）
  try {
    const st = statSync(abs)
    if (!st.isFile()) return 'binary'
    if (st.size > MAX_TEXT_SIZE) return 'binary'
    if (st.size === 0) return 'text'
    const buf = readFileSync(abs)
    const head = buf.subarray(0, 8192)
    for (let i = 0; i < head.length; i++) if (head[i] === 0) return 'binary'
    return 'text'
  } catch { return 'binary' }
}

function filesEqual(a, b) {
  try {
    const sa = statSync(a), sb = statSync(b)
    if (sa.size !== sb.size) return false
    return readFileSync(a).equals(readFileSync(b))
  } catch { return false }
}

function copyTree(src, dst, ignore) {
  ensureDir(dst)
  for (const f of walkFiles(src, ignore)) {
    const target = join(dst, f.rel.split('/').join(sep))
    ensureDir(dirname(target))
    try { copyFileSync(f.abs, target) } catch { /* 单文件复制失败跳过 */ }
  }
}

/* ═════════════════════════ 行级 diff 引擎（纯 JS） ═════════════════════════ */

function splitLines(s) {
  if (s === '') return []
  const parts = s.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

function lcsOps(a, b) {
  const n = a.length, m = b.length
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const ops = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: '=', text: a[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ type: '-', text: a[i] }); i++ }
    else { ops.push({ type: '+', text: b[j] }); j++ }
  }
  while (i < n) { ops.push({ type: '-', text: a[i] }); i++ }
  while (j < m) { ops.push({ type: '+', text: b[j] }); j++ }
  return ops
}

function diffLines(a, b) {
  // a, b: string[]。返回 ops：{type:'='|'-'|'+', text}
  const n = a.length, m = b.length
  if (n === 0) return b.map((t) => ({ type: '+', text: t }))
  if (m === 0) return a.map((t) => ({ type: '-', text: t }))
  let p = 0
  while (p < n && p < m && a[p] === b[p]) p++
  let s = 0
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++
  const midA = a.slice(p, n - s)
  const midB = b.slice(p, m - s)
  let midOps = []
  if (midA.length === 0) midOps = midB.map((t) => ({ type: '+', text: t }))
  else if (midB.length === 0) midOps = midA.map((t) => ({ type: '-', text: t }))
  // LCS 复杂度上限（格数）：文件/中间段较大时退化为「全区段替换」会造成巨型 hunk，
  // 不利于后续 patch_merge 合并。2000 行级文件中间段约 3.5M 格，取 16M 足以得到分散小 hunk，
  // 同时避免超大文件 OOM（16M 格 ≈ 64MB Uint32）。
  else if (midA.length * midB.length <= 16_000_000) midOps = lcsOps(midA, midB)
  else midOps = [...midA.map((t) => ({ type: '-', text: t })), ...midB.map((t) => ({ type: '+', text: t }))]
  const ops = []
  for (let i = 0; i < p; i++) ops.push({ type: '=', text: a[i] })
  ops.push(...midOps)
  for (let i = 0; i < s; i++) ops.push({ type: '=', text: a[n - s + i] })
  return ops
}

function makeHunks(ops, ctxLen = 3) {
  const n = ops.length
  const oldPos = new Array(n), newPos = new Array(n)
  let o = 0, nn = 0
  for (let i = 0; i < n; i++) {
    oldPos[i] = o; newPos[i] = nn
    if (ops[i].type !== '+') o++
    if (ops[i].type !== '-') nn++
  }
  const regions = []
  let i = 0
  while (i < n) {
    if (ops[i].type === '=') { i++; continue }
    let j = i
    while (j < n && ops[j].type !== '=') j++
    regions.push([i, j])
    i = j
  }
  const merged = []
  for (const [s, e] of regions) {
    if (merged.length && s - merged[merged.length - 1][1] <= 2 * ctxLen) merged[merged.length - 1][1] = e
    else merged.push([s, e])
  }
  return merged.map(([s, e]) => {
    const start = Math.max(0, s - ctxLen)
    const end = Math.min(n, e + ctxLen)
    const lines = []
    let oldCount = 0, newCount = 0
    for (let k = start; k < end; k++) {
      const t = ops[k].type === '=' ? ' ' : ops[k].type
      lines.push({ type: t, text: ops[k].text })
      if (t !== '+') oldCount++
      if (t !== '-') newCount++
    }
    return { oldStart: oldPos[start] + 1, newStart: newPos[start] + 1, oldCount, newCount, lines, endIndex: end }
  })
}

function unifiedDiff(relPath, oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText)
  const ops = diffLines(a, b)
  const hunks = makeHunks(ops, 3)
  if (!hunks.length) return null
  const out = []
  out.push(a.length === 0 ? '--- /dev/null' : '--- a/' + relPath)
  out.push(b.length === 0 ? '+++ /dev/null' : '+++ b/' + relPath)
  for (const h of hunks) {
    out.push('@@ -' + h.oldStart + ',' + h.oldCount + ' +' + h.newStart + ',' + h.newCount + ' @@')
    for (const ln of h.lines) out.push(ln.type + ln.text)
    if (h.endIndex === ops.length) {
      if (oldText !== '' && !oldText.endsWith('\n')) out.push('\\ No newline at end of file')
      if (newText !== '' && !newText.endsWith('\n')) out.push('\\ No newline at end of file')
    }
  }
  return out.join('\n') + '\n'
}

function parseUnified(text) {
  const files = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('--- ')) {
      cur = { oldPath: line.slice(4), newPath: '', hunks: [] }
      files.push(cur)
    } else if (line.startsWith('+++ ') && cur) {
      cur.newPath = line.slice(4)
    } else if (line.startsWith('@@ ')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!m || !cur) continue
      cur.hunks.push({
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] ? parseInt(m[4], 10) : 1,
        lines: [],
      })
    } else if (cur && cur.hunks.length) {
      const h = cur.hunks[cur.hunks.length - 1]
      if (line === '') { /* 补丁文本换行符产生的空行——跳过（否则被当成空上下文行，导致 hunk 无法定位） */ }
      else if (line.startsWith('\\')) { /* 无尾换行标记：忽略 */ }
      else if (line.startsWith('-')) h.lines.push({ type: '-', text: line.slice(1) })
      else if (line.startsWith('+')) h.lines.push({ type: '+', text: line.slice(1) })
      else h.lines.push({ type: ' ', text: line.slice(1) })
    }
  }
  return files
}

function renderHunk(h) {
  return '@@ -' + h.oldStart + ',' + h.oldCount + ' +' + h.newStart + ',' + h.newCount + ' @@\n' +
    h.lines.map((l) => l.type + l.text).join('\n')
}

function normRel(pathStr) {
  const s = String(pathStr || '')
  if (s.startsWith('a/')) return s.slice(2)
  if (s.startsWith('b/')) return s.slice(2)
  return s
}

function applyHunk(oldLines, hunk) {
  const window = 400
  const target = hunk.oldStart - 1
  const candidates = []
  for (let pos = Math.max(0, target - window); pos <= Math.min(oldLines.length, target + window); pos++) candidates.push(pos)
  candidates.sort((x, y) => Math.abs(x - target) - Math.abs(y - target))
  for (const pos of candidates) {
    let ctxIdx = 0
    let ok = true
    for (const ln of hunk.lines) {
      if (ln.type === ' ' || ln.type === '-') {
        if (oldLines[pos + ctxIdx] !== ln.text) { ok = false; break }
        ctxIdx++
      }
    }
    if (!ok) continue
    const head = oldLines.slice(0, pos)
    const tail = oldLines.slice(pos + ctxIdx)
    const mid = []
    for (const ln of hunk.lines) if (ln.type === '+' || ln.type === ' ') mid.push(ln.text)
    return { ok: true, lines: [...head, ...mid, ...tail] }
  }
  return { ok: false, error: '上下文不匹配，无法定位 hunk（@ -' + hunk.oldStart + ',' + hunk.oldCount + '）' }
}

function applyPatchToFile(oldText, filePatch, eol) {
  let lines = splitLines(oldText)
  for (let idx = 0; idx < filePatch.hunks.length; idx++) {
    const hunk = filePatch.hunks[idx]
    const r = applyHunk(lines, hunk)
    if (r.ok) lines = r.lines
    else {
      return {
        ok: false,
        conflicts: [{
          hunkIndex: idx,
          oldStart: hunk.oldStart,
          oldCount: hunk.oldCount,
          hunkText: renderHunk(hunk),
          reason: r.error,
        }],
      }
    }
  }
  const sep2 = eol || '\n'
  const content = lines.join(sep2) + (lines.length ? sep2 : '')
  return { ok: true, content }
}

function contextSnippet(text, aroundLine, radius = 12) {
  const lines = splitLines(text)
  const start = Math.max(0, (aroundLine || 1) - 1 - radius)
  const end = Math.min(lines.length, (aroundLine || 1) - 1 + radius)
  const out = []
  for (let i = start; i < end; i++) out.push(String(i + 1).padStart(5) + ' | ' + lines[i])
  return out.join('\n')
}

/* ═════════════════════════ 补丁包读写 ═════════════════════════ */

function writePatchPackage(project, result) {
  ensureDir(patchBinDir(project.id))
  if (existsSync(patchBinDir(project.id))) rmSync(patchBinDir(project.id), { recursive: true, force: true })
  ensureDir(patchBinDir(project.id))
  writeText(patchFile(project.id), result.patchText)
  const meta = {
    name: project.id,
    baseVersion: project.baseVersion,
    generatedAt: now(),
    files: result.files,
    deletions: result.deletions,
  }
  writeJson(patchMetaFile(project.id), meta)
  for (const b of result.binEntries) {
    const dst = join(patchBinDir(project.id), b.rel.split('/').join(sep))
    ensureDir(dirname(dst))
    try { copyFileSync(b.abs, dst) } catch { /* 二进制复制失败跳过 */ }
  }
  return meta
}

function readPatchPackage(project) {
  return {
    meta: readJson(patchMetaFile(project.id), { files: [], deletions: [] }),
    text: existsSync(patchFile(project.id)) ? readFileSync(patchFile(project.id), 'utf8') : '',
  }
}

function extractPatch(project, officialDir, modifiedDir) {
  const ignore = project.ignore || []
  const officialFiles = new Map(walkFiles(officialDir, ignore).map((f) => [f.rel, f.abs]))
  const modifiedFiles = new Map(walkFiles(modifiedDir, ignore).map((f) => [f.rel, f.abs]))
  const rels = new Set([...officialFiles.keys(), ...modifiedFiles.keys()])
  const files = []
  const binEntries = []
  const deletions = []
  const patchParts = []
  let addTotal = 0, delTotal = 0
  for (const rel of [...rels].sort()) {
    const off = officialFiles.get(rel)
    const mod = modifiedFiles.get(rel)
    if (off && !mod) {
      deletions.push(rel)
      files.push({ path: rel, kind: 'delete' })
      const d = unifiedDiff(rel, readTextNorm(off), '')
      if (d) patchParts.push(d)
      continue
    }
    if (!off && mod) {
      if (classifyFile(mod) === 'binary') {
        binEntries.push({ rel, abs: mod })
        files.push({ path: rel, kind: 'binary' })
      } else {
        const d = unifiedDiff(rel, '', readTextNorm(mod))
        if (d) { patchParts.push(d); addTotal += countDiff(d).add }
        files.push({ path: rel, kind: 'text' })
      }
      continue
    }
    // 两边都有
    if (classifyFile(mod) === 'binary' || classifyFile(off) === 'binary') {
      if (filesEqual(off, mod)) continue
      binEntries.push({ rel, abs: mod })
      files.push({ path: rel, kind: 'binary' })
      continue
    }
    const a = readTextNorm(off), b = readTextNorm(mod)
    if (a === b) continue
    const d = unifiedDiff(rel, a, b)
    if (!d) continue
    const c = countDiff(d)
    addTotal += c.add; delTotal += c.del
    patchParts.push(d)
    files.push({ path: rel, kind: 'text', add: c.add, del: c.del })
  }
  return { files, deletions, binEntries, patchText: patchParts.join(''), addTotal, delTotal }
}

function countDiff(patchText) {
  let add = 0, del = 0
  for (const line of patchText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++
    else if (line.startsWith('-') && !line.startsWith('---')) del++
  }
  return { add, del }
}

/* ═════════════════════════ 补丁应用 ═════════════════════════ */

function applyPatchPackageToTree(project, officialDir, targetDir) {
  copyTree(officialDir, targetDir, project.ignore || [])
  const pkg = readPatchPackage(project)
  const parsed = parseUnified(pkg.text)
  const byPath = new Map()
  for (const fp of parsed) byPath.set(normRel(fp.newPath), fp)
  const applied = []
  const conflicts = []
  for (const f of pkg.meta.files || []) {
    const rel = f.path
    if (f.kind === 'delete') {
      const target = join(targetDir, rel.split('/').join(sep))
      if (existsSync(target)) { rmSync(target, { force: true }); applied.push(rel + ' [删除]') }
      continue
    }
    if (f.kind === 'binary') {
      const src = join(patchBinDir(project.id), rel.split('/').join(sep))
      if (existsSync(src)) {
        const dst = join(targetDir, rel.split('/').join(sep))
        ensureDir(dirname(dst))
        try { copyFileSync(src, dst); applied.push(rel + ' [二进制]') } catch { /* 忽略 */ }
      }
      continue
    }
    // text
    const target = join(targetDir, rel.split('/').join(sep))
    const fp = byPath.get(rel)
    if (!fp || !existsSync(target)) {
      conflicts.push({
        path: rel,
        reason: fp ? '目标文件缺失' : '补丁中无此文件条目',
        hunks: [],
        newFileContext: '',
      })
      continue
    }
    const r = applyPatchToFile(readTextNorm(target), fp, detectEol(target))
    if (r.ok) {
      writeText(target, r.content)
      applied.push(rel)
    } else {
      const c = r.conflicts[0]
      conflicts.push({
        path: rel,
        reason: c.reason,
        hunks: [{ oldStart: c.oldStart, hunkText: c.hunkText, reason: c.reason }],
        newFileContext: contextSnippet(readText(target), c.oldStart),
      })
    }
  }
  return { applied, conflicts }
}

/* ═════════════════════════ 远程上游（GitHub / npm） ═════════════════════════ */

const doFetch = typeof fetch === 'function' ? fetch : null

async function fetchJson(url, timeoutMs = 25000) {
  if (!doFetch) throw new Error('运行环境无 fetch（Node < 18）')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await doFetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'dsh-patch-keeper', 'Accept': 'application/json' },
    })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
    return await res.json()
  } finally { clearTimeout(t) }
}

async function fetchRaw(url, timeoutMs = 20000) {
  if (!doFetch) throw new Error('运行环境无 fetch（Node < 18）')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await doFetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'dsh-patch-keeper' } })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
    return Buffer.from(await res.arrayBuffer())
  } finally { clearTimeout(t) }
}

/** 多源回退抓取（raw.githubusercontent 在国内不稳，回退 jsdelivr CDN 镜像）。 */
async function fetchFileBytes(urls, timeoutMs = 20000) {
  let lastErr = ''
  for (const url of urls) {
    try {
      // 空文件（0 字节）是合法内容（如 __init__.py），200 即视为成功
      return await fetchRaw(url, timeoutMs)
    } catch (e) { lastErr = String(e).slice(0, 120) }
  }
  throw new Error(lastErr)
}

async function checkGithubLatest(up) {
  // 回退链：releases/latest →（无 releases 时）默认分支最新 commit → 最新 tag
  let tag = ''
  let url = ''
  try {
    const rel = await fetchJson('https://api.github.com/repos/' + up.owner + '/' + up.repo + '/releases/latest')
    if (rel && rel.tag_name) {
      tag = String(rel.tag_name).replace(/^v/i, '')
      url = String(rel.html_url || '')
    }
  } catch { /* 仓库可能没有 releases（HTTP 404） */ }
  let sha = ''
  try {
    const c = await fetchJson('https://api.github.com/repos/' + up.owner + '/' + up.repo + '/commits/HEAD')
    sha = String(c.sha || '').slice(0, 12)
    if (!url && c.html_url) url = String(c.html_url)
  } catch { /* 可选 */ }
  if (!tag) {
    try {
      const tags = await fetchJson('https://api.github.com/repos/' + up.owner + '/' + up.repo + '/tags?per_page=1')
      if (Array.isArray(tags) && tags[0] && tags[0].name) {
        tag = String(tags[0].name).replace(/^v/i, '')
        if (!url) url = 'https://github.com/' + up.owner + '/' + up.repo + '/tags'
      }
    } catch { /* 忽略 */ }
  }
  if (!url) url = 'https://github.com/' + up.owner + '/' + up.repo
  return { tag, sha, url }
}

async function checkNpmLatest(pkg) {
  const j = await fetchJson('https://registry.npmjs.org/' + encodeURIComponent(pkg) + '/latest')
  return { tag: String(j.version || ''), sha: '', url: 'https://www.npmjs.com/package/' + pkg }
}

async function githubTree(up, ref) {
  const j = await fetchJson('https://api.github.com/repos/' + up.owner + '/' + up.repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1')
  const tree = Array.isArray(j.tree) ? j.tree : []
  return tree.filter((t) => t.type === 'blob').map((t) => ({ path: String(t.path || ''), size: Number(t.size || 0) }))
}

async function downloadGithubOfficial(up, ref, targetDir, onProgress) {
  const files = await githubTree(up, ref)
  if (!files.length) throw new Error('GitHub 树为空（ref 不存在？' + ref + '）')
  ensureDir(targetDir)
  const total = files.length
  const CONCURRENCY = 8
  // 分轮下载：每轮只抓失败/未完成的文件，双源回退（raw → jsdelivr），最多 5 轮收敛
  let pending = files.slice()
  let errors = []
  for (let round = 1; round <= 5 && pending.length; round++) {
    if (round > 1) await new Promise((r) => setTimeout(r, 800))
    const failed = []
    let idx = 0
    let done = 0
    const worker = async () => {
      while (idx < pending.length) {
        const f = pending[idx++]
        // 断点续传：已存在且大小匹配的文件直接跳过
        try {
          const dst0 = join(targetDir, f.path.split('/').join(sep))
          if (existsSync(dst0) && statSync(dst0).size === (f.size || -1)) continue
        } catch { /* 继续正常下载 */ }
        let ok = false
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          try {
            const pathEnc = f.path.split('/').map(encodeURIComponent).join('/')
            const urls = [
              'https://raw.githubusercontent.com/' + up.owner + '/' + up.repo + '/' + encodeURIComponent(ref) + '/' + pathEnc,
              'https://cdn.jsdelivr.net/gh/' + up.owner + '/' + up.repo + '@' + encodeURIComponent(ref) + '/' + pathEnc,
            ]
            // 大文件按体积放宽超时（约 80KB/s 起步 + 10s 余量），上限 3 分钟
            const tmo = Math.min(180000, Math.max(15000, Math.ceil((f.size || 0) / 80000) * 1000 + 10000))
            // 空文件（0 字节）是合法内容（如 __init__.py），200 即视为成功
            const buf = await fetchFileBytes(urls, tmo)
            const dst = join(targetDir, f.path.split('/').join(sep))
            ensureDir(dirname(dst))
            writeFileSync(dst, buf)
            ok = true
          } catch (e) {
            if (attempt === 2) failed.push({ path: f.path, error: String(e).slice(0, 120) })
            else await new Promise((r2) => setTimeout(r2, 500 * attempt))
          }
        }
        done++
        if (onProgress && done % 25 === 0) onProgress(done, pending.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
    errors = failed
    pending = failed
  }
  // 下载元数据（供「完整基线缓存复用」判断；放目录外避免污染 diff）
  try {
    writeJson(targetDir + '.meta.json', { ref, total, errors: errors.length, at: now() })
  } catch { /* 忽略 */ }
  return { total, errors }
}

function baselineComplete(officialDir) {
  try {
    const meta = readJson(officialDir + '.meta.json', null)
    return !!(meta && meta.total > 0 && meta.errors === 0)
  } catch { return false }
}

async function fetchOfficialSource(project, ref, tagHint) {
  const up = project.upstream
  if (!up) throw new Error('项目未配置远程上游')
  if (up.type === 'github') {
    const dir = storeDir('tmp', project.id + '-official-' + (tagHint || ref || 'latest'))
    rmSync(dir, { recursive: true, force: true })
    const r = await downloadGithubOfficial(up, ref, dir)
    if (r.errors.length) {
      throw new Error('官方源码下载不完整（' + r.errors.length + '/' + r.total + ' 个文件失败，如 ' + r.errors[0].path + '）——稍后重试或改传 newOfficialDir/officialDir 本地目录')
    }
    return dir
  }
  if (up.type === 'npm') {
    const dir = storeDir('tmp', project.id + '-official-' + (tagHint || ref || 'latest'))
    rmSync(dir, { recursive: true, force: true })
    const r = await downloadNpmOfficial(up.package, ref || 'latest', dir)
    if (r.errors.length) {
      throw new Error('npm 源码下载不完整（' + r.errors.length + '/' + r.total + ' 个文件失败）——稍后重试或改传本地目录')
    }
    return dir
  }
  throw new Error('不支持的上游类型: ' + up.type)
}

async function downloadNpmOfficial(pkg, version, targetDir) {
  const meta = await fetchJson('https://unpkg.com/' + pkg + '@' + version + '/?meta')
  // unpkg 的 meta.files 是扁平列表，type 为 MIME 类型（如 text/javascript）而非 'file'
  const files = (meta.files || []).filter((f) => f && f.path)
  if (!files.length) throw new Error('unpkg 文件清单为空（' + pkg + '@' + version + '）')
  ensureDir(targetDir)
  const errors = []
  let idx = 0
  const worker = async () => {
    while (idx < files.length) {
      const f = files[idx++]
      try {
        const dst = join(targetDir, f.path.split('/').join(sep))
        // 断点续传：已存在且大小匹配的文件直接跳过
        try {
          if (existsSync(dst) && statSync(dst).size === (f.size || -1)) continue
        } catch { /* 继续正常下载 */ }
        const url = 'https://unpkg.com/' + pkg + '@' + version + '/' + f.path.split('/').map(encodeURIComponent).join('/')
        const buf = await fetchRaw(url)
        ensureDir(dirname(dst))
        writeFileSync(dst, buf)
      } catch (e) { errors.push({ path: f.path, error: String(e).slice(0, 160) }) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker))
  try {
    writeJson(targetDir + '.meta.json', { ref: version, total: files.length, errors: errors.length, at: now() })
  } catch { /* 忽略 */ }
  return { total: files.length, errors }
}

async function resolveGithubRef(project, ref) {
  if (ref && ref !== 'latest') return ref
  if (project.latestTag) return project.latestTag
  try {
    const latest = await checkGithubLatest(project.upstream)
    return latest.tag || 'master'
  } catch {
    return 'master'
  }
}

/* ═════════════════════════ 核心操作 ═════════════════════════ */

async function doInit(opts) {
  const id = safeId(opts.name)
  if (loadManifest(id)) return { ok: false, error: '项目已存在: ' + id + '（先 patch_remove 或换一个 name）' }
  const modifiedDir = resolve(String(opts.modifiedDir || ''))
  if (!existsSync(modifiedDir) || !statSync(modifiedDir).isDirectory()) {
    return { ok: false, error: 'modifiedDir 不存在或不是目录: ' + modifiedDir }
  }
  const ver = detectVersion(modifiedDir)
  const project = {
    id,
    name: String(opts.name).trim(),
    dir: modifiedDir,
    baseVersion: ver.version,
    baseVersionKind: ver.kind,
    baseRef: ver.ref || '',
    upstream: normalizeUpstream(opts.upstream) || detectUpstream(modifiedDir),
    gitRemotes: detectAllUpstreams(modifiedDir),
    patchVersion: 0,
    ignore: Array.isArray(opts.ignore) ? opts.ignore.map(String) : [],
    updateAvailable: false,
    lastCheckAt: null,
    lastCheckMsg: '',
    latestTag: '',
    lastNotifiedVersion: '',
    createdAt: now(),
    updatedAt: now(),
  }
  saveManifest(project)
  let patch = null
  if (opts.officialDir && existsSync(resolve(String(opts.officialDir)))) {
    const r = await doExtract(project, { officialDir: opts.officialDir })
    if (!r.ok) return { ok: false, error: '项目已注册但补丁提取失败: ' + r.error, project }
    patch = r
  }
  return {
    ok: true,
    project: {
      id: project.id, name: project.name, dir: project.dir,
      baseVersion: project.baseVersion, baseVersionKind: project.baseVersionKind,
      upstream: project.upstream, ignore: project.ignore,
    },
    patch,
    note: patch ? '补丁包已生成' : '已注册。补丁提取需要官方基线：传入 officialDir 再跑 patch_extract，或用 GitHub 上游自动拉取。',
  }
}

async function doExtract(project, opts) {
  const ignore = project.ignore || []
  let officialDir = opts.officialDir ? resolve(String(opts.officialDir)) : ''
  if (!officialDir && project.upstream && project.upstream.type === 'github') {
    // 用基线 ref（commit/tag）从 GitHub 拉官方源码；
    // 基线 commit 可能来自 fork（如 origin 远程），逐个远程回退尝试；
    // 已有完整基线缓存则直接复用（免重复下载、防网络抖动）
    const ref = opts.ref || project.baseRef || project.baseVersion
    officialDir = storeDir('tmp', project.id + '-base')
    if (!opts.ref && baselineComplete(officialDir)) {
      // 缓存完整 → 复用
    } else {
      rmSync(officialDir, { recursive: true, force: true })
      ensureDir(officialDir)
      const primary = project.upstream
      const fallbacks = (project.gitRemotes || [])
        .filter((r) => r.type === 'github' && !(r.owner === primary.owner && r.repo === primary.repo))
      const remotes = [primary, ...fallbacks]
      let lastErr = ''
      let ok = false
      for (const up of remotes) {
        try {
          const r = await downloadGithubOfficial(up, ref, officialDir)
          if (r.errors.length) {
            lastErr = r.errors.length + '/' + r.total + ' 个文件下载失败（如 ' + r.errors[0].path + '）'
            // 保留已下载文件（断点续传），仅换下一个远程时清空
            if (remotes.indexOf(up) < remotes.length - 1) {
              rmSync(officialDir, { recursive: true, force: true })
              ensureDir(officialDir)
            }
            continue
          }
          ok = true
          break
        } catch (e) {
          lastErr = String(e).slice(0, 160)
          rmSync(officialDir, { recursive: true, force: true })
          ensureDir(officialDir)
        }
      }
      if (!ok) {
        return { ok: false, error: 'GitHub 基线拉取失败（尝试 ' + remotes.map((r) => r.owner + '/' + r.repo + '@' + ref).join(', ') + '）: ' + lastErr + '——可改传 officialDir 手动提供官方目录' }
      }
    }
  }
  if (!officialDir && project.upstream && project.upstream.type === 'npm') {
    // npm 上游：按基线版本从 unpkg 拉官方发布内容
    const ver = opts.ref || project.baseRef || project.baseVersion || 'latest'
    officialDir = storeDir('tmp', project.id + '-base')
    if (!opts.ref && baselineComplete(officialDir)) {
      // 缓存完整 → 复用
    } else {
      rmSync(officialDir, { recursive: true, force: true })
      try {
        const r = await downloadNpmOfficial(project.upstream.package, ver, officialDir)
        if (r.errors.length) {
          return { ok: false, error: 'npm 基线拉取不完整（' + r.errors.length + '/' + r.total + ' 个文件失败）——可改传 officialDir 手动提供官方目录' }
        }
      } catch (e) {
        return { ok: false, error: 'npm 基线拉取失败（' + String(e).slice(0, 160) + '）——可改传 officialDir 手动提供官方目录' }
      }
    }
  }
  if (!officialDir || !existsSync(officialDir)) {
    return { ok: false, error: '缺少官方基线：传 officialDir，或配置 GitHub 上游后自动拉取' }
  }
  const res = extractPatch(project, officialDir, project.dir)
  writePatchPackage(project, res)
  project.patchVersion = (project.patchVersion || 0) + 1
  project.lastExtractAt = now()
  saveManifest(project)
  return {
    ok: true,
    patchVersion: project.patchVersion,
    fileCount: res.files.length,
    deletions: res.deletions,
    addTotal: res.addTotal,
    delTotal: res.delTotal,
    files: res.files,
  }
}

async function checkOne(project) {
  let latest
  if (project.upstream && project.upstream.type === 'github') latest = await checkGithubLatest(project.upstream)
  else if (project.upstream && project.upstream.type === 'npm') latest = await checkNpmLatest(project.upstream.package)
  else return { status: 'no-remote', msg: '无远程上游（仅本地目录，无法自动检测）' }
  const baseIsCommit = project.baseVersionKind === 'commit'
  const updateAvailable = baseIsCommit
    ? Boolean(latest.sha && latest.sha !== (project.baseRef || project.baseVersion)) || (!latest.sha && latest.tag !== project.baseVersion)
    : Boolean(latest.tag && latest.tag !== project.baseVersion)
  project.latestTag = latest.tag
  project.latestSha = latest.sha
  project.latestUrl = latest.url
  project.lastCheckAt = now()
  project.lastCheckMsg = updateAvailable
    ? '官方有新版本: ' + project.baseVersion + ' → ' + latest.tag
    : '已是最新（' + latest.tag + '）'
  project.updateAvailable = Boolean(updateAvailable)
  if (updateAvailable && project.lastNotifiedVersion !== latest.tag) {
    project.lastNotifiedVersion = latest.tag
    appendNotification({
      at: now(), project: project.id, kind: 'update-available',
      from: project.baseVersion, to: latest.tag, url: latest.url,
    })
    try {
      console.warn('[patch-keeper] ⚠ 检测到官方更新：' + project.id + ' ' + project.baseVersion + ' → ' + latest.tag + '。请让 AI 运行 patch_merge 更新补丁包（冲突自动交 AI 解决）。')
    } catch { /* 忽略 */ }
  }
  saveManifest(project)
  return { status: 'ok', base: project.baseVersion, latest: latest.tag, updateAvailable, msg: project.lastCheckMsg, url: latest.url }
}

async function doCheck(project) {
  try {
    return await checkOne(project)
  } catch (e) {
    project.lastCheckAt = now()
    project.lastCheckMsg = '检查失败: ' + String(e).slice(0, 160)
    saveManifest(project)
    return { status: 'error', msg: project.lastCheckMsg, error: String(e).slice(0, 200) }
  }
}

async function doMerge(project, opts) {
  const id = project.id
  const newVersion = String(opts.newVersion || '').trim()
  let officialDir = opts.newOfficialDir ? resolve(String(opts.newOfficialDir)) : ''
  if (!officialDir && project.upstream) {
    try {
      const ref = project.upstream.type === 'github'
        ? await resolveGithubRef(project, newVersion || 'latest')
        : (newVersion || 'latest')
      officialDir = await fetchOfficialSource(project, ref, newVersion || '')
    } catch (e) {
      return { ok: false, error: '官方源码获取失败: ' + String(e).slice(0, 200) }
    }
  }
  if (!officialDir || !existsSync(officialDir)) {
    return { ok: false, error: '需要 newOfficialDir（新官方源码目录），或配置 GitHub/npm 上游自动拉取' }
  }
  const mergeDir = join(mergeRoot(id), 'm-' + Date.now())
  const target = join(mergeDir, 'merged')
  ensureDir(target)
  const r = applyPatchPackageToTree(project, officialDir, target)
  const officialCopy = join(mergeDir, 'official')
  copyTree(officialDir, officialCopy, [])
  const record = {
    at: now(),
    mergeDir,
    newVersion: newVersion || 'latest',
    applied: r.applied,
    conflicts: r.conflicts,
    officialSnapshot: officialCopy,
    baseVersion: project.baseVersion,
    patchVersion: project.patchVersion,
  }
  writeJson(join(mergeDir, 'merge.json'), record)
  return {
    ok: true,
    mergeDir,
    newVersion: newVersion || 'latest',
    applied: r.applied,
    conflicts: r.conflicts,
    conflictCount: r.conflicts.length,
  }
}

async function doFinalize(project, opts) {
  const mroot = mergeRoot(project.id)
  let dirs = []
  try { dirs = readdirSync(mroot).filter((d) => d.startsWith('m-')).sort() } catch { /* 无 */ }
  if (!dirs.length) return { ok: false, error: '没有进行中的合并（先 patch_merge）' }
  const last = dirs[dirs.length - 1]
  const rec = readJson(join(mroot, last, 'merge.json'), null)
  if (!rec) return { ok: false, error: '合并记录损坏: ' + last }
  const merged = join(mroot, last, 'merged')
  const official = join(mroot, last, 'official')
  const conflictedPaths = (rec.conflicts || []).map((c) => c.path)
  const resolvedDir = opts.resolvedDir ? resolve(String(opts.resolvedDir)) : ''
  const resolved = opts.resolved && typeof opts.resolved === 'object' ? opts.resolved : {}
  const unresolved = []
  for (const p of conflictedPaths) {
    const dst = join(merged, p.split('/').join(sep))
    let wrote = false
    if (resolvedDir) {
      const cand = join(resolvedDir, p.split('/').join(sep))
      if (existsSync(cand)) { ensureDir(dirname(dst)); copyFileSync(cand, dst); wrote = true }
    }
    if (!wrote && typeof resolved[p] === 'string') {
      ensureDir(dirname(dst))
      writeText(dst, resolved[p])
      wrote = true
    }
    if (!wrote) unresolved.push(p)
  }
  if (unresolved.length) {
    return { ok: false, error: '仍有未解决冲突: ' + unresolved.join(', ') + ' —— 用 patch_finalize 的 resolvedDir/resolved 提供解析内容' }
  }
  // 重新生成补丁包（新官方 vs 合并树）
  const res = extractPatch(project, official, merged)
  const oldText = existsSync(patchFile(project.id)) ? readFileSync(patchFile(project.id), 'utf8') : ''
  if (oldText) {
    const arch = storeDir('archive', project.id)
    ensureDir(arch)
    writeText(join(arch, 'patch-v' + (project.baseVersion || 'old') + '.patch'), oldText)
  }
  writePatchPackage(project, res)
  let newVersion = String(rec.newVersion || '')
  if (newVersion === 'latest' && project.latestTag) newVersion = project.latestTag
  const isCommit = /^[0-9a-f]{7,40}$/i.test(newVersion)
  project.baseVersion = newVersion || project.baseVersion
  project.baseVersionKind = isCommit ? 'commit' : 'semver'
  if (isCommit) project.baseRef = newVersion
  project.patchVersion = (project.patchVersion || 0) + 1
  project.updateAvailable = false
  project.lastCheckMsg = '补丁已合并到 ' + newVersion
  project.lastMergeAt = now()
  saveManifest(project)
  return {
    ok: true,
    newVersion: newVersion || 'latest',
    patchVersion: project.patchVersion,
    fileCount: res.files.length,
    addTotal: res.addTotal,
    delTotal: res.delTotal,
    mergedDir: merged,
  }
}

async function doApply(project, opts) {
  const version = String(opts.version || '').trim() || 'latest'
  let officialDir = opts.officialDir ? resolve(String(opts.officialDir)) : ''
  if (!officialDir && project.upstream) {
    try {
      const ref = project.upstream.type === 'github'
        ? await resolveGithubRef(project, version)
        : version
      officialDir = await fetchOfficialSource(project, ref, version === 'latest' ? (project.latestTag || '') : version)
    } catch (e) {
      return { ok: false, error: '官方源码获取失败: ' + String(e).slice(0, 200) }
    }
  }
  if (!officialDir || !existsSync(officialDir)) {
    return { ok: false, error: '需要 officialDir 或远程上游' }
  }
  const targetDir = resolve(String(opts.targetDir || ''))
  if (!targetDir) return { ok: false, error: 'targetDir 必填' }
  ensureDir(targetDir)
  const r = applyPatchPackageToTree(project, officialDir, targetDir)
  return { ok: true, targetDir, version, applied: r.applied, conflicts: r.conflicts, conflictCount: r.conflicts.length }
}

/* ═════════════════════════ 报告格式化 ═════════════════════════ */

function fmtProject(project) {
  const up = project.upstream
  const upStr = up ? (up.type === 'github' ? 'github ' + up.owner + '/' + up.repo : 'npm ' + up.package) : '（无远程上游）'
  const lines = [
    '### ' + project.name + '  `' + project.id + '`',
    '- 项目目录: ' + project.dir,
    '- 基线版本: ' + project.baseVersion + '（' + project.baseVersionKind + '）',
    '- 补丁版本: v' + (project.patchVersion || 0),
    '- 上游: ' + upStr,
    '- 忽略: ' + ((project.ignore || []).length ? project.ignore.join(', ') : '（默认规则）'),
    '- 最近检查: ' + (project.lastCheckAt || '从未') + ' — ' + (project.lastCheckMsg || ''),
  ]
  if (project.updateAvailable) {
    lines.push('- ⚠️ **官方更新可用**: ' + project.baseVersion + ' → ' + (project.latestTag || '?') + ' —— 运行 patch_merge 让 AI 更新补丁包，或 patch_apply 直接应用')
  }
  return lines.join('\n')
}

/* ═════════════════════════ 工具注册（复刻 defineTool 契约） ═════════════════════════ */

function propSchema(v) {
  switch (v && v.type) {
    case 'boolean': return { type: 'boolean', description: v.description || '' }
    case 'number': return { type: 'number', description: v.description || '' }
    case 'json': return { description: v.description || '' }
    default: return { type: 'string', description: v.description || '' }
  }
}

function buildTool(def) {
  const parameters = { type: 'object', properties: {} }
  const required = []
  for (const [k, v] of Object.entries(def.parameters || {})) {
    parameters.properties[k] = propSchema(v)
    if (v && v.required) required.push(k)
  }
  if (required.length) parameters.required = required
  return {
    name: def.name,
    description: def.description,
    parameters,
    output: {
      schema: (def.output && def.output.schema) || { type: 'string' },
      render: (_a, value) => [{ type: 'text', text: String(value) }],
    },
    ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
    async execute(args) {
      try {
        const r = await def.execute(args || {})
        return typeof r === 'string' ? r : JSON.stringify(r, null, 2)
      } catch (e) {
        return 'ERROR: ' + String(e && e.message || e)
      }
    },
  }
}

function register(ctx, def) {
  ctx.effect(() => ctx.tools.register(buildTool(def)))
}

/* ═════════════════════════ 守护循环 ═════════════════════════ */

function startDaemon(ctx, config) {
  const delay = Math.max(10000, Number(config.initialCheckDelayMs) || 60000)
  const interval = Math.max(60000, Number(config.checkIntervalMs) || 6 * 3600 * 1000)
  const timers = []
  const run = () => {
    checkAll().then((out) => {
      const hits = out.filter((r) => r.updateAvailable)
      logLine('daemon check done: ' + out.length + ' projects, ' + hits.length + ' updates pending')
    }).catch((e) => logLine('daemon check error: ' + String(e)))
  }
  // 初始检查用一次性 timeout；周期检查才用 interval（此前误用双 interval 导致每分钟空转烧 API 配额）
  const makeTimeout = (fn, ms) => {
    try {
      if (typeof ctx.setTimeout === 'function') return ctx.setTimeout(fn, ms)
      if (typeof ctx.timeout === 'function') return ctx.timeout(fn, ms)
    } catch { /* 回退 */ }
    return setTimeout(fn, ms)
  }
  const makeInterval = (fn, ms) => {
    try {
      if (typeof ctx.setInterval === 'function') return ctx.setInterval(fn, ms)
      if (typeof ctx.interval === 'function') return ctx.interval(fn, ms)
    } catch { /* 回退 */ }
    return setInterval(fn, ms)
  }
  timers.push({ t: makeTimeout(run, delay), kind: 'timeout' })
  timers.push({ t: makeInterval(run, interval), kind: 'interval' })
  ctx.on('dispose', () => {
    for (const x of timers) { try { if (x.kind === 'timeout') clearTimeout(x.t); else clearInterval(x.t) } catch { /* 忽略 */ } }
  })
  logLine('daemon started (initial=' + delay + 'ms, interval=' + interval + 'ms)')
}

async function checkAll() {
  const ids = listProjectIds()
  const out = []
  for (const id of ids) {
    const p = loadManifest(id)
    if (!p) continue
    try { out.push(Object.assign({ id }, await checkOne(p))) }
    catch (e) { out.push({ id, status: 'error', msg: String(e).slice(0, 160) }) }
  }
  return out
}

/* ═════════════════════════ 插件入口 ═════════════════════════ */

export function apply(ctx, config) {
  const cfg = config || {}
  ensureDir(STORE)

  // ── patch_init ──
  register(ctx, {
    name: 'patch_init',
    description: '补丁包管理：注册一个被维护的第三方项目（你在网上下载并自行修改过的插件/项目）。记录官方基线、自动探测 GitHub/npm 上游、可选 initial 提取补丁。随后用 patch_extract 提取修改为补丁包，官方更新时 patch_check 检测、patch_merge 让 AI 合并。',
    timeoutMs: 300000,
    parameters: {
      name: { type: 'string', required: true, description: '项目标识（如 wechatmsg）' },
      modifiedDir: { type: 'string', required: true, description: '你修改过的项目目录绝对路径' },
      officialDir: { type: 'string', description: '可选：官方原版目录绝对路径（用于立即提取补丁；不传则稍后 patch_extract）' },
      upstream: { type: 'json', description: '可选：上游源，如 {type:"github",owner:"LC044",repo:"WeChatMsg"} 或字符串 "github:owner/repo" / "npm:包名"；不传则从 .git/config 自动探测' },
      ignore: { type: 'json', description: '可选：忽略的相对路径列表（如 ["exported","doc/images"]，diff 时排除）' },
    },
    async execute(args) {
      const r = await doInit(args)
      if (!r.ok) return 'ERROR: ' + r.error
      const lines = [
        'OK: 项目已注册 `' + r.project.id + '`',
        '- 修改目录: ' + r.project.dir,
        '- 基线版本: ' + r.project.baseVersion + '（' + r.project.baseVersionKind + '）',
        '- 上游: ' + (r.project.upstream ? JSON.stringify(r.project.upstream) : '未配置'),
        '- 忽略: ' + (r.project.ignore.length ? r.project.ignore.join(', ') : '（默认规则）'),
      ]
      if (r.patch) {
        lines.push('')
        lines.push('补丁包已生成:')
        lines.push('- 补丁版本: v' + r.patch.patchVersion)
        lines.push('- 变更文件: ' + r.patch.fileCount + '（+' + r.patch.addTotal + ' / -' + r.patch.delTotal + '）')
        for (const f of r.patch.files) lines.push('  - ' + f.path + ' [' + f.kind + ']')
      } else {
        lines.push('')
        lines.push('注: ' + r.note)
      }
      return lines.join('\n')
    },
  })

  // ── patch_extract ──
  register(ctx, {
    name: 'patch_extract',
    description: '补丁包管理：把「用户修改 vs 官方基线」提取/重新生成为补丁包。基线来源：officialDir 参数，或 GitHub 上游按基线 ref 自动拉取（首次需下载官方源码，可能耗时数分钟）。修改了本地文件后重新运行以更新补丁包。',
    timeoutMs: 900000,
    parameters: {
      name: { type: 'string', required: true, description: '项目标识' },
      officialDir: { type: 'string', description: '可选：官方原版目录（不传则尝试从 GitHub 上游按基线 ref 拉取）' },
      ref: { type: 'string', description: '可选：基线 git ref（commit/tag），默认用注册时记录的基线' },
    },
    async execute(args) {
      const project = loadManifest(safeId(args.name))
      if (!project) return 'ERROR: 项目不存在: ' + args.name + '（先 patch_init）'
      const r = await doExtract(project, args)
      if (!r.ok) return 'ERROR: ' + r.error
      const lines = [
        'OK: 补丁包已生成 v' + r.patchVersion,
        '- 变更文件: ' + r.fileCount + '（+' + r.addTotal + ' / -' + r.delTotal + '）',
      ]
      if (r.deletions && r.deletions.length) lines.push('- 删除: ' + r.deletions.join(', '))
      for (const f of r.files) lines.push('  - ' + f.path + ' [' + f.kind + ']' + (f.add ? ' (+' + f.add + '/-' + f.del + ')' : ''))
      return lines.join('\n')
    },
  })

  // ── patch_check ──
  register(ctx, {
    name: 'patch_check',
    description: '补丁包管理：检查被维护项目的官方是否有新版本（GitHub releases / npm registry）。发现新版本会记录 updateAvailable 并写入提醒。',
    timeoutMs: 120000,
    parameters: {
      name: { type: 'string', description: '可选：项目标识；省略则检查全部项目' },
    },
    async execute(args) {
      const target = args.name ? safeId(args.name) : null
      if (target) {
        const project = loadManifest(target)
        if (!project) return 'ERROR: 项目不存在: ' + args.name
        const r = await doCheck(project)
        const mark = r.updateAvailable ? '⚠️ 有更新' : '✓ 最新'
        return '[' + mark + '] ' + project.id + ': ' + (r.msg || '') + (r.url ? '\n' + r.url : '')
      }
      const out = await checkAll()
      const lines = []
      for (const r of out) {
        lines.push((r.updateAvailable ? '⚠️' : '✓') + ' ' + r.id + ': ' + (r.msg || r.error || r.status))
      }
      return lines.length ? lines.join('\n') : '（没有已注册项目）'
    },
  })

  // ── patch_merge ──
  register(ctx, {
    name: 'patch_merge',
    description: '补丁包管理（AI 合并流程第 1 步）：把旧补丁应用到「新官方版本」上。干净处自动应用；冲突处产生逐文件报告（旧 hunk + 新文件上下文），由 AI 阅读并写出解析文件，然后 patch_finalize 生成新补丁包。新官方源码可传 newOfficialDir，或按 newVersion 从 GitHub/npm 上游自动拉取（拉取可能耗时数分钟）。',
    timeoutMs: 900000,
    parameters: {
      name: { type: 'string', required: true, description: '项目标识' },
      newVersion: { type: 'string', description: '可选：目标官方版本（git tag / npm version；默认 latest 最新版）' },
      newOfficialDir: { type: 'string', description: '可选：新官方源码目录绝对路径（不传则从上游自动拉取）' },
    },
    async execute(args) {
      const project = loadManifest(safeId(args.name))
      if (!project) return 'ERROR: 项目不存在: ' + args.name + '（先 patch_init）'
      const r = await doMerge(project, args)
      if (!r.ok) return 'ERROR: ' + r.error
      const lines = [
        'OK: 补丁已尝试应用到新官方版本 ' + r.newVersion,
        '- 干净应用: ' + r.applied.length + ' 个文件',
      ]
      for (const a of r.applied) lines.push('  ✓ ' + a)
      if (r.conflicts.length) {
        lines.push('')
        lines.push('⚠️ 冲突 ' + r.conflicts.length + ' 个文件 —— 需要 AI 解决:')
        for (const c of r.conflicts) {
          lines.push('')
          lines.push('### 冲突文件: ' + c.path)
          lines.push('原因: ' + c.reason)
          if (c.hunks && c.hunks.length) {
            lines.push('旧补丁 hunk（@ 旧行 ' + c.hunks[0].oldStart + '）:')
            lines.push('```diff')
            lines.push(c.hunks[0].hunkText)
            lines.push('```')
          }
          if (c.newFileContext) {
            lines.push('新官方文件中该区域上下文:')
            lines.push('```')
            lines.push(c.newFileContext)
            lines.push('```')
          }
        }
        lines.push('')
        lines.push('解决方式：把每个冲突文件的人工合并结果写入一个目录（保持相对路径），然后运行 patch_finalize {"name":"' + project.id + '","resolvedDir":"<目录>"}。')
      }
      lines.push('')
      lines.push('合并工作区: ' + r.mergeDir)
      return lines.join('\n')
    },
  })

  // ── patch_finalize ──
  register(ctx, {
    name: 'patch_finalize',
    description: '补丁包管理（AI 合并流程第 2 步）：在 patch_merge 之后，AI 已把冲突文件的人工合并结果写入 resolvedDir（保持项目内相对路径），本工具将其合入合并树、重新生成补丁包、归档旧补丁并更新清单。无冲突时可不传 resolvedDir 直接调用。',
    timeoutMs: 300000,
    parameters: {
      name: { type: 'string', required: true, description: '项目标识' },
      resolvedDir: { type: 'string', description: '可选：AI 写好的冲突解析文件目录（相对路径与项目内一致）' },
      resolved: { type: 'json', description: '可选：{相对路径: 文件内容} 映射，替代 resolvedDir' },
    },
    async execute(args) {
      const project = loadManifest(safeId(args.name))
      if (!project) return 'ERROR: 项目不存在: ' + args.name
      const r = await doFinalize(project, args)
      if (!r.ok) return 'ERROR: ' + r.error
      const lines = [
        'OK: 补丁包已合并更新到 ' + r.newVersion,
        '- 新补丁版本: v' + r.patchVersion,
        '- 变更文件: ' + r.fileCount + '（+' + r.addTotal + ' / -' + r.delTotal + '）',
        '- 合并树目录: ' + r.mergedDir,
      ]
      return lines.join('\n')
    },
  })

  // ── patch_apply ──
  register(ctx, {
    name: 'patch_apply',
    description: '补丁包管理：把当前补丁应用到指定官方版本，输出到 targetDir —— 得到「新官方 + 我的修改」的成品目录。官方源码传 officialDir 或从上游按 version 自动拉取（拉取可能耗时数分钟）。',
    timeoutMs: 900000,
    parameters: {
      name: { type: 'string', required: true, description: '项目标识' },
      targetDir: { type: 'string', required: true, description: '输出目录绝对路径（成品）' },
      version: { type: 'string', description: '可选：官方版本（git tag / npm version；默认 latest）' },
      officialDir: { type: 'string', description: '可选：官方源码目录（不传则从上游拉取）' },
    },
    async execute(args) {
      const project = loadManifest(safeId(args.name))
      if (!project) return 'ERROR: 项目不存在: ' + args.name
      const r = await doApply(project, args)
      if (!r.ok) return 'ERROR: ' + r.error
      const lines = [
        'OK: 已生成「官方 ' + r.version + ' + 你的修改」→ ' + r.targetDir,
        '- 应用文件: ' + r.applied.length,
      ]
      for (const a of r.applied) lines.push('  ✓ ' + a)
      if (r.conflicts.length) {
        lines.push('- ⚠️ 冲突 ' + r.conflicts.length + ' 个（未应用，见列表）:')
        for (const c of r.conflicts) lines.push('  ✗ ' + c.path + ' — ' + c.reason)
      }
      return lines.join('\n')
    },
  })

  // ── patch_status ──
  register(ctx, {
    name: 'patch_status',
    description: '补丁包管理：列出所有被维护项目及其状态（基线/补丁版本/上游/更新可用性）。发现 ⚠️ 标记即官方有更新，提示用户让 AI 运行 patch_merge 更新补丁包。',
    parameters: {
      name: { type: 'string', description: '可选：只看指定项目' },
    },
    async execute(args) {
      const ids = args.name ? [safeId(args.name)] : listProjectIds()
      if (!ids.length) return '（还没有注册任何项目 —— 用 patch_init 注册你修改过的第三方项目）'
      const lines = ['# patch-keeper 状态']
      let pending = 0
      for (const id of ids) {
        const p = loadManifest(id)
        if (!p) { lines.push('（项目 ' + id + ' 清单缺失）'); continue }
        if (p.updateAvailable) pending++
        lines.push('')
        lines.push(fmtProject(p))
      }
      lines.push('')
      lines.push(pending ? '⚠️ 有 ' + pending + ' 个项目待更新补丁包 —— 让 AI 依次执行 patch_merge 即可。' : '✓ 全部最新。')
      return lines.join('\n')
    },
  })

  // ── patch_remove ──
  register(ctx, {
    name: 'patch_remove',
    description: '补丁包管理：移除一个被维护的项目及其补丁包（不删除你的项目目录）。',
    parameters: {
      name: { type: 'string', required: true, description: '项目标识' },
      confirm: { type: 'boolean', description: '必须传 true 才会真正删除' },
    },
    async execute(args) {
      const id = safeId(args.name)
      if (!loadManifest(id)) return 'ERROR: 项目不存在: ' + args.name
      if (args.confirm !== true) return '未删除（需 confirm: true）'
      rmSync(projDir(id), { recursive: true, force: true })
      rmSync(mergeRoot(id), { recursive: true, force: true })
      const arch = storeDir('archive', id)
      rmSync(arch, { recursive: true, force: true })
      return 'OK: 已移除项目 ' + id
    },
  })

  // ── patch_notifications ──
  register(ctx, {
    name: 'patch_notifications',
    description: '补丁包管理：查看更新提醒记录（守护循环自动检查官方更新时写入）。',
    parameters: {
      clear: { type: 'boolean', description: '可选：true 则查看后清空提醒' },
    },
    async execute(args) {
      let lines = []
      try {
        const raw = readFileSync(notifFile(), 'utf8').trim()
        if (raw) lines = raw.split('\n').slice(-30).map((l) => {
          try {
            const e = JSON.parse(l)
            return (e.kind === 'update-available' ? '⚠️ ' : '· ') + e.project + ': ' + (e.from || '?') + ' → ' + (e.to || '?') + '（' + e.at + '）' + (e.url ? ' ' + e.url : '')
          } catch { return l }
        })
      } catch { /* 无提醒 */ }
      if (args.clear === true) { try { writeFileSync(notifFile(), '', 'utf8') } catch { /* 忽略 */ } }
      return lines.length ? lines.join('\n') : '（暂无更新提醒）'
    },
  })

  /* ═══════════════ Web GUI API（client 面板消费，前缀路由 /patch-keeper/api） ═══════════════ */
  // webServer 已声明为硬依赖（inject），此处仅为防御式兜底

  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    logLine('gui api disabled: webServer 服务不可用')
  } else {
    const readBody = (req) => new Promise((res, rej) => {
      let data = ''
      req.on('data', (c) => { data += c; if (data.length > 4e6) { rej(new Error('request body too large')); try { req.destroy() } catch { /* 忽略 */ } } })
      req.on('end', () => res(data))
      req.on('error', rej)
    })

    // 长操作任务队列：立即返回 jobId，前端轮询 GET /jobs（官方源码拉取可能耗时数分钟）
    const jobs = new Map()
    let jobSeq = 0
    let jobChain = Promise.resolve()
    const startJob = (kind, projectName, fn) => {
      const id = 'j' + Date.now().toString(36) + '-' + (++jobSeq)
      const job = { id, kind, name: projectName || '', status: 'queued', startedAt: now(), endedAt: null, result: null, error: null }
      jobs.set(id, job)
      while (jobs.size > 40) jobs.delete(jobs.keys().next().value)
      jobChain = jobChain.then(async () => {
        job.status = 'running'
        try { job.result = await fn(); job.status = 'done' }
        catch (e) { job.error = String((e && e.message) || e).slice(0, 500); job.status = 'error' }
        job.endedAt = now()
        logLine('job ' + id + ' [' + kind + (projectName ? '/' + projectName : '') + '] -> ' + job.status + (job.error ? ' :: ' + job.error.slice(0, 160) : ''))
      }).catch(() => {})
      return job
    }

    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s }

    const projectSummary = (p) => ({
      id: p.id,
      name: p.name || p.id,
      dir: p.dir || '',
      baseVersion: p.baseVersion || '',
      baseVersionKind: p.baseVersionKind || '',
      baseRef: p.baseRef || '',
      patchVersion: p.patchVersion || 0,
      upstream: p.upstream || null,
      ignoreCount: (p.ignore || []).length,
      updateAvailable: Boolean(p.updateAvailable),
      latestTag: p.latestTag || '',
      latestUrl: p.latestUrl || '',
      lastCheckAt: p.lastCheckAt || null,
      lastCheckMsg: p.lastCheckMsg || '',
      lastExtractAt: p.lastExtractAt || null,
      createdAt: p.createdAt || null,
    })

    const readNotifications = () => {
      try {
        const raw = readFileSync(notifFile(), 'utf8').trim()
        if (!raw) return []
        return raw.split('\n').slice(-100).map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
      } catch { return [] }
    }

    const latestMergeRecord = (id) => {
      try {
        const root = mergeRoot(id)
        const dirs = readdirSync(root).filter((d) => d.startsWith('m-')).sort()
        for (let i = dirs.length - 1; i >= 0; i--) {
          const rec = readJson(join(root, dirs[i], 'merge.json'), null)
          if (rec) return rec
        }
      } catch { /* 无合并记录 */ }
      return null
    }

    // 冲突报告裁剪（hunk/上下文只截取展示所需长度）
    const slimConflicts = (conflicts) => (conflicts || []).map((c) => ({
      path: c.path,
      reason: clip(c.reason, 300),
      hunks: (c.hunks || []).map((h) => ({ oldStart: h.oldStart, hunkText: clip(h.hunkText, 6000) })),
      newFileContext: c.newFileContext ? clip(c.newFileContext, 6000) : '',
    }))

    const requireProject = (rawName) => {
      const id = safeId(rawName)
      const p = loadManifest(id)
      if (!p) throw new Error('项目不存在: ' + rawName + '（先注册）')
      return p
    }

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/patch-keeper/api',
      handler: async (req, res) => {
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          } catch { /* 客户端早断开 */ }
        }
        try {
          const u = new URL(req.url || '/', 'http://localhost')
          const path = u.pathname.replace(/^\/patch-keeper\/api/, '') || '/'
          const q = u.searchParams
          const postBody = async () => {
            const t = await readBody(req)
            try { return JSON.parse(t || '{}') } catch { throw new Error('请求体不是合法 JSON') }
          }

          if (req.method === 'GET' && path === '/projects') {
            const ids = listProjectIds()
            const projects = []
            for (const id of ids) { const p = loadManifest(id); if (p) projects.push(projectSummary(p)) }
            return send(200, { ok: true, projects, pending: projects.filter((p) => p.updateAvailable).length, store: STORE })
          }
          if (req.method === 'GET' && path === '/notifications') return send(200, { ok: true, entries: readNotifications() })
          if (req.method === 'POST' && path === '/notifications/clear') { try { writeFileSync(notifFile(), '', 'utf8') } catch { /* 忽略 */ } return send(200, { ok: true }) }
          if (req.method === 'GET' && path === '/log') {
            const n = Math.min(400, Math.max(5, Number(q.get('lines')) || 40))
            let lines = []
            try { lines = readFileSync(logFile(), 'utf8').trimEnd().split('\n').slice(-n) } catch { /* 无日志 */ }
            return send(200, { ok: true, lines })
          }
          if (req.method === 'GET' && path === '/jobs') {
            return send(200, { ok: true, jobs: Array.from(jobs.values()).slice(-40) })
          }
          if (req.method === 'GET' && path === '/merge-latest') {
            const p = loadManifest(safeId(q.get('name') || ''))
            if (!p) return send(404, { ok: false, error: '项目不存在' })
            const rec = latestMergeRecord(p.id)
            if (!rec) return send(200, { ok: true, record: null })
            return send(200, { ok: true, record: Object.assign({}, rec, { conflicts: slimConflicts(rec.conflicts) }) })
          }

          if (req.method === 'POST' && path === '/check') {
            const body = await postBody()
            const job = body.name
              ? startJob('check', body.name, () => doCheck(requireProject(body.name)))
              : startJob('check', '*', () => checkAll())
            return send(200, { ok: true, jobId: job.id })
          }
          if (req.method === 'POST' && path === '/extract') {
            const body = await postBody()
            const job = startJob('extract', body.name, () => doExtract(requireProject(body.name), body))
            return send(200, { ok: true, jobId: job.id })
          }
          if (req.method === 'POST' && path === '/merge') {
            const body = await postBody()
            const job = startJob('merge', body.name, async () => {
              const r = await doMerge(requireProject(body.name), body)
              if (!r.ok) throw new Error(r.error || 'merge failed')
              r.conflicts = slimConflicts(r.conflicts)
              return r
            })
            return send(200, { ok: true, jobId: job.id })
          }
          if (req.method === 'POST' && path === '/finalize') {
            const body = await postBody()
            const job = startJob('finalize', body.name, async () => {
              const r = await doFinalize(requireProject(body.name), body)
              if (!r.ok) throw new Error(r.error || 'finalize failed')
              return r
            })
            return send(200, { ok: true, jobId: job.id })
          }
          if (req.method === 'POST' && path === '/apply') {
            const body = await postBody()
            const job = startJob('apply', body.name, async () => {
              const r = await doApply(requireProject(body.name), body)
              if (!r.ok) throw new Error(r.error || 'apply failed')
              r.conflicts = slimConflicts(r.conflicts)
              return r
            })
            return send(200, { ok: true, jobId: job.id })
          }
          if (req.method === 'POST' && path === '/init') {
            const body = await postBody()
            if (typeof body.ignore === 'string') body.ignore = body.ignore.split(',').map((s) => s.trim()).filter(Boolean)
            const job = startJob('init', body.name, async () => {
              const r = await doInit(body)
              if (!r.ok) throw new Error(r.error || 'init failed')
              if (r.patch && Array.isArray(r.patch.files)) r.patch.files = r.patch.files.slice(0, 200)
              return r
            })
            return send(200, { ok: true, jobId: job.id })
          }
          if (req.method === 'POST' && path === '/remove') {
            const body = await postBody()
            const id = safeId(body.name)
            if (!loadManifest(id)) return send(404, { ok: false, error: '项目不存在: ' + body.name })
            if (body.confirm !== true) return send(400, { ok: false, error: '需要 confirm: true' })
            rmSync(projDir(id), { recursive: true, force: true })
            rmSync(mergeRoot(id), { recursive: true, force: true })
            rmSync(storeDir('archive', id), { recursive: true, force: true })
            logLine('removed project ' + id + '（via GUI）')
            return send(200, { ok: true })
          }

          return send(404, { ok: false, error: 'not found: ' + req.method + ' ' + path })
        } catch (e) {
          return send(500, { ok: false, error: String((e && e.message) || e) })
        }
      },
    }), 'patch-keeper: gui-api')
  }

  startDaemon(ctx, cfg)
  try {
    console.log('[' + name + '] 已启动 —— 补丁包管理就绪（工具 patch_* + Web GUI /patch-keeper/api）')
  } catch { /* 忽略 */ }
}
