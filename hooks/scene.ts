import type { AgentNode } from '../types'

export type Avatar = { emoji: string; color: string; nick: string }

export function avatarFor(model: string): Avatar {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return { emoji: '🦉', color: '#8b5cf6', nick: 'Opus' }
  if (m.includes('sonnet')) return { emoji: '🦊', color: '#f97316', nick: 'Sonnet' }
  if (m.includes('haiku')) return { emoji: '🐝', color: '#eab308', nick: 'Haiku' }
  if (m.includes('fable')) return { emoji: '🦋', color: '#ec4899', nick: 'Fable' }
  return { emoji: '🤖', color: '#64748b', nick: model || '¿?' }
}

export function badgeFor(node: Pick<AgentNode, 'kind' | 'type'>): string {
  if (node.kind === 'delegacion') return '📨'
  if (node.kind === 'consulta') return '💬'
  const t = (node.type ?? '').toLowerCase()
  if (t.includes('explore')) return '🔭'
  if (t.includes('plan')) return '🗺️'
  if (t.includes('fork')) return '🍴'
  if (t.includes('general')) return '🧰'
  return '⚙️'
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 12345 -> "12,3k", 812000 -> "812k", 1250000 -> "1,3M". */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(n))
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, '').replace('.', ',')
  if (v < 1000) return String(v)
  if (v < 100_000) return `${one(v / 1000)}k`
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`
  return `${one(v / 1_000_000)}M`
}

/** input + output + cache creation + cache read. */
export function usageTokens(u: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

/** "Tokens (incl. caché): Opus (principal) 812k · Haiku 45k": totals per avatar nickname (main chat + subagents). */
export function tokensLine(agents: AgentNode[], mainModel: string, byModel: Record<string, number>): string {
  const totals = new Map<string, number>()
  const add = (model: string, n: number) => {
    if (n > 0) totals.set(avatarFor(model).nick, (totals.get(avatarFor(model).nick) ?? 0) + n)
  }
  for (const [m, n] of Object.entries(byModel)) add(m, n)
  for (const a of agents) add(a.model, a.tokens ?? 0)
  const mainNick = avatarFor(mainModel).nick
  const parts = [...totals.entries()].map(([nick, n]) => `${nick}${nick === mainNick ? ' (principal)' : ''} ${fmtTokens(n)}`)
  return parts.length ? `Tokens (incl. caché): ${parts.join(' · ')}` : ''
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : s)

/** The brief of a prompt: no "Eres un subagente…" line, the text after OBJETIVO: if present, ~160 chars. */
export function taskOf(prompt: string, max = 160): string {
  let lines = String(prompt ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (lines.length && /^eres un subagente/i.test(lines[0]!)) lines = lines.slice(1)
  let text = lines.join(' ')
  const m = text.match(/OBJETIVO:\s*/i)
  if (m && m.index !== undefined) {
    text = text.slice(m.index + m[0].length)
    const next = text.search(/\s[A-ZÁÉÍÓÚÑ]{4,}:\s/)
    if (next > 0) text = text.slice(0, next)
  } else {
    text = lines.filter(l => !/^#+\s/.test(l) && !/^[A-ZÁÉÍÓÚÑ ]{4,}:?$/.test(l)).join(' ')
  }
  return cut(text.replace(/\s+/g, ' ').trim(), max)
}

/** A readable detail of a tool call's input. */
export function toolDetail(_tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
  const file = s('file_path') || s('path') || s('notebook_path')
  if (file) return base(file)
  if (s('pattern')) return cut(s('pattern'), 40)
  if (s('command')) return cut(s('command').replace(/\s+/g, ' ').trim(), 40)
  if (s('description')) return cut(s('description'), 40)
  if (s('url')) return cut(s('url'), 40)
  return ''
}

/** Word-wraps into at most `lines` lines of `width` chars; the last one is cut with an ellipsis. */
export function wrap(text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let cur = ''
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]!
    if (cur && (cur + ' ' + w).length > width) {
      if (out.length === lines - 1) break
      out.push(cur)
      cur = w
    } else cur = cur ? cur + ' ' + w : w
  }
  if (cur) out.push(i < words.length ? cut(cur + ' ' + words.slice(i).join(' '), width) : cut(cur, width))
  return out
}

const HEX = '0,-22 19,-11 19,11 0,22 -19,11 -19,-11'

/** Which glyph symbol an avatar uses (by model nickname). */
export function glyphFor(av: Avatar): string {
  return ({ Opus: 'g-opus', Sonnet: 'g-sonnet', Haiku: 'g-haiku', Fable: 'g-fable' } as Record<string, string>)[av.nick] ?? 'g-core'
}

/** Which small badge symbol a node's kind/type uses. */
export function badgeKey(node: Pick<AgentNode, 'kind' | 'type'>): string {
  if (node.kind === 'delegacion') return 'b-deleg'
  if (node.kind === 'consulta') return 'b-ask'
  const t = (node.type ?? '').toLowerCase()
  if (t.includes('explore')) return 'b-explore'
  if (t.includes('plan')) return 'b-plan'
  if (t.includes('fork')) return 'b-fork'
  if (t.includes('general')) return 'b-general'
  return 'b-other'
}

const W3 = 'fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
const sym = (id: string, box: number, body: string) => `<symbol id="${id}" viewBox="${-box} ${-box} ${box * 2} ${box * 2}" overflow="visible">${body}</symbol>`

/** Gradients, glow and every glyph/badge symbol, defined once. */
function defsSvg(): string {
  const colors = ['#8b5cf6', '#f97316', '#eab308', '#ec4899', '#64748b']
  const grads = colors
    .map(c => `<linearGradient id="g${c.slice(1)}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity=".45"/></linearGradient>`)
    .join('')
  const glyphs = [
    sym('g-opus', 12, `<g ${W3}><path d="M0,0 L-7,-6 M0,0 L1,-9 M0,0 L8,-4 M0,0 L-8,4 M0,0 L3,8 M0,0 L9,5 M-7,-6 L1,-9 M1,-9 L8,-4 M-8,4 L3,8"/></g><circle r="2.8" fill="#fff"/><g fill="#fff"><circle cx="-7" cy="-6" r="1.7"/><circle cx="1" cy="-9" r="1.7"/><circle cx="8" cy="-4" r="1.7"/><circle cx="-8" cy="4" r="1.7"/><circle cx="3" cy="8" r="1.7"/><circle cx="9" cy="5" r="1.7"/></g>`),
    sym('g-sonnet', 12, `<g ${W3}><circle r="8" stroke-width="3" stroke-dasharray="2.3 3.3"/><circle r="5.2"/></g><polygon points="1.5,-5 -3,1 0,1 -1.5,5.5 3.5,-1 0.5,-1" fill="#fff"/>`),
    sym('g-haiku', 12, `<g ${W3}><circle r="9"/><circle r="5" stroke-opacity=".6"/><path d="M0,0 L7,-5.5"/></g><circle r="1.6" fill="#fff"/><circle cx="3.5" cy="3.5" r="1.4" fill="#fff"/>`),
    sym('g-fable', 12, `<g ${W3}><path d="M-6,9 C-9,-2 2,-10 9,-9 C9,-1 3,7 -6,9 Z"/><path d="M-6,9 L4,-4"/><path d="M-1,4 L3,5 M1,1 L5,2"/></g>`),
    sym('g-main', 12, `<path d="M-8,-1 L-8,-8 L-4,-4 L0,-9 L4,-4 L8,-8 L8,-1 Z" fill="#fff"/><g ${W3}><circle cx="0" cy="6" r="4.5"/></g><circle cx="0" cy="6" r="1.8" fill="#fff"/>`),
    sym('g-core', 12, `<g ${W3}><circle r="8"/></g><circle r="3" fill="#fff"/>`),
  ].join('')
  const badges = [
    sym('b-explore', 6, `<g fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"><circle cx="-1" cy="-1" r="3.2"/><path d="M1.5,1.5 L5,5"/></g>`),
    sym('b-plan', 6, `<g fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"><path d="M-5,-3 L-2,-4.5 L2,-3 L5,-4.5 L5,3 L2,4.5 L-2,3 L-5,4.5 Z M-2,-4.5 L-2,3 M2,-3 L2,4.5"/></g>`),
    sym('b-fork', 6, `<g fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M0,5 L0,0 M0,0 L-3.5,-4 M0,0 L3.5,-4"/></g>`),
    sym('b-general', 6, `<g fill="none" stroke="#fff" stroke-width="1.3"><rect x="-4.5" y="-4.5" width="3.5" height="3.5"/><rect x="1" y="-4.5" width="3.5" height="3.5"/><rect x="-4.5" y="1" width="3.5" height="3.5"/><rect x="1" y="1" width="3.5" height="3.5"/></g>`),
    sym('b-deleg', 6, `<polygon points="-5,-1 5,-5 1,5 0,1" fill="#fff"/>`),
    sym('b-ask', 6, `<g fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"><path d="M-5,-4 H5 V2 H0 L-3,5 V2 H-5 Z"/></g>`),
    sym('b-star', 6, `<polygon points="0,-5.5 1.6,-1.7 5.5,-1.5 2.5,1 3.4,5 0,2.8 -3.4,5 -2.5,1 -5.5,-1.5 -1.6,-1.7" fill="#fff"/>`),
    sym('b-other', 6, `<circle r="3.5" fill="#fff"/>`),
  ].join('')
  return `<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity=".25"/></filter><filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>${grads}${glyphs}${badges}</defs>`
}

