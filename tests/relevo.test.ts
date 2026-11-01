import { expect, mock, test } from 'claude-code/testing'

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

type Fila = { agentId: string; model: string; task: string; status: string; via?: string }
// Estado en memoria bajo el plugin: $.state.get/set del mod leen y escriben aquí.
const montar = (on: any) => {
  mock.clock(on, { now: 1000 })
  const vals: Record<string, unknown> = {}
  const ver: Record<string, number> = {}
  on('state.get', (_$: any, e: any) => ({ value: { value: vals[e.key], version: ver[e.key] ?? 0 } }))
  on('state.set', (_$: any, e: any) => {
    vals[e.key] = e.value
    ver[e.key] = (ver[e.key] ?? 0) + 1
    return { value: { isSet: true as const, version: ver[e.key]! } }
  })
  return () => ((vals.delegations as Fila[] | undefined) ?? [])
}

test('consultar resuelve el alias y devuelve la respuesta del otro modelo', async ($, on) => {
  montar(on)
  let asked = ''
  on('model.complete', (_$, e) => {
    asked = e.model
    return { value: { isAnswered: true as const, text: 'respuesta corta', usage } }
  })

  const r = await $.tool.call({ tool: 'mcp__relevo__consultar', modelo: 'haiku', pregunta: 'hola' })

  expect(asked).toBe('claude-haiku-5-5')
  expect(r.result).toBe('[claude-haiku-5-5]\nrespuesta corta')
})

test('delegar sin tarea se rechaza', async $ => {
  const r = await $.tool.call({ tool: 'mcp__relevo__delegar', modelo: 'sonnet', tarea: '' })
  expect(r.deny).toBe('Faltan modelo o tarea.')
})

test('/delegar sin argumentos explica el uso', async $ => {
  const r = await $.command.run({ command: 'delegar', args: '' })
  expect(r.text).toContain('Uso: /delegar')
})

test('la política de delegación entra en el system prompt solo si están las herramientas', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], outputStyle: null, traits: [] }

  const con = await $.prompt.compose({ ...base, tools: ['mcp__relevo__delegar'] })
  const sin = await $.prompt.compose({ ...base, tools: ['Read'] })

  expect(con.sections.map(s => s.id)).toEqual(['intro', 'relevo:politica'])
  expect(sin.sections.map(s => s.id)).toEqual(['intro'])
})

test('delegar pasa al subagente el alias del modelo, no el id completo', async ($, on) => {
  montar(on)
  let model: string | undefined
  on('agent.spawn', (_$, e) => {
    model = e.model
    return { model: e.model ?? '', agentId: 'agente-1' }
  })
  await $.tool.call({ tool: 'mcp__relevo__delegar', modelo: 'Fable', tarea: 'algo' })
  expect(model).toBe('fable')
})

test('Agent en primer plano: fila running y luego done con su agentId', async ($, on) => {
  const filas = montar(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', agentId: 'ag-fg', resolvedModel: 'claude-haiku-5-5', content: [] },
    text: 'informe',
  }) as any)
  await $.tool.call({ tool: 'Agent', description: 'buscar x', prompt: 'busca', model: 'haiku', run_in_background: false } as any)
  const f = filas()
  expect(f.length).toBe(1)
  expect(f[0]!.agentId).toBe('ag-fg')
  expect(f[0]!.status).toBe('done')
  expect(f[0]!.via).toBe('agent')
  expect(f[0]!.task).toBe('buscar x')
})

test('Agent en segundo plano: queda running con el agentId real para turn.complete', async ($, on) => {
  const filas = montar(on)
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'async_launched', agentId: 'ag-bg', description: 'd', prompt: 'p', outputFile: 'f' },
    text: 'lanzado',
  }) as any)
  await $.tool.call({ tool: 'Agent', description: 'tarea larga', prompt: 'haz' } as any)
  const f = filas()
  expect(f[0]!.agentId).toBe('ag-bg')
  expect(f[0]!.status).toBe('running')
  expect(f[0]!.model).toBe('heredado')
})

test('Agent con cabecera de relevo no se apunta dos veces', async ($, on) => {
  const filas = montar(on)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed', agentId: 'x', content: [] }, text: 'ok' }) as any)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: CABECERA_SUBAGENTE + 'algo' } as any)
  expect(filas().length).toBe(0)
})

test('consultar apunta una fila terminada con via consultar', async ($, on) => {
  const filas = montar(on)
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'ok', usage } }))
  await $.tool.call({ tool: 'mcp__relevo__consultar', modelo: 'opus', pregunta: 'revisa esto' })
  const f = filas()
  expect(f.length).toBe(1)
  expect(f[0]!.via).toBe('consultar')
  expect(f[0]!.status).toBe('done')
  expect(f[0]!.agentId.startsWith('consulta-')).toBe(true)
  expect(f[0]!.model).toBe('claude-opus-5-5')
})

