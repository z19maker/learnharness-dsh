import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { LearnStore } from '../lib/store.js'
import { apply as applyTutor } from '../tutor.js'

const roots = []

async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), 'learnharness-plugin-'))
  roots.push(root)
  return new LearnStore(root)
}

after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

test('tutor registers the method and four tools, then runs a full lesson', async () => {
  const store = await freshStore()
  let method = ''
  const tools = []
  applyTutor({
    effect(fn) {
      return fn()
    },
    systemPrompt: {
      section(definition) {
        method = definition.text
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    learnStore: store,
  })
  assert.match(method, /LEARNHARNESS METHOD/)
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['learn_checkpoint', 'learn_graph', 'learn_plan', 'learn_state'])
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const exec = { agent: { session: { id: 'session-test' } } }

  const empty = await byName.get('learn_state').execute({}, exec)
  assert.match(empty.text, /No lesson/)

  const planned = await byName.get('learn_plan').execute({
    goal: 'why minibatch gradients are unbiased',
    nodes: [
      { id: 'full', title: 'The full gradient' },
      { id: 'mini', title: 'A minibatch average', deps: ['full'] },
    ],
  }, exec)
  assert.match(planned.text, /Plan set: 0\/2/)
  assert.match(planned.text, /full \[unseen\]/)

  const checked = await byName.get('learn_checkpoint').execute({
    nodeId: 'full',
    kind: 'probe',
    outcome: 'held',
    confidence: 80,
    note: 'knows the definition',
  }, exec)
  assert.match(checked.text, /held/)
  assert.match(checked.text, /Next: mini/)

  const state = await byName.get('learn_state').execute({}, exec)
  assert.match(state.text, /Goal: why minibatch gradients are unbiased/)
  assert.match(state.text, /1\/2 nodes done/)

  const committed = await byName.get('learn_graph').execute({
    op: 'commit',
    propositions: [
      { key: 'a', text: 'The full gradient is the average of per-example gradients.' },
      { key: 'b', text: 'A uniform minibatch average is unbiased.' },
    ],
    chains: [{ premises: ['a'], conclusion: 'b' }],
  }, exec)
  assert.match(committed.text, /2 new propositions and 1 new chains/)
  assert.match(committed.text, /p_/)

  const found = await byName.get('learn_graph').execute({ op: 'query', query: 'minibatch unbiased' }, exec)
  assert.match(found.text, /minibatch average is unbiased/)
})

test('client module registers the sidebar entry and the Learn page', async () => {
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  await import(`../client.js?test=${Date.now()}`)
  assert.equal(loaded.id, '@local/learnharness')
  const React = {
    createElement: (...args) => ({ args }),
  }
  const client = loaded.factory(specifier => {
    assert.equal(specifier, 'react')
    return React
  })
  const registrations = []
  const ctx = {
    locale: {
      bind: () => key => key,
      register: () => {},
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(spec, component) {
        registrations.push({ spec, component })
      },
    },
    effect: fn => fn(),
  }
  client.inject.forEach(name => assert.ok(name))
  client.apply(ctx)
  assert.deepEqual(registrations.map(item => item.spec.name), ['sidebar.panellist', 'main'])
  assert.equal(registrations[0].spec.label(), 'panel')
  assert.equal(typeof registrations[1].component, 'function')
  delete globalThis.window
})

test('the API handler returns the snapshot and rejects other methods', async () => {
  const { createHandler } = await import('../index.js')
  const store = await freshStore()
  await store.setPlan('s1', { goal: 'g', nodes: [{ id: 'a', title: 'A' }] })
  const handler = createHandler(store)
  const response = () => {
    const out = { status: 0, headers: undefined, body: '' }
    return {
      out,
      writeHead(status, headers) {
        out.status = status
        out.headers = headers
      },
      end(body) {
        out.body = body ?? ''
      },
    }
  }
  const ok = response()
  await handler({ method: 'GET', url: '/learnharness/api?session=s1' }, ok)
  assert.equal(ok.out.status, 200)
  assert.match(ok.out.headers['content-type'], /application\/json/)
  const parsed = JSON.parse(ok.out.body)
  assert.equal(parsed.lesson.goal, 'g')

  const bad = response()
  await handler({ method: 'POST', url: '/learnharness/api' }, bad)
  assert.equal(bad.out.status, 405)

  const head = response()
  await handler({ method: 'HEAD', url: '/learnharness/api' }, head)
  assert.equal(head.out.status, 200)
  assert.equal(head.out.body, '')
})