export const SCENE_W = 460
const INDENT = 28
const GAP = 14
const MAIN_H = 64
// Card rows (baselines from the card top): title 30, meta 48, then task lines every LINE_H from TASK_Y0, status at the bottom.
const LINE_H = 16
const TASK_Y0 = 66
// Average glyph widths (px) for 12/12.5px sans-serif, generous so text is cut instead of overflowing the card.
const CHAR_W = 6.8

type Placed = { node: AgentNode; depth: number; x: number; y: number; w: number; h: number; lines: string[]; parent: string }

function layout(agents: AgentNode[]) {
  const ids = new Set(agents.map(a => a.id))
  const kids = new Map<string, AgentNode[]>()
  for (const a of agents) {
    const p = ids.has(a.parentId) && a.parentId !== a.id ? a.parentId : 'main'
    kids.set(p, [...(kids.get(p) ?? []), a])
  }
  const placed: Placed[] = []
  const seen = new Set<string>()
  let y = MAIN_H + GAP
  const walk = (pid: string, depth: number) => {
    for (const a of kids.get(pid) ?? []) {
      if (seen.has(a.id) || depth > 6) continue
      seen.add(a.id)
      const x = depth * INDENT
      const w = SCENE_W - 4 - x
      const maxChars = Math.min(55, Math.floor((w - 76) / CHAR_W))
      const task = a.task ? wrap('Encargo: ' + a.task, maxChars, 2) : []
      // title+meta block (to y=48), task lines, then a status row of its own: nothing shares a baseline.
      const h = (task.length ? TASK_Y0 + (task.length - 1) * LINE_H : 48) + 12 + 18 + 6
      placed.push({ node: a, depth, x, y, w, h, lines: task, parent: pid })
      y += h + GAP
      walk(a.id, depth + 1)
    }
  }
  walk('main', 1)
  const height = placed.length ? y - GAP + 4 : MAIN_H + GAP + 36
  return { placed, height }
}