import { CABECERA_SUBAGENTE } from '../hooks/politica'
import { cuentaLlamada, empujon, esExploracion, metricas, recordatorioInicio, resetSesion, resetTurno } from '../hooks/empujon'
import { metricasRows } from '../hooks/scene'

const big = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')
const EXPLORA = 'exploración sin delegar'

test('empujon a: salida larga de Read', () => {
  resetSesion()
  expect(empujon('Read', {}, big(301))).toContain('esto era D3')
  expect(empujon('Read', {}, big(300))).toBeUndefined()
  // contada antes de ejecutar (con $.fs): no hace falta la salida
  expect(empujon('Read', { file_path: 'a.ts' }, undefined, 301)).toContain('esto era D3')
  expect(empujon('Read', { file_path: 'a.ts' }, undefined, 300)).toBeUndefined()
})

test('empujon b: Write de código desde 41 líneas', () => {
  resetSesion()
  expect(empujon('Write', { file_path: 'a.ts', content: big(41) })).toContain('D6')
  expect(empujon('Write', { file_path: 'a.ts', content: big(40) })).toBeUndefined()
  expect(empujon('Write', { file_path: 'a.md', content: big(200) })).toBeUndefined()
  // los campos también llegan dentro de input
  expect(empujon('Write', { input: { file_path: 'a.py', content: big(41) } })).toContain('D6')
})

test('empujon c: exploración, aviso en la 3.ª y luego cada 5 (8, 13)', () => {
  resetSesion()
  const out: (string | undefined)[] = []
  for (let i = 0; i < 13; i++) out.push(empujon(i % 2 ? 'Grep' : 'Glob', {}, 'x'))
  out.forEach((o, i) => {
    if (i === 2) expect(o).toContain(`Llevas 3 llamadas de ${EXPLORA}`)
    else if (i === 7) expect(o).toContain(`Llevas 8 llamadas de ${EXPLORA}`)
    else if (i === 12) expect(o).toContain(`Llevas 13 llamadas de ${EXPLORA}`)
    else expect(o).toBeUndefined()
  })
  expect(out[2]).toContain('haiku (effort low)')
  expect(out[2]).toContain('⟲ Hago yo (E#: motivo)')
})

test('empujon d: llamadas en paralelo no se saltan el umbral ni lo repiten', () => {
  resetSesion()
  // cuatro llamadas seguidas sin ver ninguna respuesta: el aviso salta una sola vez, en la 3.ª
  const out = [1, 2, 3, 4, 5, 6, 7].map(() => empujon('Read', {}, undefined, 10))
  expect(out.filter(Boolean).length).toBe(1)
  expect(out[2]).toContain('Llevas 3 llamadas')
  // la siguiente tanda: 8 y no antes
  expect(empujon('Read', {}, undefined, 10)).toContain('Llevas 8 llamadas')
})

test('empujon e: no avisa si ya hubo delegación en el turno', () => {
  resetSesion()
  cuentaLlamada('Agent', false)
  for (let i = 0; i < 12; i++) expect(empujon('Grep', {}, 'x')).toBeUndefined()
  expect(empujon('Write', { file_path: 'a.ts', content: big(41) })).toContain('D6')
  // un subagente no cuenta como delegación del principal
  resetTurno()
  cuentaLlamada('Agent', true)
  expect(empujon('Grep', {})).toBeUndefined()
  expect(empujon('Grep', {})).toBeUndefined()
  expect(empujon('Grep', {})).toContain('Llevas 3')
})

test('empujon f: qué es exploración', () => {
  for (const t of ['Read', 'Grep', 'Glob']) expect(esExploracion(t, {})).toBe(true)
  for (const c of ['grep -n x a', 'rg foo', 'find . -name a', 'cat a | head', 'ls -la', 'sed -n 1,5p a', 'tail f', 'wc -l a', 'Get-Content a', 'Select-String x a', 'Get-ChildItem .'])
    expect(esExploracion('Bash', { command: c }) && esExploracion('PowerShell', { command: c })).toBe(true)
  expect(esExploracion('Bash', { input: { command: 'cat a' } })).toBe(true)
  for (const c of ['git status', 'npm test', 'echo concat']) expect(esExploracion('Bash', { command: c })).toBe(false)
  expect(esExploracion('Write', { content: 'cat' })).toBe(false)
  expect(esExploracion('Edit', {})).toBe(false)
})

test('empujon g: se acabó el aviso de 10 y 20 llamadas que no son de exploración', () => {
  resetSesion()
  for (let i = 0; i < 25; i++) expect(empujon('Edit', {}, 'x')).toBeUndefined()
})

