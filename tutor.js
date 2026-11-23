/**
 * The Tutor preset's contribution: the teaching method prompt section and the
 * four learning tools.
 *
 * All durable state is owned by the Host half; this plugin only reads and
 * writes it through the `learnStore` service the Host half provides.
 */

import { LearnError, formatLesson } from './lib/store.js'

export const name = 'learnharness-tutor'
export const inject = ['tools', 'systemPrompt', 'learnStore']

const METHOD = `LEARNHARNESS METHOD

You are a tutor, not an answer machine. The learner is here to make one target understanding feel obviously true by building from what they already hold.

At the start of every turn, call learn_state. If there is no lesson, ask what they want to understand, then call learn_plan with a small dependency map: 3 to 10 coarse topics, each with the earlier node ids it depends on.

Before teaching a node, probe it with ask_user_question: ask a question that exposes the reasoning, and in the same call ask how confident they are (guess / unsure / fairly sure / certain). Record both with learn_checkpoint, kind probe. held means they already have it; partial, gap, or confusion means it must be taught.

Teach one reasoning step at a time. Never present two new claims in one step. After each step, ask exactly one check question with ask_user_question, then record it with learn_checkpoint. If the check is not held, repair that step and re-check before moving on. Never build on a step that is not held.

When a node becomes held or verified, learn_checkpoint advances the current node. Follow the plan. Revise it with learn_plan only when a probe shows the route is wrong, and keep the same node ids so the evidence survives.

Practice is separate from teaching. Ask the learner to solve a problem that requires the knowledge without naming which knowledge, then record kind practice.

Before planning, call learn_graph query with the goal's key terms so you do not re-teach what the graph already holds. At the end of a lesson, call learn_graph commit with the propositions the lesson established and the reasoning chains (premises to conclusion). The graph records claims and entailments, never grades or ability ratings.

Use the learner's own words. Ask for their reasoning, not just the answer. Be concise, and do not narrate the method.`

/** @returns {object} the shared canonical output declaration. */
function output() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
      },
      required: ['ok', 'text'],
    },
    render(_args, value) {
      return [{ type: 'text', text: value.text }]
    },
  }
}

/** @param {string} message model-facing result. @returns {{ok: boolean, text: string}} canonical value. */
function answer(message) {
  return { ok: true, text: message }
}

/** @param {object} exec tool execution context. @returns {string} the owning session id. */
function sessionOf(exec) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || id === '') {
    throw new LearnError('this tool needs an owning agent session')
  }
  return id
}

/** @param {object} lesson lesson record. @returns {string} one-line progress. */
function progressOf(lesson) {
  const done = lesson.nodes.filter(node => node.status === 'held' || node.status === 'verified').length
  const current = lesson.nodes.find(node => node.id === lesson.currentNodeId)
  return `${done}/${lesson.nodes.length} nodes done${current ? ` · current: ${current.id} (${current.title})` : ''}`
}

/** @param {object} store learn store. @param {string} goal lesson goal. @returns {Promise<string>} relevant graph block. */
async function graphBrief(store, goal) {
  const found = await store.graphQuery({ query: goal, limit: 6 })
  const total = found.total
  const head = `Graph: ${total.propositions} propositions, ${total.chains} chains.`
  if (found.propositions.length === 0) return `${head} Nothing relevant yet.`
  const lines = found.propositions.map(proposition => `- ${proposition.text} (${proposition.id})`)
  return `${head} Relevant:\n${lines.join('\n')}`
}

/**
 * Build the four learning tools over the Host store.
 * @param {object} store learnStore service.
 * @returns {object[]} registry-ready tool definitions.
 */
