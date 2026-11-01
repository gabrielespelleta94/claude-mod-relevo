import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNode, RelevoDelegation, RelevoMetricas, RelevoPeer } from '../types'
import { avisoSalida, cuentaLlamada, empujon, metricas, recordatorioInicio, restaura, resetTurno } from './empujon'
import { CABECERA_SUBAGENTE, POLITICA } from './politica'
import { AMBAR, avatarFor, bandRows, metricasRows, duration, sceneSize, sceneSvg, taskOf, toolDetail, tokensLine, usageTokens } from './scene'

const PANE = 'relevo'
const TITLE = 'Relevo: agentes, delegaciones y chats'
const PEER_PREFIX = 'peer:'
const HEARTBEAT_MS = 30_000
const ALIVE_MS = 90_000

const peers = atom({ plugin: 'relevo', key: 'peers' } as const, [])
const delegations = atom({ plugin: 'relevo', key: 'delegations' } as const, [])
const agents = atom({ plugin: 'relevo', key: 'agents' } as const, [] as AgentNode[])
const mainModel = atom({ plugin: 'relevo', key: 'mainModel' } as const, '')
const tokensByModel = atom({ plugin: 'relevo', key: 'tokensByModel' } as const, {} as Record<string, number>)
const METRICAS_VACIAS: RelevoMetricas = {
  propias: 0, exploracion: 0, delegaciones: 0, turnosLargos: 0,
  turnoPropias: 0, turnoExploracion: 0, turnoDeleg: 0, previoPropias: 0, previoDeleg: 0,
}
// Con etiqueta de forma: tras recargar el mod, un valor guardado con otra forma se lee como ausente.
const metricasState = atom({ plugin: 'relevo', key: 'metricas' } as const, METRICAS_VACIAS, { shape: 'metricas-1' })

// Alias corto -> id completo; $.model.complete pide id, el Agent acepta ambos.
const MODELS: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
const MODEL_NAMES = Object.keys(MODELS)

const resolveModel = (name: string) => MODELS[name.trim().toLowerCase()] ?? name.trim()
const shortId = (id: string) => id.slice(0, 8)
// Los campos llegan sueltos en el evento o dentro de e.input.
const arg = (e: unknown, key: string) => {
  const direct = (e as Record<string, unknown>)[key]
  if (typeof direct === 'string') return direct
  const nested = ((e as { input?: Record<string, unknown> | null }).input ?? {})[key]
  return typeof nested === 'string' ? nested : ''
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const firstLine = (s: string, n = 40) => {
  const line = s.split('\n').find(l => l.trim()) ?? ''
  return line.length > n ? line.slice(0, n - 1) + '…' : line
}

// Líneas que devolverá un Read, contadas antes de ejecutarlo; undefined si no se puede saber.
const NO_TEXTO = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i
async function lineasDeLectura($: EngineInterface, input: Record<string, unknown>): Promise<number | undefined> {
  const nested = (input.input ?? {}) as Record<string, unknown>
  const path = String(input.file_path ?? nested.file_path ?? '')
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)
  if (!path || NO_TEXTO.test(path)) return undefined
  const { size } = await $.fs.stat(path)
  if (size < 300) return 0
  if (size > 2_000_000) return undefined
  const text = await $.fs.read(path)
  const total = text.split('\n').length
  const start = num(input.offset ?? nested.offset) ?? 1
  const limit = num(input.limit ?? nested.limit) ?? 2000
  return Math.min(limit, Math.max(0, total - start + 1))
}

// Los contadores de empujon.ts viven en el módulo y una recarga los pierde: la primera vez se
// recuperan de $.state; cada cambio se guarda ahí para el panel.
let restaurado = false
async function recupera($: EngineInterface) {
  if (restaurado) return
  restaurado = true
  restaura(await read($, metricasState))
}
async function guarda($: EngineInterface) {
  await recupera($)
  await update($, metricasState, () => metricas())
}

// Subagente de delegar cuya llamada está en vuelo: el spawn de dentro es suyo.
let pendingDelegation: string | undefined

// $.state rechaza undefined en cualquier valor: se quitan esos campos.
const clean = (a: AgentNode): AgentNode =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as AgentNode
const withTask = (text: string): { task?: string } => {
  const task = taskOf(text)
  return task ? { task } : {}
}

