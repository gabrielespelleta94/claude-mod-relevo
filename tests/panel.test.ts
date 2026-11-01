import { expect, mock, test } from 'claude-code/testing'

import { bandRows, cells, fmtTokens, sceneSvg, taskOf, toolDetail, tokensLine, usageTokens } from '../hooks/scene'

const PANE = {
  component: 'Pane',
  requestId: 'relevo',
  props: { title: 'Relevo: agentes, delegaciones y chats', isFocused: false, bodyColumns: 80, placement: 'dock' },
} as any

test('una consulta a relevo aparece con su avatar y termina en verde', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'mcp__relevo__consultar' }, async () => {
    await clock.advance(4000)
    return { result: 'ok' }
  })

  await $.tool.call({
    tool: 'mcp__relevo__consultar',
    input: { modelo: 'opus', pregunta: 'Revisa esta arquitectura' },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'relevo', surface, ...PANE })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /Revisa esta arquitectura/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /0 trabajando · 1 terminados/ })).toBeDefined()
    await ui.unmount()
  }

  const desk = await $.ui.mount({ plugin: 'relevo', surface: 'desktop', ...PANE })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.press({ key: 'limpiar' })
  expect(await desk.find({ type: 'Text', text: /0 trabajando · 0 terminados/ })).toBeDefined()
  await desk.unmount()
})

test('un subagente lanzado aparece trabajando con el avatar de su modelo', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'ok' }))

  await $.agent.spawn({ prompt: 'busca', description: 'Buscar endpoints', subagentType: 'Explore' } as any)

  const ui = await $.ui.mount({ plugin: 'relevo', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 trabajando/ })).toBeDefined()
  await ui.unmount()
})

test('un spawn nativo sin modelo resuelto (background) aparece "1 trabajando" en desktop y terminal', async ($, on) => {
  mock.clock(on)
  // The engine may leave model/agentId undefined: the node must never carry undefined fields.
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5' }))

  await $.agent.spawn({ prompt: 'Eres un subagente.\nOBJETIVO: revisar el panel y arreglar el fallo. CONTEXTO: mod', description: 'Revisar panel', subagentType: 'general-purpose', model: 'sonnet' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'relevo', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /1 trabajando/ })).toBeDefined()
    await ui.unmount()
  }
})

test('taskOf y toolDetail resumen el encargo y la herramienta', () => {
  expect(taskOf('Eres un subagente de X.\nOBJETIVO: hacer cosas. CONTEXTO: más')).toBe('hacer cosas.')
  expect(toolDetail('Read', { file_path: 'C:\\a\\b\\register.tsx' })).toBe('register.tsx')
  expect(toolDetail('Grep', { pattern: 'foo' })).toBe('foo')
})

test('los tokens se suman y se formatean con k/M', () => {
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(12_345)).toBe('12,3k')
  expect(fmtTokens(812_000)).toBe('812k')
  expect(fmtTokens(1_250_000)).toBe('1,3M')
  expect(usageTokens({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 })).toBe(10)
  const sub = { id: 'a', parentId: 'main', kind: 'agent', label: 'x', type: 'Explore', model: 'claude-haiku-5-5', status: 'done', startedAt: 0, toolCount: 0, tokens: 45_000 } as const
  expect(tokensLine([sub], 'claude-opus-5', { 'claude-opus-5': 812_000 })).toBe('Tokens (incl. caché): Opus (principal) 812k · Haiku 45k')
})

const BAND = {
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, bodyColumns: 80 },
} as any

test('la franja se dibuja con 0 subagentes: avatar del principal y «sin subagentes»', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ plugin: 'relevo', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /sin subagentes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /en marcha/ })).toBeUndefined()
  await ui.unmount()
})

test('Agent nativo en primer plano crea su nodo y lo cierra al volver', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed', agentId: 'n1' }, text: 'hecho' }) as any)
  await $.tool.call({ tool: 'Agent', input: { prompt: 'busca cosas', description: 'Buscar cosas', subagent_type: 'Explore', model: 'haiku' } } as any)
  const ui = await $.ui.mount({ plugin: 'relevo', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /0 trabajando · 1 terminados/ })).toBeDefined()
  await ui.unmount()
})

