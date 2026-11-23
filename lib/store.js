/**
 * Durable lesson and knowledge-graph store for the LearnHarness DSH plugin.
 *
 * One profile, one JSON file under `$DSH_HOME/learnharness/learn.json`, so the
 * data is inspectable, portable, and survives removing and reinstalling the
 * bundle. Lessons are keyed by DSH Session id; the graph is shared by every
 * lesson in the profile.
 *
 * This module is deliberately plain Node: no Cordis, no DSH imports, so the
 * store can be tested directly with `node --test`.
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATE_VERSION = 1
export const STATUSES = ['unseen', 'probing', 'held', 'teaching', 'verified', 'blocked']
export const EVIDENCE_KINDS = ['probe', 'check', 'practice']
export const OUTCOMES = ['held', 'partial', 'gap', 'confusion']
export const DONE_STATUSES = new Set(['held', 'verified'])

const MAX_NODES = 24
const MAX_TITLE = 180
const MAX_GOAL = 400
const MAX_NOTE = 2_000
const MAX_TEXT = 500
const MAX_EVIDENCE = 30
const MAX_COMMIT_PROPOSITIONS = 40
const MAX_COMMIT_CHAINS = 60
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A caller-facing validation failure (400 at the route, tool error in a turn). */
export class LearnError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LearnError'
  }
}

/** @returns {string} the current instant. */
function nowIso() {
  return new Date().toISOString()
}

/** @returns {string} a fresh proposition/chain id. */
function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/**
 * Resolve the durable root. Overridable for tests and for keeping a profile
 * elsewhere; otherwise it sits beside the other DSH data, not in a workspace.
 * @returns {string} absolute directory.
 */
export function resolveRoot() {
  if (process.env.DSH_LEARNHARNESS_DIR) return process.env.DSH_LEARNHARNESS_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'learnharness')
}

/** @returns {object} an empty store. */
function emptyState() {
  const at = nowIso()
  return {
    version: STATE_VERSION,
    createdAt: at,
    updatedAt: at,
    lessons: {},
    graph: { propositions: [], chains: [] },
  }
}

/** @param {unknown} raw candidate. @param {string} label field name. @param {number} max max length. @returns {string} trimmed text. */
function text(raw, label, max = MAX_TEXT) {
  if (typeof raw !== 'string') throw new LearnError(`${label} must be a string`)
  const value = raw.trim()
  if (value === '') throw new LearnError(`${label} must not be empty`)
  if (value.length > max) throw new LearnError(`${label} must be at most ${max} characters`)
  return value
}

/** @param {unknown} raw candidate. @returns {string} a validated node id. */
function nodeId(raw) {
  if (typeof raw !== 'string' || !SLUG.test(raw)) {
    throw new LearnError('node ids must be lowercase letters, digits, and hyphens (max 40), starting with a letter or digit')
  }
  return raw
}

/**
 * Validate a plan: unique ids, known deps, no self-reference, acyclic, bounded.
 * @param {unknown} raw model-supplied nodes.
 * @returns {{id: string, title: string, deps: string[]}[]} normalized nodes.
 */
export function validatePlan(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new LearnError('nodes must be a non-empty array')
  if (raw.length > MAX_NODES) throw new LearnError(`a plan may have at most ${MAX_NODES} nodes`)
  const nodes = []
  const ids = new Set()
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null) throw new LearnError(`nodes[${i}] must be an object`)
    const id = nodeId(item.id)
    if (ids.has(id)) throw new LearnError(`duplicate node id "${id}"`)
    ids.add(id)
    const title = text(item.title, `nodes[${i}].title`, MAX_TITLE)
    const deps = item.deps === undefined ? [] : item.deps
    if (!Array.isArray(deps)) throw new LearnError(`nodes[${i}].deps must be an array`)
    if (deps.length > 12) throw new LearnError(`nodes[${i}].deps may list at most 12 nodes`)
    const seen = new Set()
    for (const dep of deps) {
      if (typeof dep !== 'string') throw new LearnError(`nodes[${i}].deps must contain strings`)
      if (dep === id) throw new LearnError(`node "${id}" cannot depend on itself`)
      if (seen.has(dep)) throw new LearnError(`node "${id}" lists "${dep}" twice`)
      seen.add(dep)
    }
    nodes.push({ id, title, deps: [...seen] })
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep)) throw new LearnError(`node "${node.id}" depends on unknown node "${dep}"`)
    }
  }
  // Kahn's algorithm: a cycle would leave nodes unprocessed.
  const indegree = new Map(nodes.map(node => [node.id, node.deps.length]))
  const dependents = new Map(nodes.map(node => [node.id, []]))
  for (const node of nodes) for (const dep of node.deps) dependents.get(dep).push(node.id)
  const queue = nodes.filter(node => node.deps.length === 0).map(node => node.id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()
    visited++
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  if (visited !== nodes.length) throw new LearnError('the plan must be acyclic')
  return nodes
}