async function edit($: EngineInterface, fn: (list: AgentNode[]) => AgentNode[]) {
  const next = await update($, agents, list => fn(list ?? []).slice(-30).map(clean))
  const live = next.filter(a => a.status === 'running').length
  await $.ui.status(live > 0 ? `🤖 ${live} agente${live === 1 ? '' : 's'} trabajando` : undefined)
}

const patchAgent = (id: string, fields: Partial<AgentNode>) => (list: AgentNode[]) =>
  list.map(a => (a.id === id ? { ...a, ...fields } : a))

async function finish($: EngineInterface, id: string, ok: boolean) {
  const at = await $.clock.now()
  await edit($, list =>
    list.map(a => (a.id === id && a.status === 'running' ? { ...a, status: ok ? 'done' : 'error', endedAt: at } : a)),
  )
}
// Cierra el primer nodo en marcha de la lista (la llamada Agent puede conocerlo por dos ids).
async function finishNode($: EngineInterface, ids: string[], ok: boolean) {
  const at = await $.clock.now()
  await edit($, list =>
    list.map(a => (ids.includes(a.id) && a.status === 'running' ? { ...a, status: ok ? 'done' : 'error', endedAt: at } : a)),
  )
}
const answer = (text: string) => ({ result: text })

// ---- registro de chats vivos (compartido entre sesiones vía $.store) ----

async function heartbeat($: EngineInterface) {
  const [id, model, cwd, now] = await Promise.all([
    $.session.id(),
    $.session.model(),
    $.session.cwd(),
    $.clock.now(),
  ])
  await $.store.set(PEER_PREFIX + id, { id, model, cwd, lastSeen: now })
  await refreshPeers($, id, now)
}

async function refreshPeers(
  $: EngineInterface,
  selfId: string,
  now: number,
) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(PEER_PREFIX))
  const live: RelevoPeer[] = []
  for (const key of keys) {
    const peer = (await $.store.get(key)) as RelevoPeer | undefined
    if (!peer) continue
    if (now - peer.lastSeen > ALIVE_MS * 10) await $.store.delete(key)
    else if (peer.id !== selfId && now - peer.lastSeen <= ALIVE_MS) live.push(peer)
  }
  await update($, peers, () => live)
  return live
}

const MAX_ROWS = 50

async function addRow($: EngineInterface, row: RelevoDelegation) {
  await update($, delegations, list => [...list, row].slice(-MAX_ROWS))
}

async function patchRow(
  $: EngineInterface,
  agentId: string,
  patch: Partial<RelevoDelegation>,
) {
  await update($, delegations, list => list.map(d => (d.agentId === agentId ? { ...d, ...patch } : d)))
}

// Fila ya terminada para una consulta de una sola pasada (consultar y /consultar).
async function recordConsulta(
  $: EngineInterface,
  model: string,
  question: string,
  r: { isAnswered: boolean; text?: string; reason?: string },
) {
  const now = await $.clock.now()
  await addRow($, {
    agentId: `consulta-${now}`,
    model,
    task: question,
    status: r.isAnswered ? 'done' : 'failed',
    startedAt: now,
    answer: r.isAnswered ? r.text : r.reason,
    via: 'consultar',
  })
}

async function startDelegation(
  $: EngineInterface,
  modelName: string,
  task: string,
  description: string,
): Promise<{ deny: string } | { agentId: string; model: string }> {
  if (!modelName.trim() || !task.trim()) return { deny: 'Faltan modelo o tarea.' }
  // El Agent solo acepta alias (haiku, sonnet, opus, fable); un id completo se pasa tal cual.
  const alias = modelName.trim().toLowerCase()
  const model = alias in MODELS ? alias : modelName.trim()
  const spawned = await $.agent.spawn({
    subagentType: 'general-purpose',
    model,
    prompt: CABECERA_SUBAGENTE + task,
    description: description || task.slice(0, 40),
  })
  if (spawned.deny !== undefined || !spawned.agentId) {
    return { deny: `No se pudo lanzar: ${spawned.deny ?? 'sin agentId'}` }
  }
  const row: RelevoDelegation = {
    agentId: spawned.agentId,
    model: spawned.model,
    task,
    status: 'running',
    startedAt: await $.clock.now(),
    via: 'delegar',
  }
  await addRow($, row)
  return { agentId: row.agentId, model: row.model }
}