/** Pixel size of the scene's SVG for these agents. */
export function sceneSize(agents: AgentNode[]): { width: number; height: number } {
  return { width: SCENE_W, height: layout(agents).height }
}

/** The whole scene as one animated SVG document (SMIL, no script): a vertical chain of cards. */
export function sceneSvg(agents: AgentNode[], mainModel: string, now: number, byModel: Record<string, number> = {}): string {
  const { placed, height } = layout(agents)
  const main = avatarFor(mainModel)
  const W = SCENE_W
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family="system-ui,Segoe UI,sans-serif">`,
    defsSvg(),
    `<rect width="${W}" height="${height}" rx="12" fill="#0f172a"/>`,
  )

  const byId = new Map(placed.map(p => [p.node.id, p]))
  // Trunks first (under the cards), with the envelopes going down / the mark coming back up.
  placed.forEach((p, i) => {
    const a = p.node
    const par = byId.get(p.parent)
    const tx = (p.depth - 1) * INDENT + 16
    const y0 = par ? par.y + par.h : MAIN_H
    const y1 = p.y + 28
    const down = `M${tx},${y0} V${y1} H${p.x}`
    const up = `M${p.x},${y1} H${tx} V${y0}`
    const av = avatarFor(a.model)
    const running = a.status === 'running'
    out.push(
      `<path id="e${i}" d="${down}" fill="none" stroke="${running ? av.color : '#334155'}" stroke-width="${running ? 2.5 : 1.5}" stroke-dasharray="${running ? '6 5' : '0'}" opacity="${running ? 0.95 : 0.6}">` +
        (running ? `<animate attributeName="stroke-dashoffset" from="22" to="0" dur="0.8s" repeatCount="indefinite"/>` : '') +
        `</path>`,
    )
    if (running) {
      for (const delay of [0, 0.9]) {
        out.push(
          `<g><text font-size="16" text-anchor="middle" dy="5">📄</text>` +
            `<animateMotion dur="1.8s" begin="${delay}s" repeatCount="indefinite" path="${down}"/></g>`,
        )
      }
    } else if (a.endedAt && now - a.endedAt < 8000) {
      const ok = a.status === 'done'
      out.push(
        `<g><circle r="9" fill="${ok ? '#22c55e' : '#ef4444'}"/><text font-size="12" text-anchor="middle" dy="4" fill="#fff">${ok ? '✓' : '!'}</text>` +
          `<animateMotion dur="1.4s" begin="0s" fill="freeze" path="${up}"/>` +
          `<animate attributeName="opacity" from="1" to="0" begin="1.4s" dur="0.6s" fill="freeze"/></g>`,
      )
    }
  })

  const avatar = (cx: number, cy: number, av: Avatar, glyph: string, state: 'running' | 'done' | 'error' | 'main', badge: string) => {
    const running = state === 'running'
    const gid = 'g' + av.color.slice(1)
    const pulse = running
      ? `<polygon points="${HEX}" transform="translate(${cx} ${cy})" fill="none" stroke="${av.color}" stroke-width="2"><animateTransform attributeName="transform" type="scale" additive="sum" values="1;1.7;1" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values=".8;0;.8" dur="1.8s" repeatCount="indefinite"/></polygon>` +
        `<g transform="translate(${cx} ${cy})"><g><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2.4s" repeatCount="indefinite"/>` +
        `<circle r="30" fill="none" stroke="${av.color}" stroke-opacity=".35" stroke-dasharray="2 5"/>` +
        `<circle cx="30" cy="0" r="2.6" fill="#fff"/><circle cx="-15" cy="26" r="2.2" fill="${av.color}"/><circle cx="-15" cy="-26" r="1.8" fill="#fff" fill-opacity=".8"/></g></g>` +
        `<path d="M${cx + 24},${cy} h6 M${cx - 24},${cy} h-6 M${cx},${cy - 25} v-5 M${cx},${cy + 25} v5" stroke="${av.color}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 3"><animate attributeName="stroke-dashoffset" from="6" to="0" dur=".6s" repeatCount="indefinite"/></path>`
      : ''
    const glyphUse = `<g transform="translate(${cx} ${cy})"><g>${running ? `<animateTransform attributeName="transform" type="scale" values="1;1.06;1" dur="1.6s" repeatCount="indefinite"/>` : ''}<use href="#${glyph}" x="-13" y="-13" width="26" height="26"/></g></g>`
    const mark =
      state === 'done'
        ? `<circle cx="${cx + 17}" cy="${cy + 17}" r="8" fill="#22c55e" stroke="#0f172a" stroke-width="1.5"/><text x="${cx + 17}" y="${cy + 21}" font-size="11" text-anchor="middle" fill="#fff">✓</text>`
        : state === 'error'
          ? `<circle cx="${cx + 17}" cy="${cy + 17}" r="8" fill="#ef4444" stroke="#0f172a" stroke-width="1.5"/><text x="${cx + 17}" y="${cy + 21}" font-size="11" text-anchor="middle" fill="#fff">!</text>`
          : ''
    const badgeSvg = badge
      ? `<g transform="translate(${cx - 17} ${cy - 17})"><circle r="9" fill="#1e293b" stroke="${av.color}" stroke-width="1.2"/><g>${running ? `<animate attributeName="opacity" values="1;.35;1" dur="1.1s" repeatCount="indefinite"/>` : ''}<use href="#${badge}" x="-6" y="-6" width="12" height="12"/></g></g>`
      : ''
    return (
      pulse +
      `<polygon points="${HEX}" transform="translate(${cx} ${cy})" fill="url(#${gid})" stroke="#fff" stroke-opacity="${running || state === 'main' ? 0.8 : 0.3}" stroke-width="1.5"${running ? ' filter="url(#glow)"' : ''}/>` +
      glyphUse +
      badgeSvg +
      mark
    )
  }

  // Main card.
  const mainTokens = Object.values(byModel).reduce((t, n) => t + n, 0)
  const live = agents.filter(a => a.status === 'running').length
  const mainTitle = `Claude (principal) · ${main.nick}${mainTokens > 0 ? ` · ${fmtTokens(mainTokens)} tok` : ''}`
  const mainSub = live > 0 ? `Repartiendo trabajo: ${live} agente${live === 1 ? '' : 's'} en marcha` : 'Al mando'
  out.push(
    `<g filter="url(#sh)"><title>${esc(`Agente principal · ${mainModel}`)}</title>` +
      `<rect x="0" y="0" width="${W - 4}" height="${MAIN_H}" rx="10" fill="#1e293b" stroke="${main.color}" stroke-width="1.5"/>` +
      avatar(32, 32, main, 'g-main', 'main', 'b-star') +
      `<text x="64" y="28" font-size="15" font-weight="700" fill="#f1f5f9">${esc(cut(mainTitle, 44))}</text>` +
      `<text x="64" y="48" font-size="12.5" fill="${main.color}">${esc(mainSub)}</text></g>`,
  )

  for (const p of placed) {
    const a = p.node
    const av = avatarFor(a.model)
    const running = a.status === 'running'
    const took = duration((a.endedAt ?? now) - a.startedAt)
    const tx = p.x + 64
    const maxChars = Math.floor((p.w - 76) / CHAR_W)
    const meta = [av.nick, a.type, took, a.tokens && a.tokens > 0 ? `${fmtTokens(a.tokens)} tok` : ''].filter(Boolean).join(' · ')
    const status = running
      ? `Ahora: ${a.lastTool ? `⚙ ${a.lastTool}` : 'pensando…'} · ${a.toolCount} herramienta${a.toolCount === 1 ? '' : 's'}`
      : a.status === 'done'
        ? `✓ Terminó en ${took}`
        : '✗ Falló'
    const statusColor = running ? '#e2e8f0' : a.status === 'done' ? '#4ade80' : '#f87171'
    const ty = p.y + 30
    const taskSvg = p.lines
      .map((l, i) => {
        const y = p.y + TASK_Y0 + LINE_H * i
        return i === 0 && l.startsWith('Encargo: ')
          ? `<text x="${tx}" y="${y}" font-size="12" fill="#94a3b8"><tspan fill="${av.color}" font-weight="600">Encargo:</tspan> ${esc(l.slice(9))}</text>`
          : `<text x="${tx}" y="${y}" font-size="12" fill="#94a3b8">${esc(l)}</text>`
      })
      .join('')
    const sy = p.y + p.h - 12
    out.push(
      `<g opacity="${running ? 1 : 0.6}" filter="url(#sh)"><title>${esc(`${a.label}\n${a.type} · ${a.model}\n${status}`)}</title>` +
        `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10" fill="#1e293b" stroke="${running ? av.color : '#334155'}" stroke-width="${running ? 2 : 1}">` +
        (running ? `<animate attributeName="stroke-opacity" values="1;.4;1" dur="1.6s" repeatCount="indefinite"/>` : '') +
        `</rect>` +
        avatar(p.x + 32, p.y + 30, av, glyphFor(av), a.status, badgeKey(a)) +
        `<text x="${tx}" y="${ty}" font-size="15" font-weight="700" fill="#f1f5f9">${esc(cut(a.label, Math.floor(maxChars * 0.75)))}</text>` +
        `<text x="${tx}" y="${ty + 18}" font-size="12.5" fill="${av.color}">${esc(cut(meta, maxChars))}</text>` +
        taskSvg +
        `<text x="${tx}" y="${sy}" font-size="12.5" font-weight="600" fill="${statusColor}">${esc(cut(status, maxChars))}</text></g>`,
    )
  }
  if (agents.length === 0) {
    out.push(
      `<text x="${W / 2}" y="${MAIN_H + GAP + 22}" font-size="13" text-anchor="middle" fill="#64748b">Sin subagentes todavía — cuando delegues algo aparecerá aquí</text>`,
    )
  }
  out.push(`</svg>`)
  return out.join('')
}