test('Agent nativo en segundo plano queda en marcha con su agentId y turn.complete lo cierra', async ($, on) => {
  mock.clock(on)
  on('turn.complete', () => ({ text: '' }) as any)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'bg1' } }) as any)
  await $.tool.call({ tool: 'Agent', input: { prompt: 'busca cosas', description: 'Buscar cosas', model: 'haiku' } } as any)
  const ui = await $.ui.mount({ plugin: 'relevo', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /1 trabajando/ })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ agentId: 'bg1', reason: 'answer', answer: 'ok' } as any)
  const ui2 = await $.ui.mount({ plugin: 'relevo', surface: 'terminal', ...PANE })
  expect(await ui2.find({ type: 'Text', text: /0 trabajando · 1 terminados/ })).toBeDefined()
  await ui2.unmount()
})

test('la franja muestra el avatar y el recuento con un agente en marcha', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'b1' }))
  await $.agent.spawn({ prompt: 'busca', description: 'Buscar endpoints', subagentType: 'Explore' } as any)
  const ui = await $.ui.mount({ plugin: 'relevo', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Haiku/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 en marcha/ })).toBeDefined()
  await ui.unmount()
})

test('franja con 5 subagentes: máx. 3 tarjetas, «+2» y alto <= 8 filas', async ($, on) => {
  mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `s${++n}` }))
  for (let i = 0; i < 5; i++) {
    await $.agent.spawn({ prompt: 'x', description: `Tarea numero ${i} con un nombre bastante largo para recortar`, subagentType: 'general-purpose' } as any)
  }
  const ui = await $.ui.mount({ plugin: 'relevo', surface: 'desktop', ...BAND, props: { ...BAND.props, maxRows: 8 } })
  expect(await ui.find({ type: 'Text', text: /\+2 más/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 en marcha/ })).toBeDefined()
  await ui.unmount()
})

test('bandRows: 0, 1 y 5 subagentes caben en 8 filas y nada pasa del ancho', () => {
  const mk = (i: number, status: 'running' | 'done' = 'running') =>
    ({ id: `a${i}`, parentId: 'main', kind: 'agent', label: 'Un encargo larguísimo que no cabe en la fila de la franja', type: 'general-purpose', model: 'claude-sonnet-5-5', status, startedAt: 0, endedAt: status === 'done' ? 1000 : undefined, toolCount: 3, lastTool: 'Read un-fichero-muy-largo.tsx' }) as any
  const r0 = bandRows([], 'claude-opus-5-5', 5000, 60, 8)
  expect(r0.length).toBe(1)
  expect(r0[0]!.text).toMatch(/sin subagentes/)
  const r1 = bandRows([mk(1)], 'claude-opus-5-5', 5000, 60, 8)
  expect(r1.length).toBe(2)
  const r5 = bandRows([1, 2, 3, 4, 5].map(i => mk(i)), 'claude-opus-5-5', 5000, 60, 8)
  expect(r5.length).toBeLessThanOrEqual(8)
  expect(r5[r5.length - 1]!.text).toMatch(/\+2/)
  for (const r of r5) expect(cells(`${r.emoji ? r.emoji + ' ' : ''}${r.nick ? r.nick + ' ' : ''}${r.text}`)).toBeLessThanOrEqual(60)
  // con poco sitio (maxRows 3) sigue sin pasarse
  expect(bandRows([1, 2, 3, 4, 5].map(i => mk(i)), 'claude-opus-5-5', 5000, 60, 3).length).toBeLessThanOrEqual(3)
})

test('la tarjeta grande no solapa filas: cada línea de texto tiene su propia línea base', () => {
  const ag = { id: 'a', parentId: 'main', kind: 'agent', label: 'Arreglar el mod', type: 'general-purpose', model: 'claude-sonnet-5-5', status: 'running', startedAt: 0, toolCount: 1, task: 'arreglar el mod relevo para que el dibujo de agentes se vea encima de la barra de escribir sin cortarse ni montarse el texto de la tarjeta' } as any
  const svg = sceneSvg([ag], 'claude-opus-5-5', 19000)
  const ys = [...svg.matchAll(/<text x="\d+" y="(\d+)"[^>]*font-size="(1[0-9.]+)"/g)].map(m => +m[1]!).filter(y => y > 64 + 14)
  const sorted = [...ys].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(15)
  // la última línea (estado) queda dentro de la tarjeta
  const h = +svg.match(/<rect x="\d+" y="78" width="\d+" height="(\d+)"/)![1]!
  expect(sorted[sorted.length - 1]!).toBeLessThan(78 + h)
})