export const register: Register = on => {
  // Informes de subagentes que terminan antes de que vuelva su llamada a Agent.
  const informes = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register({
        name: 'chats',
        description:
          'Lista los otros chats de Claude Code abiertos ahora en esta máquina (id, modelo, carpeta). Úsalo siempre antes de enviar, para confirmar el destino.',
        isDeferred: false,
      }),
      $.tool.register({
        name: 'enviar',
        description:
          'Envía un encargo o una respuesta a OTRO chat abierto (su id o prefijo, de chats). Úsalo solo si el usuario lo pide o si la tarea pertenece al proyecto de ese chat. El otro chat lo recibe como mensaje de un compañero y responde con esta misma herramienta. No envíes acciones irreversibles.',
        inputSchema: {
          type: 'object',
          properties: {
            chat: { type: 'string', description: 'Id (o prefijo) del chat destino, de la herramienta chats' },
            mensaje: { type: 'string', description: 'Texto del encargo o la respuesta' },
          },
          required: ['chat', 'mensaje'],
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'consultar',
        description:
          'Pregunta de una sola pasada a otro modelo, síncrona, sin herramientas ni historial: resumir o clasificar un texto que ya tienes (haiku), revisión crítica antes de algo importante (opus), pulir un texto para cliente (fable). Mete en la pregunta todo el contexto. Si hace falta leer ficheros o ejecutar algo, usa delegar.',
        inputSchema: {
          type: 'object',
          properties: {
            modelo: { type: 'string', description: `Uno de ${MODEL_NAMES.join(', ')} o un id de modelo` },
            pregunta: { type: 'string', description: 'La pregunta, con todo el contexto que necesite' },
            sistema: { type: 'string', description: 'Instrucciones de sistema opcionales' },
          },
          required: ['modelo', 'pregunta'],
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'delegar',
        description:
          'Lanza en segundo plano un subagente con otro modelo y con herramientas (leer, buscar, ejecutar, editar). Úsalo para búsquedas amplias y resúmenes de mucho material (haiku), implementación ya especificada (sonnet) o análisis difícil (opus), y para subtareas independientes en paralelo. El subagente no ve esta conversación: el encargo debe ser autocontenido, con rutas absolutas, restricciones (solo lectura salvo que indiques qué editar) y formato de respuesta. Nunca delegues acciones irreversibles. Recoge la respuesta con resultado. Alternativa: en modo automático usa la herramienta Agent con model.',
        inputSchema: {
          type: 'object',
          properties: {
            modelo: { type: 'string', description: `Uno de ${MODEL_NAMES.join(', ')} o un id de modelo` },
            tarea: { type: 'string', description: 'La tarea, autocontenida: el subagente no ve esta conversación' },
            descripcion: { type: 'string', description: 'Título corto (3-5 palabras)' },
          },
          required: ['modelo', 'tarea'],
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'resultado',
        description: 'Devuelve el estado y la respuesta de una delegación lanzada con delegar.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'agentId (o prefijo) de la delegación' } },
          required: ['id'],
        },
      }),
      $.command.register({ name: 'relevo', description: 'Panel de agentes, delegaciones y chats conectados' }),
      $.command.register({ name: 'agentes', description: 'Alias de /relevo: abre el mismo panel' }),
      $.command.register({
        name: 'delegar',
        description: 'Delega una tarea a otro modelo: /delegar <haiku|sonnet|opus|fable> <tarea>',
        argumentHint: '<modelo> <tarea>',
      }),
      $.command.register({
        name: 'consultar',
        description: 'Pregunta rápida a otro modelo: /consultar <haiku|sonnet|opus|fable> <pregunta>',
        argumentHint: '<modelo> <pregunta>',
      }),
    ])

    await heartbeat($)
    $.clock.every(HEARTBEAT_MS, () => heartbeat($))

    const model = await $.session.model().catch(() => '')
    if (model) await update($, mainModel, () => model)
    return next(e)
  })

  // Política de delegación en el system prompt de cada chat.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('mcp__relevo__delegar')) return composed
    return {
      sections: [...composed.sections, { id: 'relevo:politica', text: POLITICA, scope: 'session' as const }],
    }
  })

  on('session.end', async ($, e, next) => {
    await $.store.delete(PEER_PREFIX + (await $.session.id()))
    return next(e)
  })

  // ---- herramientas que ve el modelo ----

  on('tool.call', { tool: 'mcp__relevo__chats' }, async $ => {
    const live = await refreshPeers($, await $.session.id(), await $.clock.now())
    if (live.length === 0) return answer('No hay otros chats abiertos con el mod relevo cargado.')
    return answer(
      live.map(p => `- ${shortId(p.id)} (id completo ${p.id}) · ${p.model} · ${p.cwd}`).join('\n'),
    )
  })

  on('tool.call', { tool: 'mcp__relevo__enviar' }, async ($, e) => {
    const target = arg(e, 'chat').trim()
    const text = arg(e, 'mensaje').trim()
    if (!target || !text) return { deny: 'Faltan chat o mensaje.' }

    const selfId = await $.session.id()
    const live = await refreshPeers($, selfId, await $.clock.now())
    const matches = live.filter(p => p.id.startsWith(target))
    if (matches.length !== 1) {
      return {
        deny: matches.length === 0
          ? `Ningún chat abierto empieza por "${target}". Usa la herramienta chats.`
          : `"${target}" es ambiguo: ${matches.map(p => shortId(p.id)).join(', ')}.`,
      }
    }

    const dest = matches[0]!
    const footer = `\n\n— Enviado desde el chat ${selfId} (${await $.session.model()}). Para responder usa la herramienta mcp__relevo__enviar con chat="${shortId(selfId)}".`
    const sent = await $.session.send({ to: { sessionId: dest.id }, text: text + footer })
    return sent.isDelivered
      ? answer(`Entregado a ${shortId(dest.id)} (${dest.model}). Su respuesta llegará como mensaje.`)
      : { deny: `No se entregó: ${sent.reason}` }
  })

  // consultar: viva en el dibujo mientras dura la llamada, y fila en Delegaciones al acabar.
  on('tool.call', { tool: 'mcp__relevo__consultar' }, async ($, e) => {
    const model = resolveModel(arg(e, 'modelo'))
    const system = arg(e, 'sistema')
    const pregunta = arg(e, 'pregunta')
    const at = await $.clock.now()
    const id = `consulta-${(e as { tool_use_id?: string }).tool_use_id ?? at}`
    await edit($, list => [
      ...list,
      {
        id,
        parentId: (e as { agentId?: string }).agentId ?? 'main',
        kind: 'consulta',
        label: firstLine(pregunta) || 'consulta',
        type: 'consulta',
        model: arg(e, 'modelo'),
        status: 'running',
        startedAt: at,
        toolCount: 0,
        ...withTask(pregunta),
      },
    ])
    let r
    try {
      r = await $.model.complete({
        model,
        prompt: pregunta,
        ...(system ? { system } : {}),
        maxTokens: 16_000, timeoutMs: 300_000,
      })
    } catch (err) {
      await finish($, id, false)
      throw err
    }
    await finish($, id, r.isAnswered)
    await recordConsulta($, model, pregunta, r)
    return r.isAnswered
      ? answer(`[${model}]\n${r.text}`)
      : { deny: `${model} no respondió (${r.reason}).` }
  })

  // delegar: nodo en el dibujo desde la llamada; agent.spawn lo renombra con el agentId real
  // y turn.complete del subagente (o resultado) lo cierra.
  on('tool.call', { tool: 'mcp__relevo__delegar' }, async ($, e) => {
    const tarea = arg(e, 'tarea')
    if (!arg(e, 'modelo').trim() || !tarea.trim()) return { deny: 'Faltan modelo o tarea.' }
    const at = await $.clock.now()
    const id = `delegacion-${(e as { tool_use_id?: string }).tool_use_id ?? at}`
    await edit($, list => [
      ...list,
      {
        id,
        parentId: (e as { agentId?: string }).agentId ?? 'main',
        kind: 'delegacion',
        label: firstLine(arg(e, 'descripcion') || tarea) || 'delegación',
        type: 'relevo',
        model: arg(e, 'modelo'),
        status: 'running',
        startedAt: at,
        toolCount: 0,
        ...withTask(tarea),
      },
    ])
    pendingDelegation = id
    let started
    try {
      started = await startDelegation($, arg(e, 'modelo'), tarea, arg(e, 'descripcion'))
    } finally {
      pendingDelegation = undefined
    }
    if ('deny' in started) {
      await edit($, list => list.filter(a => a.id !== id))
      return { deny: started.deny }
    }
    await edit($, list => list.map(a => (a.id === id || a.id === started.agentId ? { ...a, jobHint: started.agentId } : a)))
    return answer(
      `Delegado a ${started.model} con id ${started.agentId}. Corre en segundo plano: ` +
        'recibirás su resultado al terminar, o consúltalo con la herramienta resultado.',
    )
  })

  // En modo automático las reglas «Agent» de permissions.allow no cuentan, y el
  // clasificador no ve qué petición pidió el Agent que lanza delegar: no da
  // veredicto y la delegación falla. La llamada a delegar ya la revisa el
  // clasificador, y las herramientas del subagente se siguen revisando una a
  // una; aquí solo se aprueba el lanzamiento que hace este mod.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const verdict = await next(e)
    const prompt = (e.input as { prompt?: unknown } | null)?.prompt
    const esDeRelevo =
      next.origin.plugin === 'relevo' &&
      typeof prompt === 'string' &&
      prompt.startsWith(CABECERA_SUBAGENTE)
    return verdict.decision === 'ask' && esDeRelevo
      ? { decision: 'allow' as const, reason: 'relevo: subagente pedido con la herramienta delegar' }
      : verdict
  })

  // Subagentes lanzados con la herramienta Agent nativa: se apuntan en el panel.
  // Los de delegar (cabecera de relevo) ya los apunta startDelegation.
  // En primer plano (run_in_background false) la llamada vuelve con status
  // 'completed' y su agentId; en segundo plano, con 'async_launched' y su agentId,
  // y el final llega por turn.complete (BuiltinToolResults.Agent).
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const prompt = typeof e.prompt === 'string' ? e.prompt : ''
    if (prompt.startsWith(CABECERA_SUBAGENTE)) return next(e)
    const tempId = `agent-${await $.clock.now()}-${Math.random().toString(36).slice(2, 6)}`
    const task = (e.description || prompt).slice(0, 80)
    const toolUseId = str((e as { tool_use_id?: unknown }).tool_use_id)
    const nodeId = toolUseId ? `agent-${toolUseId}` : tempId
    const startAt = await $.clock.now()
    await edit($, list => [
      ...list.filter(a => a.id !== nodeId),
      {
        id: nodeId,
        parentId: (e as { agentId?: string }).agentId ?? 'main',
        kind: 'agent',
        label: str(e.name) || firstLine(str(e.description), 60) || str(e.subagentType) || 'subagente',
        type: str(e.subagentType) || 'agente',
        model: e.model ?? '',
        status: 'running',
        startedAt: startAt,
        toolCount: 0,
        ...withTask(prompt),
      },
    ])
    await addRow($, {
      agentId: tempId,
      model: e.model ?? 'heredado',
      task,
      status: 'running',
      startedAt: await $.clock.now(),
      via: 'agent',
    })
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await patchRow($, tempId, { status: 'failed', answer: String(err) })
      await finishNode($, [nodeId], false)
      throw err
    }
    try {
      const res = (ran as { result?: Record<string, unknown> }).result
      const text = (ran as { text?: string }).text
      const failed = 'deny' in ran && ran.deny !== undefined || (ran as { isError?: boolean }).isError === true
      const realId = typeof res?.agentId === 'string' ? res.agentId : undefined
      const resolved = typeof res?.resolvedModel === 'string' ? res.resolvedModel : undefined
      if (failed) {
        await patchRow($, tempId, { status: 'failed', answer: text ?? ('deny' in ran ? ran.deny : undefined) })
        await finishNode($, [nodeId, ...(realId ? [realId] : [])], false)
      } else if (res?.status === 'async_launched' && realId) {
        // Segundo plano: turn.complete lo cerrará con este agentId.
        await patchRow($, tempId, { agentId: realId, ...(resolved ? { model: resolved } : {}) })
        await edit($, list => {
          const claimed = list.some(a => a.id === realId)
          return claimed
            ? list.filter(a => a.id !== nodeId)
            : list.map(a => (a.id === nodeId ? { ...a, id: realId, ...(resolved ? { model: resolved } : {}) } : a))
        })
      } else {
        const informe = realId ? informes.get(realId) : undefined
        if (realId) informes.delete(realId)
        await patchRow($, tempId, {
          status: 'done',
          answer: informe ?? text,
          ...(realId ? { agentId: realId } : {}),
          ...(resolved ? { model: resolved } : {}),
        })
        await finishNode($, [nodeId, ...(realId ? [realId] : [])], true)
      }
    } catch {
      // El panel nunca debe romper la llamada del modelo.
    }
    return ran
  })

  on('tool.call', { tool: 'mcp__relevo__resultado' }, async ($, e) => {
    const id = arg(e, 'id').trim()
    const found = (await read($, delegations)).find(d => d.agentId.startsWith(id))
    if (!found) return { deny: `No hay delegación con id "${id}".` }
    if (found.status !== 'running') {
      const list = (await read($, agents)) ?? []
      const hit = list.find(a => a.status === 'running' && (a.id === found.agentId || a.jobHint === found.agentId))
      if (hit) await finish($, hit.id, found.status === 'done')
    }
    return answer(
      found.status === 'running'
        ? `Sigue en marcha (${found.model}).`
        : `[${found.model} · ${found.status}]\n${found.answer ?? ''}`,
    )
  })

  // Todo subagente que arranque (Agent, delegar, otro mod o un workflow).
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('deny' in started) return started
    if (!e.parentAgentId && e.parentModel) await update($, mainModel, () => e.parentModel)
    const id = started.agentId || e.tool_use_id || `agent-${await $.clock.now()}`
    const at = await $.clock.now()
    const delegation = pendingDelegation
    if (delegation) {
      await edit($, patchAgent(delegation, { id, ...(started.model ? { model: started.model } : {}), type: str(e.subagentType) || 'relevo' }))
      pendingDelegation = undefined
    } else if (e.tool_use_id && (await read($, agents) ?? []).some(a => a.id === `agent-${e.tool_use_id}`)) {
      // Agent nativo: su nodo ya lo creó tool.call; se une por agentId, no se duplica.
      const pre = `agent-${e.tool_use_id}`
      await edit($, list =>
        list.some(a => a.id === id)
          ? list.filter(a => a.id !== pre)
          : list.map(a => (a.id === pre ? { ...a, id, ...(started.model ? { model: started.model } : {}) } : a)),
      )
    } else {
      const node: AgentNode = {
        id,
        parentId: e.parentAgentId ?? 'main',
        kind: 'agent',
        label: str(e.name) || firstLine(str(e.description), 60) || str(e.subagentType) || 'subagente',
        type: e.fork ? 'fork' : str(e.subagentType) || 'agente',
        model: str(started.model) || str(e.model) || str(e.parentModel),
        status: 'running',
        startedAt: at,
        toolCount: 0,
        ...withTask(str(e.prompt)),
      }
      await edit($, list => [...list.filter(a => a.id !== id), node])
    }
    return started
  })

  // Cierre de una delegación: el subagente termina su turno.
  on('turn.complete', async ($, e, next) => {
    // Tokens y cierre del nodo del dibujo.
    const used = e.usage ? usageTokens(e.usage) : 0
    if (e.agentId) {
      const aid = e.agentId
      if (used > 0) await edit($, list => list.map(a => (a.id === aid ? { ...a, tokens: (a.tokens ?? 0) + used } : a)))
      await finish($, aid, e.reason === 'answer')
    } else if (used > 0) {
      const key = e.usage?.model || (await read($, mainModel)) || 'principal'
      await update($, tokensByModel, t => ({ ...(t ?? {}), [key]: ((t ?? {})[key] ?? 0) + used }))
    }
    if (e.agentId) {
      const id = e.agentId
      const mine = (await read($, delegations)).some(d => d.agentId === id && d.status === 'running')
      // Un Agent en primer plano termina su turno antes de que su llamada vuelva:
      // se guarda el informe para que el hook de Agent lo apunte en la fila.
      if (!mine && e.answer) {
        informes.set(id, e.answer)
        if (informes.size > 20) informes.delete(informes.keys().next().value!)
      }
      if (mine) {
        const status: RelevoDelegation['status'] = e.reason === 'answer' ? 'done' : 'failed'
        await update($, delegations, list =>
          list.map(d => (d.agentId === id ? { ...d, status, answer: e.answer } : d)),
        )
        $.ui.toast(`relevo: delegación ${shortId(id)} ${status === 'done' ? 'terminada' : 'fallida'}`)
      }
    }
    return next(e)
  })

  // Aviso cuando otro chat nos escribe.
  on('session.receive', async ($, e, next) => {
    if ('kind' in e.origin && e.origin.kind === 'peer' && !e.agentId) {
      $.ui.toast('relevo: mensaje de otro chat')
    }
    return next(e)
  })

  // ---- empujones: recordatorios cuando el chat principal hace trabajo delegable ----

  // Recordatorio oculto al empezar cada turno del usuario: va como contexto del prompt (el modelo
  // lo lee, la persona no lo ve) y el texto escrito queda intacto. No se añade a mensajes de otros
  // chats, notificaciones ni disparadores (solo a lo que escribe la persona), ni a los de relevo.
  on('prompt.submit', async ($, e, next) => {
    const origin = (e.origin as { kind?: string } | undefined)?.kind
    const delPersona = origin === 'composer' || origin === 'bridge' || origin === 'sdk'
    if (e.isMeta || e.command || !delPersona || !e.text.trim()) return next(e)
    await recupera($)
    return next({ ...e, context: [...(e.context ?? []), recordatorioInicio()] })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      resetTurno()
      await guarda($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String((e as { tool?: unknown }).tool ?? '')
    // Qué hace cada subagente ahora mismo (dibujo).
    const owner = (e as { agentId?: string }).agentId
    if (owner) {
      const name = tool.replace(/^mcp__[^_]+__/, '')
      const detail = toolDetail(name, 'input' in e ? (e as { input?: unknown }).input : undefined)
      const last = detail ? `${name} ${detail}` : name
      await edit($, list => list.map(a => (a.id === owner ? { ...a, lastTool: last, toolCount: (a.toolCount ?? 0) + 1 } : a)))
    }
    if (owner) return next(e)
    if (tool.startsWith('mcp__relevo__') || tool === 'Agent') {
      cuentaLlamada(tool, false)
      await guarda($)
      return next(e)
    }
    // Los avisos no se pueden dar antes de ejecutar (tool.check no admite contexto y un
    // tool.call solo añade contexto a un resultado): se deciden aquí con lo que ya se sabe de la
    // llamada y se adjuntan al resultado. Nunca se deniega.
    const input = e as Record<string, unknown>
    let previas: number | undefined
    if (tool === 'Read' && typeof input.file_path === 'string') {
      previas = await lineasDeLectura($, input).catch(() => undefined)
    }
    const previo = empujon(tool, input, undefined, previas)
    await guarda($)
    const ran = await next(e)
    if ('deny' in ran || (ran as { isError?: boolean }).isError) return ran
    // Lo que solo se sabe tras ejecutar (la salida de una búsqueda, un Read que $.fs no pudo contar).
    const despues = previas === undefined && !previo?.includes('D3') ? avisoSalida(tool, (ran as { text?: string }).text) : undefined
    const texto = [previo, despues].filter(Boolean).join('\n')
    if (!texto) return ran
    return { ...ran, context: [...((ran as { context?: readonly string[] }).context ?? []), texto] }
  }).catch(($, e, next) => next(e))

  // ---- comandos ----

  const splitModel = (args: string) => {
    const [first = '', ...rest] = args.trim().split(/\s+/)
    return { model: first, rest: rest.join(' ') }
  }

  on('command.run', { command: 'relevo' }, async $ => {
    await heartbeat($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Panel de relevo abierto.' }
  })

  on('command.run', { command: 'agentes' }, async $ => {
    await heartbeat($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Panel de relevo abierto.' }
  })

  on('command.run', { command: 'delegar' }, async ($, e) => {
    const { model, rest } = splitModel(e.args)
    if (!model || !rest) return { text: `Uso: /delegar <${MODEL_NAMES.join('|')}> <tarea>` }
    const started = await startDelegation($, model, rest, '')
    return 'deny' in started
      ? { text: started.deny }
      : {
          text: `Delegado a ${started.model} (${shortId(started.agentId)}). Sigue en /relevo.`,
          context: [`El usuario delegó a ${started.model} con id ${started.agentId}: "${rest}". Su resultado se consulta con la herramienta mcp__relevo__resultado.`],
        }
  })

  on('command.run', { command: 'consultar' }, async ($, e) => {
    const { model, rest } = splitModel(e.args)
    if (!model || !rest) return { text: `Uso: /consultar <${MODEL_NAMES.join('|')}> <pregunta>` }
    const id = resolveModel(model)
    const r = await $.model.complete({ model: id, prompt: rest, maxTokens: 16_000, timeoutMs: 300_000 })
    await recordConsulta($, id, rest, r)
    return r.isAnswered
      ? { text: `[${id}]\n${r.text}` }
      : { text: `${id} no respondió (${r.reason}).` }
  })

  // ---- panel único: dibujo de agentes, delegaciones y chats ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const peerList = await read($, peers)
    const delegList = await read($, delegations)
    const list = (await read($, agents)) ?? []
    const byModel = (await read($, tokensByModel)) ?? {}
    const model = (await read($, mainModel)) || (await $.session.model().catch(() => '')) || 'principal'
    const now = await $.clock.now()
    const live = list.filter(a => a.status === 'running').length
    const tokens = tokensLine(list, model, byModel)
    const header = `${live} trabajando · ${list.length - live} terminados`
    const filas = metricasRows(await read($, metricasState))
    const size = sceneSize(list)
    const isRich = e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile'
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any

    const dibujo = isRich ? (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold>{header}</Text>
          {list.length > live && <Button key="limpiar" label="Limpiar terminados" onPress={() => edit($, l => l.filter(a => a.status === 'running'))} />}
        </Box>
        {tokens && <Text dimColor>{tokens}</Text>}
        <Svg width={size.width} height={size.height} source={sceneSvg(list, model, now, byModel)} alt={`Mapa de agentes: ${header}`} isInteractive />
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text bold>👑 Claude ({avatarFor(model).nick}) · {header}</Text>
        {list.length === 0 && <Text dimColor>Sin subagentes todavía.</Text>}
        {list.map(a => {
          const av = avatarFor(a.model)
          const took = duration((a.endedAt ?? now) - a.startedAt)
          const arrow = a.status === 'running' ? '──📄──▶' : a.status === 'done' ? '◀──✓───' : '◀──✗───'
          return (
            <Text dimColor={a.status !== 'running'}>
              {'  '}{a.parentId === 'main' ? '' : '  '}{arrow} {av.emoji} {a.label} <Text color={av.color}>{av.nick}</Text> {took}
              {a.status === 'running' && a.lastTool ? ` ⚙ ${a.lastTool}` : ''}
            </Text>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {dibujo}
        <Box flexDirection="column">
          <Text bold>Delegación de la sesión</Text>
          {filas.map(f => (
            <Text color={f.warn ? AMBAR : undefined} dimColor={!f.warn}>
              {f.warn ? '⚠ ' : ''}{f.text}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Delegaciones</Text>
          {delegList.length === 0 && <Text dimColor>Ninguna todavía. Prueba /delegar haiku …</Text>}
          {delegList
            .slice(-15)
            .reverse()
            .map(d => (
              <Text dimColor={d.status !== 'running'}>
                {d.status === 'running' ? '⏳' : d.status === 'done' ? '✔' : '✖'} {d.via ?? 'delegar'} · {d.model} · {d.task.slice(0, 60)}
              </Text>
            ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Chats conectados</Text>
          {peerList.length === 0 && <Text dimColor>Ningún otro chat con relevo abierto.</Text>}
          {peerList.map(p => (
            <Text>
              {shortId(p.id)} · {p.model} <Text dimColor>{p.cwd}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })

  // ---- franja sobre el cuadro de escribir: dibujo compacto, una fila por tarjeta ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = (await read($, agents)) ?? []
    const main = (await read($, mainModel)) || (await $.session.model().catch(() => '')) || 'principal'
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const rows = bandRows(list, main, now, e.props.bodyColumns ?? 80, e.props.maxRows ?? 8)
    return (
      <Box flexDirection="column">
        {rows.map(r => (
          <Text wrap="truncate-end" dimColor={r.dim}>
            {r.emoji ? `${r.emoji} ` : ''}
            {r.nick ? <Text color={r.color}>{r.nick}</Text> : null}
            {r.nick ? ' ' : ''}
            {r.text}
          </Text>
        ))}
      </Box>
    )
  })
}
