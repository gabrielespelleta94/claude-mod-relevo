export type RelevoPeer = {
  id: string
  model: string
  cwd: string
  lastSeen: number
}

export type RelevoDelegation = {
  agentId: string
  model: string
  task: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  answer?: string
  via?: 'delegar' | 'agent' | 'consultar'
}

export type AgentKind = 'agent' | 'delegacion' | 'consulta'
export type AgentStatus = 'running' | 'done' | 'error'

export type AgentNode = {
  id: string
  parentId: string
  kind: AgentKind
  label: string
  type: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  lastTool?: string
  toolCount: number
  jobHint?: string
  /** el encargo que recibió el agente, recortado */
  task?: string
  /** tokens de entrada, salida y caché de los turnos de este agente */
  tokens?: number
}

/** Métricas de delegación del chat principal: las llevan los contadores de hooks/empujon.ts. */
export type RelevoMetricas = {
  /** llamadas propias del chat principal en la sesión (todas las que no son delegaciones) */
  propias: number
  /** de ellas, las de exploración (Read, Grep, Glob, shell de lectura) */
  exploracion: number
  delegaciones: number
  /** turnos con >=5 llamadas propias y 0 delegaciones (el en curso cuenta si ya cumple) */
  turnosLargos: number
  /** turno en curso */
  turnoPropias: number
  turnoExploracion: number
  turnoDeleg: number
  /** turno anterior */
  previoPropias: number
  previoDeleg: number
}

declare module 'claude-code' {
  interface PluginState {
    relevo: {
      peers: RelevoPeer[]
      delegations: RelevoDelegation[]
      agents: AgentNode[]
      mainModel: string
      tokensByModel: Record<string, number>
      /** con etiqueta de forma: un valor guardado por una versión anterior se lee como ausente */
      metricas: Shaped<RelevoMetricas>
    }
  }
}