function toolDefinitions(store) {
  const out = output()
  return [
    {
      name: 'learn_state',
      description:
        'Read the current lesson: goal, plan, node statuses, recent evidence, and the graph material relevant to the goal. '
        + 'Call it at the start of every tutor turn, before deciding what to do next.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: out,
      async execute(_args, exec) {
        const sessionId = sessionOf(exec)
        const lesson = await store.lesson(sessionId)
        if (lesson === null) {
          return answer('No lesson in this session yet. Ask what the learner wants to understand, then call learn_plan with the goal and a small dependency plan.')
        }
        return answer(`${formatLesson(lesson)}\n\n${await graphBrief(store, lesson.goal)}`)
      },
    },
    {
      name: 'learn_plan',
      description:
        'Create or replace the lesson plan: the minimal dependency map from what the learner already holds to the goal. '
        + 'Nodes are coarse topics, not individual sentences. Keep node ids when revising so evidence survives. '
        + 'The first call needs a goal.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['nodes'],
        properties: {
          goal: { type: 'string', description: 'What the learner wants to understand. Required on the first call; omit to keep the existing goal.' },
          nodes: {
            type: 'array',
            description: 'Ordered dependency plan. Each node needs id (lowercase slug), title, and deps (earlier node ids).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: 'Lowercase letters, digits, and hyphens; stable across revisions.' },
                title: { type: 'string', description: 'Short topic title shown to the learner.' },
                deps: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Ids of nodes that must be held first. Empty for a starting node.',
                },
              },
            },
          },
        },
      },
      output: out,
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        const lesson = await store.setPlan(sessionId, { goal: args?.goal, nodes: args?.nodes })
        return answer(`Plan set: ${progressOf(lesson)}.\n\n${formatLesson(lesson)}\n\nShow the learner the plan as a short list. Do not start teaching until the first probe.`)
      },
    },
    {
      name: 'learn_checkpoint',
      description:
        'Record what a probe, check, or practice attempt showed for one plan node. This is the only way a node status changes. '
        + 'held means the learner already holds it or answered correctly and self-evidently; partial, gap, or confusion means the step needs repair. '
        + 'The current node advances automatically when it is held or verified.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'kind', 'outcome'],
        properties: {
          nodeId: { type: 'string', description: 'Plan node id being observed.' },
          kind: { type: 'string', enum: ['probe', 'check', 'practice'], description: 'probe before teaching, check after one step, practice for a separate problem.' },
          outcome: { type: 'string', enum: ['held', 'partial', 'gap', 'confusion'], description: 'How it went.' },
          confidence: { type: 'integer', description: 'The learner confidence from 0 to 100, when asked.' },
          note: { type: 'string', description: 'Short evidence in the learner words: what they said or where it broke.' },
        },
      },
      output: out,
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        const result = await store.checkpoint(sessionId, {
          nodeId: args?.nodeId,
          kind: args?.kind,
          outcome: args?.outcome,
          confidence: args?.confidence,
          note: args?.note,
        })
        const next = result.next === null
          ? 'Every node is done; consider closing the lesson and committing the graph.'
          : `Next: ${result.next}.`
        const guidance = args?.outcome === 'held'
          ? 'Continue with one reasoning step.'
          : 'Repair this step before building on it, then check again.'
        return answer(`Recorded ${args?.kind}/${args?.outcome} for ${result.node.id} (${result.node.title}). ${next}\n${guidance}`)
      },
    },
    {
      name: 'learn_graph',
      description:
        'Read or write the persistent knowledge graph. Query before planning to avoid re-teaching; commit at the end of a lesson. '
        + 'The graph holds propositions and the reasoning chains that entail them, with provenance, never grades.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['query', 'commit'], description: 'query to read relevant material, commit to add propositions and chains.' },
          query: { type: 'string', description: 'Query text for op=query. Use the goal keywords.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Proposition ids for op=query.' },
          limit: { type: 'integer', description: 'Maximum propositions to return, 1 to 40. Defaults to 12.' },
          propositions: {
            type: 'array',
            description: 'For op=commit: claims the lesson established. Each needs key (local reference) and text.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', description: 'Short local reference used by chains in this call.' },
                text: { type: 'string', description: 'One proposition, stated plainly.' },
              },
            },
          },
          chains: {
            type: 'array',
            description: 'For op=commit: reasoning chains. Each names premise keys or ids and one conclusion key or id.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                premises: { type: 'array', items: { type: 'string' }, description: 'Keys or ids of the premises.' },
                conclusion: { type: 'string', description: 'Key or id of the conclusion.' },
              },
            },
          },
        },
      },
      output: out,
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        if (args?.op === 'query') {
          const found = await store.graphQuery({
            query: args?.query,
            ids: args?.ids,
            limit: args?.limit,
          })
          if (found.propositions.length === 0) {
            return answer(`No matching propositions. The graph holds ${found.total.propositions} propositions and ${found.total.chains} chains.`)
          }
          const byId = new Map(found.propositions.map(proposition => [proposition.id, proposition]))
          const lines = found.propositions.map(proposition => `- ${proposition.id} ${proposition.text}`)
          const chains = found.chains.map(chain => {
            const premises = chain.premiseIds.map(id => byId.get(id)?.text ?? id)
            const conclusion = byId.get(chain.conclusionId)?.text ?? chain.conclusionId
            return `  ${premises.join(' + ')} -> ${conclusion}`
          })
          const chainBlock = chains.length > 0 ? `\nChains:\n${chains.join('\n')}` : ''
          return answer(`${found.propositions.length} propositions (graph total ${found.total.propositions}/${found.total.chains}):\n${lines.join('\n')}${chainBlock}`)
        }
        if (args?.op === 'commit') {
          const result = await store.graphCommit(sessionId, {
            propositions: args?.propositions,
            chains: args?.chains,
          })
          const committed = result.committed.map(item => `- ${item.id} ${item.text}`).join('\n')
          return answer(`Committed ${result.addedPropositions} new propositions and ${result.addedChains} new chains. Graph now holds ${result.total.propositions} propositions and ${result.total.chains} chains.\n${committed}`)
        }
        throw new LearnError('op must be query or commit')
      },
    },
  ]
}

/**
 * Register the method and tools on the Tutor preset's agent context.
 * @param {import('@deepseek-ai/cordis').Context} ctx preset context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'learnharness:method',
    order: 60,
    text: METHOD,
  }))
  for (const definition of toolDefinitions(ctx.learnStore)) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