/** Terminal cells of a string (emoji and wide symbols count 2). */
export function cells(s: string): number {
  let n = 0
  for (const ch of s) n += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1
  return n
}

/** Cuts to at most `n` cells, ending with an ellipsis when something was dropped. */
export function fit(s: string, n: number): string {
  if (n <= 0) return ''
  if (cells(s) <= n) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1
    if (w + cw > n - 1) break
    out += ch
    w += cw
  }
  return out.trimEnd() + '…'
}

export type BandRow = { emoji: string; nick: string; color: string; text: string; dim: boolean }

const RECENT_MS = 30_000

/**
 * The compact drawing for the strip above the prompt: one row per card, never taller than
 * min(maxRows, 8). First row is the main agent; then up to 3 sub-agents (running first, then the
 * recently finished) and a «+N» row. Every row is cut to `cols` cells, so nothing wraps or overlaps.
 */
export function bandRows(agents: AgentNode[], mainModel: string, now: number, cols: number, maxRows = 8): BandRow[] {
  const limit = Math.max(1, Math.min(maxRows || 8, 8))
  const main = avatarFor(mainModel)
  const running = agents.filter(a => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
  const recent = agents.filter(a => a.status !== 'running' && a.endedAt && now - a.endedAt < RECENT_MS).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const all = [...running, ...recent]
  const mk = (av: Avatar, rest: string, dim: boolean): BandRow => {
    const room = Math.max(1, cols - cells(av.emoji) - 1 - cells(av.nick) - 1)
    return { emoji: av.emoji, nick: av.nick, color: av.color, text: fit(rest, room), dim }
  }
  const rows: BandRow[] = []
  if (all.length === 0) {
    rows.push(mk(main, '· principal · sin subagentes', false))
    return rows
  }
  rows.push(mk(main, `· principal · ${running.length} en marcha`, false))
  // At most 3 cards; when more exist, the last visible slot is the «+N» row.
  const slots = Math.min(3, limit - 1)
  const shown = all.length <= slots ? all : all.slice(0, Math.max(0, Math.min(3, limit - 2)))
  for (const a of shown) {
    const av = avatarFor(a.model)
    const took = duration((a.endedAt ?? now) - a.startedAt)
    const mark = a.status === 'running' ? '▶' : a.status === 'done' ? '✓' : '✗'
    const tool = a.status === 'running' ? ` · ${a.lastTool ? `⚙ ${a.lastTool}` : 'pensando…'}` : ''
    rows.push(mk(av, `${mark} ${a.label} · ${a.type} · ${took}${tool}`, a.status !== 'running'))
  }
  if (all.length > shown.length && rows.length < limit) {
    rows.push({ emoji: '', nick: '', color: '', text: fit(`+${all.length - shown.length} más`, cols), dim: true })
  }
  return rows
}

// ---- métricas de delegación del chat principal (panel) ----

export const AMBAR = '#f59e0b'
export const TASA_AMBAR = 0.8
export const DELEG_TURNO_AMBAR = 6

export type MetricaFila = { text: string; warn: boolean }

// Tasa de delegación: delegaciones / (delegaciones + llamadas propias de exploración).
export function tasaDelegacion(m: Pick<RelevoMetricas, 'delegaciones' | 'exploracion'>): number | undefined {
  const total = m.delegaciones + m.exploracion
  return total > 0 ? m.delegaciones / total : undefined
}

// Filas del bloque «Delegación»; en ámbar la tasa por encima del 80 % y más de 6 delegaciones
// en un turno (el actual o el anterior): señal de sobrefragmentación.
export function metricasRows(m: RelevoMetricas): MetricaFila[] {
  const tasa = tasaDelegacion(m)
  const tasaWarn = tasa !== undefined && tasa > TASA_AMBAR
  const maxTurno = Math.max(m.turnoDeleg, m.previoDeleg)
  const fragWarn = maxTurno > DELEG_TURNO_AMBAR
  return [
    { text: `Llamadas propias: ${m.propias} (${m.exploracion} de exploración)`, warn: false },
    { text: `Delegaciones: ${m.delegaciones}`, warn: false },
    {
      text: `Tasa de delegación: ${tasa === undefined ? '—' : Math.round(tasa * 100) + ' %'}${tasaWarn ? ' · alta: ¿demasiado fragmentado?' : ''}`,
      warn: tasaWarn,
    },
    { text: `Turnos con ≥5 llamadas propias y 0 delegaciones: ${m.turnosLargos}`, warn: false },
    {
      text: `Delegaciones por turno: ${m.turnoDeleg} ahora · ${m.previoDeleg} antes${fragWarn ? ' · más de 6: sobrefragmentación' : ''}`,
      warn: fragWarn,
    },
  ]
}