/**
 * Dependency depth of every node, used for plan layout and for picking the
 * next node. Assumes the plan is acyclic.
 * @param {{id: string, deps: string[]}[]} nodes normalized plan.
 * @returns {Map<string, number>} id to zero-based depth.
 */
export function planLevels(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const levels = new Map()
  const visit = (id, trail) => {
    if (levels.has(id)) return levels.get(id)
    if (trail.has(id)) return 0
    trail.add(id)
    const node = byId.get(id)
    const level = node.deps.length === 0
      ? 0
      : Math.max(...node.deps.map(dep => visit(dep, trail))) + 1
    trail.delete(id)
    levels.set(id, level)
    return level
  }
  for (const node of nodes) visit(node.id, new Set())
  return levels
}

/** @param {object} lesson lesson record. @returns {boolean} whether every node is done. */
function allDone(lesson) {
  return lesson.nodes.length > 0 && lesson.nodes.every(node => DONE_STATUSES.has(node.status))
}

/** @param {object} lesson lesson record. @param {string} fromId node to look after. @returns {string | null} next node id. */
function nextAfter(lesson, fromId) {
  const done = new Set(lesson.nodes.filter(node => DONE_STATUSES.has(node.status)).map(node => node.id))
  const index = lesson.nodes.findIndex(node => node.id === fromId)
  const ordered = [...lesson.nodes.slice(index + 1), ...lesson.nodes.slice(0, Math.max(0, index + 1))]
  const candidate = ordered.find(node => !done.has(node.id)
    && node.deps.every(dep => done.has(dep)))
  if (candidate !== undefined) return candidate.id
  return lesson.nodes.find(node => !done.has(node.id))?.id ?? null
}