test('métricas de sesión y turno anterior', () => {
  resetSesion()
  resetTurno()
  for (let i = 0; i < 6; i++) empujon('Grep', {})
  expect(metricas()).toMatchObject({ propias: 6, exploracion: 6, delegaciones: 0, turnosLargos: 1, turnoPropias: 6 })
  resetTurno()
  expect(metricas()).toMatchObject({ propias: 6, turnosLargos: 1, turnoPropias: 0, previoPropias: 6, previoDeleg: 0 })
  expect(recordatorioInicio()).toBe(
    'relevo · Antes de la 1.ª llamada: ¿cabe en ≤2 llamadas con ruta exacta? → hazlo tú. Si no → ↪ Delego a haiku (effort low) la exploración entera, o ⟲ Hago yo (E#: motivo). Turno anterior: 0 llamadas propias / 0 delegaciones.',
  )
  // un turno con delegación no es «largo»
  for (let i = 0; i < 5; i++) empujon('Edit', {})
  cuentaLlamada('Agent', false)
  cuentaLlamada('mcp__relevo__delegar', false)
  expect(metricas()).toMatchObject({ propias: 11, delegaciones: 2, turnosLargos: 1, turnoDeleg: 2 })
  resetTurno()
  expect(metricas()).toMatchObject({ turnosLargos: 1, previoPropias: 5, previoDeleg: 2 })
})

test('panel: tasa de delegación y ámbar', () => {
  const base = { propias: 0, exploracion: 0, delegaciones: 0, turnosLargos: 0, turnoPropias: 0, turnoExploracion: 0, turnoDeleg: 0, previoPropias: 0, previoDeleg: 0 }
  expect(metricasRows(base).some(f => f.warn)).toBe(false)
  expect(metricasRows(base)[2]!.text).toContain('—')
  // 3 / (3 + 1) = 75 %: sin ámbar; 5 / (5 + 1) = 83 %: ámbar
  expect(metricasRows({ ...base, delegaciones: 3, exploracion: 1 })[2]).toEqual({ text: 'Tasa de delegación: 75 %', warn: false })
  expect(metricasRows({ ...base, delegaciones: 5, exploracion: 1 })[2]!.warn).toBe(true)
  // más de 6 en un turno: el actual o el anterior
  expect(metricasRows({ ...base, turnoDeleg: 6 })[4]!.warn).toBe(false)
  expect(metricasRows({ ...base, turnoDeleg: 7 })[4]!.warn).toBe(true)
  expect(metricasRows({ ...base, previoDeleg: 7 })[4]!.warn).toBe(true)
  expect(metricasRows({ ...base, propias: 9, exploracion: 4, delegaciones: 2, turnosLargos: 3 }).map(f => f.text)).toEqual([
    'Llamadas propias: 9 (4 de exploración)',
    'Delegaciones: 2',
    'Tasa de delegación: 33 %',
    'Turnos con ≥5 llamadas propias y 0 delegaciones: 3',
    'Delegaciones por turno: 0 ahora · 0 antes',
  ])
})

test('hook: Write de 41 líneas devuelve su resultado con el aviso adjunto y el panel lo cuenta', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Write' }, () => ({ result: 'ok', text: 'ok' }) as any)
  const r = await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: big(41) } as any)
  expect('deny' in r && r.deny).toBeFalsy()
  expect((r as { context?: string[] }).context?.join('\n')).toContain('D6')
  const ui = await $.ui.mount({
    plugin: 'relevo',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'relevo',
    props: { title: 'Relevo: agentes, delegaciones y chats', isFocused: false, bodyColumns: 80, placement: 'dock' },
  } as any)
  expect(await ui.find({ type: 'Text', text: /Llamadas propias: [1-9]/ })).toBeDefined()
  await ui.unmount()
})

test('hook: el recordatorio de inicio va como contexto del prompt del usuario, sin tocar su texto', async ($, on) => {
  resetSesion()
  montar(on)
  let visto: any
  let comprobados = 0
  on('prompt.submit', (_$, e) => {
    visto = e
    return { text: e.text, context: e.context }
  })
  for (const [kind, ok] of [['composer', true], ['peer', false], ['task-notification', false]] as const) {
    visto = undefined
    await $.prompt.submit({ text: 'haz algo', origin: { kind } } as any).catch(() => undefined)
    if (visto?.origin?.kind === kind) {
      expect(visto.text).toBe('haz algo')
      expect(!!visto.context?.some((c: string) => c.startsWith('relevo · Antes de la 1.ª llamada'))).toBe(ok)
      comprobados++
    }
  }
  expect(comprobados).toBeGreaterThan(0)
})
