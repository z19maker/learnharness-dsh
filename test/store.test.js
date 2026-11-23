import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { LearnError, LearnStore, formatLesson } from '../lib/store.js'

const roots = []

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'learnharness-'))
  roots.push(root)
  return { root, store: new LearnStore(root) }
}

after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

test('plan validation rejects duplicates, unknown deps, and cycles', async () => {
  const { store } = await fresh()
  await assert.rejects(
    store.setPlan('s1', { goal: 'g', nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }),
    LearnError,
  )
  await assert.rejects(
    store.setPlan('s1', { goal: 'g', nodes: [{ id: 'a', title: 'A', deps: ['b'] }] }),
    /unknown node/,
  )
  await assert.rejects(
    store.setPlan('s1', {
      goal: 'g',
      nodes: [{ id: 'a', title: 'A', deps: ['b'] }, { id: 'b', title: 'B', deps: ['a'] }],
    }),
    /acyclic/,
  )
})

test('plan keeps evidence for a retained node id', async () => {
  const { store } = await fresh()
  await store.setPlan('s1', { goal: 'gradient descent', nodes: [{ id: 'grad', title: 'Gradient' }] })
  await store.checkpoint('s1', { nodeId: 'grad', kind: 'probe', outcome: 'held', confidence: 80, note: 'knows slope' })
  const revised = await store.setPlan('s1', {
    nodes: [{ id: 'grad', title: 'Gradients' }, { id: 'var', title: 'Variance', deps: ['grad'] }],
  })
  assert.equal(revised.nodes[0].status, 'held')
  assert.equal(revised.nodes[0].evidence.length, 1)
  assert.equal(revised.currentNodeId, 'var')
})

test('checkpoint advances only through dependency-ready nodes', async () => {
  const { store } = await fresh()
  await store.setPlan('s1', {
    goal: 'g',
    nodes: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', deps: ['a'] },
      { id: 'c', title: 'C' },
    ],
  })
  const first = await store.checkpoint('s1', { nodeId: 'a', kind: 'probe', outcome: 'held' })
  assert.equal(first.next, 'b')
  const second = await store.checkpoint('s1', { nodeId: 'b', kind: 'check', outcome: 'partial' })
  assert.equal(second.node.status, 'teaching')
  assert.equal(second.next, 'b')
  const third = await store.checkpoint('s1', { nodeId: 'b', kind: 'check', outcome: 'held' })
  assert.equal(third.next, 'c')
})

test('graph commit dedupes claims and chains, and query returns both', async () => {
  const { store } = await fresh()
  await store.setPlan('s1', { goal: 'g', nodes: [{ id: 'a', title: 'A' }] })
  const one = await store.graphCommit('s1', {
    propositions: [
      { key: 'p', text: '  gradient is the slope ' },
      { key: 'q', text: 'a minibatch average is unbiased' },
    ],
    chains: [{ premises: ['p'], conclusion: 'q' }],
  })
  assert.equal(one.addedPropositions, 2)
  assert.equal(one.addedChains, 1)

  const q = one.committed.find(item => item.text.includes('minibatch')).id
  const two = await store.graphCommit('s1', {
    propositions: [{ key: 'p2', text: 'gradient is the slope' }],
    chains: [{ premises: ['p2'], conclusion: q }],
  })
  assert.equal(two.addedPropositions, 0)
  assert.equal(two.addedChains, 0)

  const found = await store.graphQuery({ query: 'gradient slope' })
  assert.equal(found.propositions.length, 1)
  assert.equal(found.total.propositions, 2)
  assert.equal(found.chains.length, 1)
  assert.match(found.propositions[0].text, /gradient/)
})

test('snapshot selects the requested lesson and survives reload', async () => {
  const { root, store } = await fresh()
  await store.setPlan('s1', { goal: 'one', nodes: [{ id: 'a', title: 'A' }] })
  await store.checkpoint('s1', { nodeId: 'a', kind: 'check', outcome: 'held' })
  const view = await store.snapshot('s1')
  assert.equal(view.lesson.goal, 'one')
  assert.equal(view.lessons[0].doneCount, 1)

  const reloaded = new LearnStore(root)
  const again = await reloaded.snapshot('s1')
  assert.equal(again.lesson.nodes[0].status, 'verified')
  const raw = JSON.parse(await readFile(join(root, 'learn.json'), 'utf8'))
  assert.equal(raw.version, 1)
})

test('a corrupt file is kept aside and the store starts empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnharness-'))
  roots.push(root)
  await writeFile(join(root, 'learn.json'), '{ not json')
  const store = new LearnStore(root)
  const view = await store.snapshot()
  assert.equal(view.lesson, null)
})

test('formatLesson shows the plan and recent evidence', async () => {
  const { store } = await fresh()
  await store.setPlan('s1', { goal: 'g', nodes: [{ id: 'a', title: 'A' }] })
  await store.checkpoint('s1', { nodeId: 'a', kind: 'probe', outcome: 'gap', note: 'wrong idea' })
  const text = formatLesson(await store.lesson('s1'))
  assert.match(text, /Goal: g/)
  assert.match(text, /a \[teaching\] A/)
  assert.match(text, /wrong idea/)
})
