// Recordatorios al chat principal cuando hace él mismo trabajo delegable. Lógica pura.
// Contadores del turno (se reinician en turn.start) y de la sesión (solo crecen).
import type { RelevoMetricas } from '../types'

export type Metricas = RelevoMetricas

const CODIGO = /\.(ts|tsx|js|py|sql|cs|html|css|json|m|dax)$/i
const SHELL = new Set(['Bash', 'PowerShell'])
const LEIDAS = new Set(['Read', 'Bash', 'Grep', 'PowerShell'])
const EXPLORA_SIEMPRE = new Set(['Read', 'Grep', 'Glob'])
const EXPLORA_CMD = /\b(grep|rg|find|cat|ls|sed|head|tail|wc)\b|Get-Content|Select-String|Get-ChildItem/i

export const UMBRAL_EXPLORA = 3
export const PASO_EXPLORA = 5
export const UMBRAL_WRITE = 40
export const UMBRAL_LECTURA = 300
export const LARGO_PROPIAS = 5

let sesion = { propias: 0, exploracion: 0, delegaciones: 0, turnosLargos: 0 }
let turno = { propias: 0, exploracion: 0, deleg: 0 }
let previo = { propias: 0, deleg: 0 }
// Llamada de exploración del turno en la que saltó el último recordatorio (0: ninguno).
let ultimoAviso = 0

const esLargo = (propias: number, deleg: number) => propias >= LARGO_PROPIAS && deleg === 0

// Cierra el turno que acaba y deja a cero el nuevo; guarda las cifras del anterior.
export const resetTurno = () => {
  if (esLargo(turno.propias, turno.deleg)) sesion.turnosLargos++
  previo = { propias: turno.propias, deleg: turno.deleg }
  turno = { propias: 0, exploracion: 0, deleg: 0 }
  ultimoAviso = 0
}

// Vuelve a cero todo (tests).
export const resetSesion = () => {
  sesion = { propias: 0, exploracion: 0, delegaciones: 0, turnosLargos: 0 }
  turno = { propias: 0, exploracion: 0, deleg: 0 }
  previo = { propias: 0, deleg: 0 }
  ultimoAviso = 0
}

export const estado = () => ({ llamadas: turno.propias, delegaciones: turno.deleg, exploracion: turno.exploracion })

export const metricas = (): Metricas => ({
  propias: sesion.propias,
  exploracion: sesion.exploracion,
  delegaciones: sesion.delegaciones,
  // el turno en curso cuenta ya si cumple, para que el panel no vaya un turno por detrás
  turnosLargos: sesion.turnosLargos + (esLargo(turno.propias, turno.deleg) ? 1 : 0),
  turnoPropias: turno.propias,
  turnoExploracion: turno.exploracion,
  turnoDeleg: turno.deleg,
  previoPropias: previo.propias,
  previoDeleg: previo.deleg,
})

// Recupera los contadores tras recargar el mod (los guarda $.state). Solo si aún están a cero.
export const restaura = (m: Partial<Metricas> | undefined) => {
  if (!m || sesion.propias + sesion.delegaciones + turno.propias + turno.deleg > 0) return
  sesion = {
    propias: m.propias ?? 0,
    exploracion: m.exploracion ?? 0,
    delegaciones: m.delegaciones ?? 0,
    // metricas() suma el turno en curso; aquí va solo lo cerrado
    turnosLargos: Math.max(0, (m.turnosLargos ?? 0) - (esLargo(m.turnoPropias ?? 0, m.turnoDeleg ?? 0) ? 1 : 0)),
  }
  turno = { propias: m.turnoPropias ?? 0, exploracion: m.turnoExploracion ?? 0, deleg: m.turnoDeleg ?? 0 }
  previo = { propias: m.previoPropias ?? 0, deleg: m.previoDeleg ?? 0 }
}

const lineas = (s: string) => (s ? s.split('\n').length : 0)

const comando = (input: Record<string, unknown>) => {
  const direct = input.command
  if (typeof direct === 'string') return direct
  const nested = (input.input as { command?: unknown } | null | undefined)?.command
  return typeof nested === 'string' ? nested : ''
}