/** @param {string} raw normalized. @returns {string} collapsed, lowercased text. */
function normalizeText(raw) {
  return raw.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** @param {unknown} raw candidate stored state. @returns {object} a usable state, preserving what validates. */
function normalizeState(raw) {
  if (typeof raw !== 'object' || raw === null || raw.version !== STATE_VERSION) {
    throw new LearnError(`unsupported store version`)
  }
  const state = emptyState()
  state.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : state.createdAt
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt
  if (raw.lessons && typeof raw.lessons === 'object') {
    for (const [sessionId, lesson] of Object.entries(raw.lessons)) {
      if (typeof sessionId !== 'string' || typeof lesson !== 'object' || lesson === null) continue
      const nodes = Array.isArray(lesson.nodes) ? lesson.nodes.filter(node =>
        typeof node?.id === 'string' && typeof node?.title === 'string' && Array.isArray(node?.deps)) : []
      const ids = new Set(nodes.map(node => node.id))
      state.lessons[sessionId] = {
        sessionId,
        goal: typeof lesson.goal === 'string' ? lesson.goal : '',
        createdAt: typeof lesson.createdAt === 'string' ? lesson.createdAt : state.createdAt,
        updatedAt: typeof lesson.updatedAt === 'string' ? lesson.updatedAt : state.updatedAt,
        status: lesson.status === 'complete' ? 'complete' : 'active',
        currentNodeId: typeof lesson.currentNodeId === 'string' ? lesson.currentNodeId : null,
        nodes: nodes.map(node => ({
          id: node.id,
          title: node.title,
          deps: node.deps.filter(dep => typeof dep === 'string' && ids.has(dep)),
          status: STATUSES.includes(node.status) ? node.status : 'unseen',
          evidence: Array.isArray(node.evidence) ? node.evidence.slice(-MAX_EVIDENCE) : [],
        })),
      }
    }
  }
  if (raw.graph && typeof raw.graph === 'object') {
    const propositions = Array.isArray(raw.graph.propositions) ? raw.graph.propositions : []
    for (const proposition of propositions) {
      if (typeof proposition?.id !== 'string' || typeof proposition?.text !== 'string') continue
      state.graph.propositions.push({
        id: proposition.id,
        text: proposition.text,
        lessonId: proposition.lessonId ?? null,
        sessionId: proposition.sessionId ?? null,
        createdAt: proposition.createdAt ?? state.createdAt,
      })
    }
    const ids = new Set(state.graph.propositions.map(proposition => proposition.id))
    const chains = Array.isArray(raw.graph.chains) ? raw.graph.chains : []
    for (const chain of chains) {
      if (typeof chain?.id !== 'string' || typeof chain?.conclusionId !== 'string') continue
      if (!ids.has(chain.conclusionId) || !Array.isArray(chain.premiseIds)) continue
      const premiseIds = chain.premiseIds.filter(id => typeof id === 'string' && ids.has(id))
      if (premiseIds.length === 0) continue
      state.graph.chains.push({
        id: chain.id,
        premiseIds,
        conclusionId: chain.conclusionId,
        lessonId: chain.lessonId ?? null,
        sessionId: chain.sessionId ?? null,
        createdAt: chain.createdAt ?? state.createdAt,
      })
    }
  }
  return state
}

/** One durable lesson/graph store. */
export class LearnStore {
  /** @param {string} root directory holding learn.json. */
  constructor(root) {
    this.dir = root
    this.file = join(root, 'learn.json')
    this.state = emptyState()
    this.ready = this.#load()
    this.tail = Promise.resolve()
  }

  async #load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      this.state = normalizeState(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of overwriting it.
        try {
          await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch {}
        this.state = emptyState()
      }
    }
  }

  async #persist() {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }

  /**
   * Serialize one synchronous mutation, then persist it before resolving.
   * @template T
   * @param {() => T} mutate mutation over `this.state`.
   * @returns {Promise<T>} the mutation result after the write.
   */
  #commit(mutate) {
    const run = async () => {
      await this.ready
      const result = mutate()
      this.state.updatedAt = nowIso()
      await this.#persist()
      return result
    }
    this.tail = this.tail.then(run, run)
    return this.tail
  }

  /**
   * Create the lesson when absent, or return the existing one.
   * @param {string} sessionId owning session.
   * @param {string} goal lesson goal.
   * @returns {Promise<object>} the lesson.
   */
  async ensureLesson(sessionId, goal) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new LearnError('a session is required')
    return this.#commit(() => {
      const existing = this.state.lessons[sessionId]
      if (existing) return existing
      const at = nowIso()
      const lesson = {
        sessionId,
        goal: text(goal, 'goal', MAX_GOAL),
        createdAt: at,
        updatedAt: at,
        status: 'active',
        currentNodeId: null,
        nodes: [],
      }
      this.state.lessons[sessionId] = lesson
      return lesson
    })
  }

  /**
   * Read one lesson.
   * @param {string} sessionId owning session.
   * @returns {Promise<object | null>} the lesson or null.
   */
  async lesson(sessionId) {
    await this.ready
    return this.state.lessons[sessionId] ?? null
  }

  /**
   * Create or replace the lesson plan. Nodes that keep their id keep their
   * status and evidence, so a revised route does not erase what was verified.
   * @param {string} sessionId owning session.
   * @param {{goal?: string, nodes: unknown}} input plan input.
   * @returns {Promise<object>} the updated lesson.
   */
  async setPlan(sessionId, input) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new LearnError('a session is required')
    const nodes = validatePlan(input?.nodes)
    const goal = typeof input?.goal === 'string' && input.goal.trim() !== ''
      ? text(input.goal, 'goal', MAX_GOAL)
      : ''
    return this.#commit(() => {
      const existing = this.state.lessons[sessionId]
      if (!existing && goal === '') throw new LearnError('goal is required when starting a lesson')
      const previous = new Map((existing?.nodes ?? []).map(node => [node.id, node]))
      const lesson = existing ?? {
        sessionId,
        goal,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status: 'active',
        currentNodeId: null,
        nodes: [],
      }
      if (goal !== '') lesson.goal = goal
      lesson.nodes = nodes.map(node => {
        const old = previous.get(node.id)
        return {
          ...node,
          status: old?.status ?? 'unseen',
          evidence: old?.evidence ?? [],
        }
      })
      lesson.updatedAt = nowIso()
      const done = new Set(lesson.nodes.filter(node => DONE_STATUSES.has(node.status)).map(node => node.id))
      const current = lesson.nodes.find(node => node.id === lesson.currentNodeId)
      lesson.currentNodeId = current && !done.has(current.id)
        ? current.id
        : lesson.nodes.find(node => !done.has(node.id) && node.deps.every(dep => done.has(dep)))?.id
          ?? lesson.nodes.find(node => !done.has(node.id))?.id
          ?? null
      lesson.status = allDone(lesson) ? 'complete' : 'active'
      this.state.lessons[sessionId] = lesson
      return lesson
    })
  }

  /**
   * Append one probe/check/practice observation and derive the node status.
   * @param {string} sessionId owning session.
   * @param {object} input checkpoint input.
   * @returns {Promise<{lesson: object, node: object, next: string | null}>} updated state.
   */
  async checkpoint(sessionId, input) {
    const kind = input?.kind
    const outcome = input?.outcome
    if (!EVIDENCE_KINDS.includes(kind)) throw new LearnError(`kind must be one of ${EVIDENCE_KINDS.join(', ')}`)
    if (!OUTCOMES.includes(outcome)) throw new LearnError(`outcome must be one of ${OUTCOMES.join(', ')}`)
    if (input?.nodeId === undefined) throw new LearnError('nodeId is required')
    const id = nodeId(input.nodeId)
    if (input?.note !== undefined && typeof input.note !== 'string') throw new LearnError('note must be a string')
    const note = typeof input?.note === 'string' ? input.note.trim().slice(0, MAX_NOTE) : ''
    const confidence = input?.confidence === undefined ? null : input.confidence
    if (confidence !== null && (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)) {
      throw new LearnError('confidence must be an integer from 0 to 100')
    }
    return this.#commit(() => {
      const lesson = this.state.lessons[sessionId]
      if (!lesson) throw new LearnError('this session has no lesson; call learn_plan first')
      const node = lesson.nodes.find(item => item.id === id)
      if (!node) throw new LearnError(`unknown node "${id}"`)
      node.evidence.push({ kind, outcome, confidence, note, at: nowIso() })
      if (node.evidence.length > MAX_EVIDENCE) node.evidence.splice(0, node.evidence.length - MAX_EVIDENCE)
      if (outcome === 'held') node.status = kind === 'probe' ? 'held' : 'verified'
      else node.status = 'teaching'
      lesson.updatedAt = nowIso()
      // Only the node the lesson is on can move the pointer. A done current
      // node advances; a failed check keeps it current for repair. Probing a
      // later node does not hijack an in-progress step.
      if (DONE_STATUSES.has(node.status)) {
        if (lesson.currentNodeId === null || lesson.currentNodeId === node.id) {
          lesson.currentNodeId = nextAfter(lesson, node.id)
        }
      } else if (lesson.currentNodeId === null) {
        lesson.currentNodeId = node.id
      }
      lesson.status = allDone(lesson) ? 'complete' : 'active'
      return { lesson, node, next: lesson.currentNodeId }
    })
  }

  /**
   * Search the graph for propositions matching a text query or ids, and the
   * chains touching the result.
   * @param {{query?: string, ids?: string[], limit?: number}} input query.
   * @returns {Promise<{propositions: object[], chains: object[], total: object}>} bounded result.
   */
  async graphQuery(input = {}) {
    await this.ready
    const limit = input.limit === undefined ? 12 : input.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new LearnError('limit must be an integer from 1 to 40')
    const ids = Array.isArray(input.ids) ? input.ids.filter(id => typeof id === 'string') : []
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    if (ids.length === 0 && query === '') throw new LearnError('provide query or ids')
    const tokens = query.split(/[^a-z0-9]+/u).filter(token => token.length > 2)
    const scored = this.state.graph.propositions.map(proposition => {
      const haystack = proposition.text.toLowerCase()
      let score = ids.includes(proposition.id) ? 100 : 0
      if (query !== '' && haystack.includes(query)) score += 40
      if (tokens.length > 0) score += tokens.filter(token => haystack.includes(token)).length * 5
      return { proposition, score }
    }).filter(item => item.score > 0)
    scored.sort((a, b) => b.score - a.score || a.proposition.createdAt.localeCompare(b.proposition.createdAt))
    const propositions = scored.slice(0, limit).map(item => item.proposition)
    const chosen = new Set(propositions.map(proposition => proposition.id))
    const chains = this.state.graph.chains.filter(chain =>
      chosen.has(chain.conclusionId) || chain.premiseIds.some(id => chosen.has(id))).slice(0, limit * 2)
    return {
      propositions,
      chains,
      total: { propositions: this.state.graph.propositions.length, chains: this.state.graph.chains.length },
    }
  }

  /**
   * Commit propositions and chains. Text is deduplicated against the existing
   * graph, so re-teaching a claim does not grow the graph.
   * @param {string} sessionId owning session.
   * @param {object} input commit input.
   * @returns {Promise<object>} counts and the committed ids.
   */
  async graphCommit(sessionId, input) {
    const rawPropositions = input?.propositions ?? []
    const rawChains = input?.chains ?? []
    if (!Array.isArray(rawPropositions) || rawPropositions.length === 0) {
      throw new LearnError('propositions must be a non-empty array')
    }
    if (rawPropositions.length > MAX_COMMIT_PROPOSITIONS) {
      throw new LearnError(`commit at most ${MAX_COMMIT_PROPOSITIONS} propositions at once`)
    }
    if (!Array.isArray(rawChains) || rawChains.length > MAX_COMMIT_CHAINS) {
      throw new LearnError(`chains must be an array of at most ${MAX_COMMIT_CHAINS}`)
    }
    const normalized = rawPropositions.map((item, index) => {
      if (typeof item?.text !== 'string') throw new LearnError(`propositions[${index}].text must be a string`)
      const key = typeof item.key === 'string' && item.key.trim() !== ''
        ? item.key.trim()
        : `p${index + 1}`
      return { key, text: text(item.text, `propositions[${index}].text`, MAX_TEXT) }
    })
    return this.#commit(() => {
      const lesson = this.state.lessons[sessionId]
      if (!lesson) throw new LearnError('this session has no lesson; call learn_plan first')
      const byText = new Map(this.state.graph.propositions.map(proposition => [normalizeText(proposition.text), proposition]))
      const byKey = new Map()
      let added = 0
      for (const item of normalized) {
        const existing = byText.get(normalizeText(item.text))
        if (existing) {
          byKey.set(item.key, existing.id)
          continue
        }
        const proposition = {
          id: newId('p'),
          text: item.text,
          lessonId: lesson.sessionId,
          sessionId,
          createdAt: nowIso(),
        }
        this.state.graph.propositions.push(proposition)
        byText.set(normalizeText(proposition.text), proposition)
        byKey.set(item.key, proposition.id)
        added++
      }
      const resolve = (value) => {
        if (typeof value !== 'string') throw new LearnError('chain references must be strings')
        if (byKey.has(value)) return byKey.get(value)
        if (this.state.graph.propositions.some(proposition => proposition.id === value)) return value
        const byTextMatch = byText.get(normalizeText(value))
        if (byTextMatch) return byTextMatch.id
        throw new LearnError(`chain reference "${value}" does not name a committed or existing proposition`)
      }
      const chainKeys = new Set()
      let chainsAdded = 0
      for (const item of rawChains) {
        if (!Array.isArray(item?.premises) || item.premises.length === 0) {
          throw new LearnError('each chain needs at least one premise')
        }
        const premiseIds = [...new Set(item.premises.map(resolve))]
        const conclusionId = resolve(item.conclusion)
        if (premiseIds.includes(conclusionId)) throw new LearnError('a chain conclusion cannot also be a premise')
        const key = `${[...premiseIds].sort().join(',')}>${conclusionId}`
        if (chainKeys.has(key)) continue
        const duplicate = this.state.graph.chains.some(chain =>
          chain.conclusionId === conclusionId
          && chain.premiseIds.length === premiseIds.length
          && [...chain.premiseIds].sort().join(',') === [...premiseIds].sort().join(','))
        if (duplicate) continue
        chainKeys.add(key)
        this.state.graph.chains.push({
          id: newId('c'),
          premiseIds,
          conclusionId,
          lessonId: lesson.sessionId,
          sessionId,
          createdAt: nowIso(),
        })
        chainsAdded++
      }
      return {
        addedPropositions: added,
        addedChains: chainsAdded,
        total: { propositions: this.state.graph.propositions.length, chains: this.state.graph.chains.length },
        committed: [...byKey.entries()].map(([key, id]) => {
          const proposition = this.state.graph.propositions.find(item => item.id === id)
          return { key, id, text: proposition?.text ?? '' }
        }),
      }
    })
  }

  /**
   * Read model for the Learn page.
   * @param {string} selectedSessionId requested lesson, or '' for the latest.
   * @returns {Promise<object>} lessons summaries, the selected lesson, and the graph.
   */
  async snapshot(selectedSessionId = '') {
    await this.ready
    const lessons = Object.values(this.state.lessons)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50)
      .map(lesson => {
        const done = lesson.nodes.filter(node => DONE_STATUSES.has(node.status)).length
        return {
          sessionId: lesson.sessionId,
          goal: lesson.goal,
          status: lesson.status,
          updatedAt: lesson.updatedAt,
          nodeCount: lesson.nodes.length,
          doneCount: done,
          currentTitle: lesson.nodes.find(node => node.id === lesson.currentNodeId)?.title ?? null,
        }
      })
    const wanted = selectedSessionId !== '' && this.state.lessons[selectedSessionId]
      ? selectedSessionId
      : lessons[0]?.sessionId ?? ''
    const lesson = wanted !== '' ? this.state.lessons[wanted] : null
    const propositions = this.state.graph.propositions.slice(-200)
    const chains = this.state.graph.chains.slice(-300)
    return {
      lessons,
      selectedSessionId: wanted,
      lesson: lesson === null ? null : JSON.parse(JSON.stringify(lesson)),
      graph: {
        propositions,
        chains,
        total: {
          propositions: this.state.graph.propositions.length,
          chains: this.state.graph.chains.length,
        },
        truncated: this.state.graph.propositions.length > propositions.length
          || this.state.graph.chains.length > chains.length,
      },
      updatedAt: this.state.updatedAt,
    }
  }
}