// Llamada de exploración: leer o buscar, no cambiar nada.
export function esExploracion(tool: string, input: Record<string, unknown> = {}): boolean {
  if (EXPLORA_SIEMPRE.has(tool)) return true
  return SHELL.has(tool) && EXPLORA_CMD.test(comando(input))
}

// Cuenta una delegación del chat principal; las llamadas propias se cuentan en empujon().
export function cuentaLlamada(tool: string, deSubagente: boolean) {
  if (deSubagente) return
  if (tool === 'Agent' || tool === 'mcp__relevo__delegar' || tool === 'mcp__relevo__consultar') {
    turno.deleg++
    sesion.delegaciones++
  }
}

const avisoLectura = (n: number) =>
  `[relevo] Esta salida tiene ${n} líneas. Si solo necesitabas la conclusión, esto era D3: delega a haiku (Agent con model: haiku) salvo excepción E1-E6.`

// Aviso por una salida larga, para cuando el tamaño solo se conoce tras ejecutar.
export function avisoSalida(tool: string, text: string | undefined): string | undefined {
  if (!LEIDAS.has(tool) || typeof text !== 'string') return undefined
  const n = lineas(text)
  return n > UMBRAL_LECTURA ? avisoLectura(n) : undefined
}

// Registra una llamada propia del chat principal y devuelve como mucho un recordatorio (dos
// juntos si coinciden una lectura larga y la exploración). Se llama ANTES de ejecutar la
// herramienta: con `lineasPrevias` (las que va a devolver un Read, contadas con $.fs) y sin
// `text`. `text` sirve cuando la salida ya existe.
export function empujon(
  tool: string,
  input: Record<string, unknown>,
  text?: string,
  lineasPrevias?: number,
): string | undefined {
  turno.propias++
  sesion.propias++
  const avisos: string[] = []

  const nLeidas = lineasPrevias ?? (LEIDAS.has(tool) && typeof text === 'string' ? lineas(text) : 0)
  if (nLeidas > UMBRAL_LECTURA) avisos.push(avisoLectura(nLeidas))

  if (tool === 'Write') {
    const nested = (input.input ?? {}) as Record<string, unknown>
    const content = input.content ?? nested.content
    const path = input.file_path ?? nested.file_path
    if (typeof content === 'string' && typeof path === 'string' && CODIGO.test(path)) {
      const n = lineas(content)
      if (n > UMBRAL_WRITE) {
        avisos.push(
          `[relevo] Has escrito ${n} líneas de código en el chat principal: con el diseño claro esto era D6, delega la implementación a sonnet (Agent con model: sonnet).`,
        )
      }
    }
  }

  if (esExploracion(tool, input)) {
    turno.exploracion++
    sesion.exploracion++
    const siguiente = ultimoAviso === 0 ? UMBRAL_EXPLORA : ultimoAviso + PASO_EXPLORA
    // >= y no ===: las llamadas en paralelo no se saltan el umbral; ultimoAviso evita repetirlo.
    if (turno.deleg === 0 && turno.exploracion >= siguiente) {
      ultimoAviso = turno.exploracion
      avisos.push(
        `[relevo] Llevas ${turno.exploracion} llamadas de exploración sin delegar. La siguiente debería ser un único encargo a haiku (effort low) con toda la exploración que queda (D1/D12), o escribe ⟲ Hago yo (E#: motivo).`,
      )
    }
  }

  return avisos.length ? avisos.join('\n') : undefined
}

// Recordatorio que ve el modelo al empezar cada turno. Se compone al enviar el prompt, antes de
// que turn.start reinicie los contadores: los del turno en curso son aún los del anterior.
export function recordatorioInicio(): string {
  return `relevo · Antes de la 1.ª llamada: ¿cabe en ≤2 llamadas con ruta exacta? → hazlo tú. Si no → ↪ Delego a haiku (effort low) la exploración entera, o ⟲ Hago yo (E#: motivo). Turno anterior: ${turno.propias} llamadas propias / ${turno.deleg} delegaciones.`
}