/**
 * Format a lesson as compact model-facing text.
 * @param {object} lesson lesson record.
 * @returns {string} summary block.
 */
export function formatLesson(lesson) {
  const done = lesson.nodes.filter(node => DONE_STATUSES.has(node.status)).length
  const lines = [
    `Goal: ${lesson.goal}`,
    `Progress: ${done}/${lesson.nodes.length} nodes done. Current: ${lesson.currentNodeId ?? 'none'}`,
    'Plan:',
  ]
  for (const node of lesson.nodes) {
    const mark = node.status === 'verified' ? '[x]' : node.status === 'held' ? '[o]' : node.status === 'teaching' ? '[~]' : '[ ]'
    const deps = node.deps.length > 0 ? ` <- ${node.deps.join(',')}` : ''
    lines.push(`  ${mark} ${node.id} [${node.status}] ${node.title}${deps}`)
  }
  const last = lesson.nodes.flatMap(node => node.evidence.map(evidence => ({ node, evidence })))
    .sort((a, b) => b.evidence.at.localeCompare(a.evidence.at))
    .slice(0, 3)
  if (last.length > 0) {
    lines.push('Recent evidence:')
    for (const { node, evidence } of last) {
      const confidence = evidence.confidence === null ? '' : ` ${evidence.confidence}%`
      lines.push(`  - ${node.id} ${evidence.kind}/${evidence.outcome}${confidence}${evidence.note ? `: ${evidence.note}` : ''}`)
    }
  }
  return lines.join('\n')
}
