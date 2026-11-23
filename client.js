/**
 * LearnHarness — the visual half.
 *
 * Adds a Learn entry to the main sidebar and a page showing the current
 * lesson's dependency plan and the profile's knowledge graph. Reads only the
 * Host half's `/learnharness/api` route; the tutor tools are the only writers.
 *
 * Plain module-loader JavaScript, no build step. Styles are one component
 * `<style>` element using host theme tokens only.
 */

window.__ModuleLoader__.load({
  id: '@local/learnharness',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'learnHarness'
    const PANEL_ID = 'learnharness'
    const API = '/learnharness/api'
    const POLL_MS = 3000

    const dictionaries = {
      en: {
        panel: 'Learn',
        title: 'Learn',
        subtitle: 'One profile · the lesson plan and the knowledge it builds',
        plan: 'Lesson plan',
        graph: 'Knowledge graph',
        loading: 'Loading…',
        loadFailed: 'Could not reach the Learn store.',
        retry: 'Retry',
        refresh: 'Refresh',
        noLessonTitle: 'No lesson yet',
        noLessonBody: 'Start a new session, choose the Tutor preset, and say what you want to understand. The tutor builds a plan, and it appears here as the lesson moves.',
        noGraphTitle: 'The graph is still empty',
        noGraphBody: 'When a lesson ends, the tutor commits the propositions it established and the reasoning chains between them. They accumulate here across sessions.',
        current: 'now',
        verified: 'verified',
        held: 'held',
        teaching: 'teaching',
        probing: 'probing',
        unseen: 'not started',
        blocked: 'blocked',
        evidence: 'evidence',
        deps: 'depends on',
        none: 'none',
        propositions: 'propositions',
        chains: 'chains',
        done: 'done',
        lesson: 'Lesson',
        updated: 'Updated',
        selectedNode: 'Node',
        close: 'Close',
        noEvidence: 'No evidence recorded for this node yet.',
        graphSelection: 'Selected proposition',
        premiseOf: 'Used by',
        graphTruncated: 'Showing the latest {n} of {total} propositions.',
        planEmpty: 'The tutor has not set a plan for this lesson yet.',
        emptySeed: 'The tutor is reading where your understanding ends. The plan will appear here.',
      },
    }

    const STATUS_LABEL = {
      unseen: 'unseen',
      probing: 'probing',
      held: 'held',
      teaching: 'teaching',
      verified: 'verified',
      blocked: 'blocked',
    }

    /**
     * Lay the plan out as dependency levels: every node sits one column right
     * of its deepest dependency.
     * @param {object[]} nodes lesson nodes.
     * @returns {{placed: object[], edges: object[], width: number, height: number}} layout.
     */
    function planLayout(nodes) {
      const byId = new Map(nodes.map(node => [node.id, node]))
      const levels = new Map()
      const visit = (id, trail) => {
        if (levels.has(id)) return levels.get(id)
        if (trail.has(id)) return 0
        trail.add(id)
        const node = byId.get(id)
        const deps = (node?.deps ?? []).filter(dep => byId.has(dep))
        const level = deps.length === 0 ? 0 : Math.max(...deps.map(dep => visit(dep, trail))) + 1
        trail.delete(id)
        levels.set(id, level)
        return level
      }
      for (const node of nodes) visit(node.id, new Set())
      const groups = new Map()
      for (const node of nodes) {
        const level = levels.get(node.id) ?? 0
        if (!groups.has(level)) groups.set(level, [])
        groups.get(level).push(node)
      }
      const NW = 216
      const NH = 96
      const GX = 64
      const GY = 22
      const placed = []
      let rows = 0
      for (const [level, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        rows = Math.max(rows, group.length)
        group.forEach((node, index) => {
          placed.push({
            ...node,
            x: 26 + level * (NW + GX),
            y: 22 + index * (NH + GY),
            level,
          })
        })
      }
      const byNode = new Map(placed.map(node => [node.id, node]))
      const edges = []
      for (const node of placed) {
        for (const dep of node.deps) {
          const from = byNode.get(dep)
          if (!from) continue
          const x1 = from.x + NW
          const y1 = from.y + NH / 2
          const x2 = node.x
          const y2 = node.y + NH / 2
          const bend = Math.max(40, (x2 - x1) / 2)
          edges.push({ from: from.id, to: node.id, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` })
        }
      }
      const maxLevel = Math.max(0, ...[...levels.values()])
      return {
        placed,
        edges,
        width: 26 + (maxLevel + 1) * (NW + GX),
        height: 22 + Math.max(1, rows) * (NH + GY),
      }
    }

    /**
     * Lay the graph out as premise-to-conclusion levels. Cycles fall back to
     * level zero instead of recursing forever.
     * @param {object[]} propositions graph propositions.
     * @param {object[]} chains graph chains.
     * @returns {{placed: object[], edges: object[], width: number, height: number}} layout.
     */
    function graphLayout(propositions, chains) {
      const ids = new Set(propositions.map(proposition => proposition.id))
      const useful = chains.filter(chain => ids.has(chain.conclusionId) && chain.premiseIds.some(id => ids.has(id)))
      const incoming = new Map([...ids].map(id => [id, []]))
      for (const chain of useful) {
        for (const premise of chain.premiseIds) {
          if (ids.has(premise)) incoming.get(chain.conclusionId).push(premise)
        }
      }
      const levels = new Map()
      const visit = (id, trail) => {
        if (levels.has(id)) return levels.get(id)
        if (trail.has(id)) return 0
        trail.add(id)
        const deps = incoming.get(id) ?? []
        const level = deps.length === 0 ? 0 : Math.max(...deps.map(dep => visit(dep, trail))) + 1
        trail.delete(id)
        levels.set(id, level)
        return level
      }
      for (const id of ids) visit(id, new Set())
      const groups = new Map()
      for (const proposition of propositions) {
        const level = levels.get(proposition.id) ?? 0
        if (!groups.has(level)) groups.set(level, [])
        groups.get(level).push(proposition)
      }
      const NW = 184
      const NH = 58
      const GX = 76
      const GY = 20
      const placed = []
      let rows = 0
      for (const [level, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        rows = Math.max(rows, group.length)
        group.forEach((proposition, index) => {
          placed.push({ ...proposition, x: 26 + level * (NW + GX), y: 22 + index * (NH + GY), level })
        })
      }
      const byId = new Map(placed.map(proposition => [proposition.id, proposition]))
      const edges = []
      for (const chain of useful) {
        const to = byId.get(chain.conclusionId)
        if (!to) continue
        for (const premise of chain.premiseIds) {
          const from = byId.get(premise)
          if (!from) continue
          const x1 = from.x + NW
          const y1 = from.y + NH / 2
          const x2 = to.x
          const y2 = to.y + NH / 2
          const bend = Math.max(36, Math.abs(x2 - x1) / 2)
          edges.push({
            id: chain.id,
            from: from.id,
            to: to.id,
            d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          })
        }
      }
      const maxLevel = Math.max(0, ...[...levels.values()])
      return {
        placed,
        edges,
        width: 26 + (maxLevel + 1) * (NW + GX),
        height: 22 + Math.max(1, rows) * (NH + GY),
      }
    }

    /** @param {string} iso timestamp. @returns {string} short local label. */
    function when(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /** The left sidebar glyph: a loop with two nodes. */
    function LearnIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 36 36',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', {
        d: 'M29 12a12 12 0 0 0-20.5-1',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M7 24a12 12 0 0 0 20.5 1',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
      }),
      h('circle', { cx: 29, cy: 12, r: 3.2, fill: 'var(--dsw-alias-state-warn-primary, #f59e0b)' }),
      h('circle', { cx: 7, cy: 24, r: 2.4, fill: 'currentColor', opacity: 0.55 }))
    }

    /** Detail card for a selected plan node. */
    function NodeDetail({ node, t, onClose }) {
      return h('div', { className: 'lh-detail' },
        h('div', { className: 'lh-detail-head' },
          h('strong', null, node.title),
          h('span', { className: `lh-badge lh-badge-${node.status}` }, STATUS_LABEL[node.status] ?? node.status),
          h('button', { className: 'lh-icon-btn', type: 'button', onClick: onClose, 'aria-label': t('close') }, '×')),
        h('div', { className: 'lh-detail-meta' }, `${t('deps')}: ${node.deps.length > 0 ? node.deps.join(', ') : t('none')}`),
        node.evidence.length === 0
          ? h('p', { className: 'lh-detail-empty' }, t('noEvidence'))
          : h('ul', { className: 'lh-evidence' }, node.evidence.slice(-6).reverse().map((item, index) => h('li', { key: index },
            h('span', { className: 'lh-evidence-kind' }, `${item.kind}/${item.outcome}`),
            item.confidence !== null && item.confidence !== undefined
              ? h('span', { className: 'lh-evidence-meta' }, ` ${item.confidence}%`)
              : null,
            item.note ? h('span', { className: 'lh-evidence-note' }, ` — ${item.note}`) : null,
            h('span', { className: 'lh-evidence-time' }, ` ${when(item.at)}`)))))
    }

    /** The dependency plan, its edges, and the selected node's evidence. */
    function PlanSection({ lesson, plan, selectedNode, onSelect, t }) {
      const done = lesson.nodes.filter(item => item.status === 'held' || item.status === 'verified').length
      const node = lesson.nodes.find(item => item.id === selectedNode) ?? null
      return h('section', { className: 'lh-panel', 'aria-label': t('plan') },
        h('header', { className: 'lh-panel-head' },
          h('div', null,
            h('h2', { className: 'lh-panel-title' }, t('plan')),
            h('p', { className: 'lh-panel-sub' }, lesson.goal)),
          h('span', { className: 'lh-panel-count' }, `${done}/${lesson.nodes.length}`)),
        h('div', { className: 'lh-canvas', style: { height: 440 } },
          h('div', {
            className: 'lh-canvas-inner',
            style: { width: Math.max(plan.width, 320), height: Math.max(plan.height, 200) },
          },
          h('svg', { className: 'lh-edges', width: '100%', height: '100%', 'aria-hidden': true },
            h('defs', null,
              h('marker', {
                id: 'lh-plan-arrow',
                viewBox: '0 0 8 8',
                refX: 7,
                refY: 4,
                markerWidth: 7,
                markerHeight: 7,
                orient: 'auto',
              }, h('path', { d: 'M0 0 L8 4 L0 8 z', fill: 'var(--dsw-alias-label-dimmed, #777)' }))),
            plan.edges.map(edge => h('path', {
              key: `${edge.from}-${edge.to}`,
              d: edge.d,
              className: 'lh-edge',
              markerEnd: 'url(#lh-plan-arrow)',
            }))),
          plan.placed.map(item => h('button', {
            key: item.id,
            type: 'button',
            className: `lh-node lh-node-${item.status}${item.id === lesson.currentNodeId ? ' lh-node-current' : ''}${item.id === selectedNode ? ' lh-node-selected' : ''}`,
            style: { left: item.x, top: item.y },
            onClick: () => onSelect(item.id === selectedNode ? '' : item.id),
            'aria-pressed': item.id === selectedNode,
            title: item.title,
          },
          h('span', { className: 'lh-node-top' },
            h('span', { className: `lh-dot lh-dot-${item.status}` }),
            h('span', { className: 'lh-node-status' }, STATUS_LABEL[item.status] ?? item.status),
            item.id === lesson.currentNodeId ? h('span', { className: 'lh-now' }, t('current')) : null),
          h('span', { className: 'lh-node-title' }, item.title),
          h('span', { className: 'lh-node-meta' },
            item.evidence.length > 0 ? `${item.evidence.length} ${t('evidence')}` : STATUS_LABEL[item.status] ?? item.status,
            item.deps.length > 0 ? ` · ${t('deps')} ${item.deps.join(', ')}` : '')))),
          plan.placed.length === 0 ? h('div', { className: 'lh-canvas-empty' }, t('planEmpty')) : null),
        node === null ? null : h(NodeDetail, { node, t, onClose: () => onSelect('') }))
    }

    /** The knowledge graph, its premise edges, and the selected proposition. */
    function GraphSection({ graph, shownPropositions, view, selectedProp, onSelect, t }) {
      const proposition = shownPropositions.find(item => item.id === selectedProp) ?? null
      const chainCount = proposition === null
        ? 0
        : graph.chains.filter(chain => chain.premiseIds.includes(proposition.id) || chain.conclusionId === proposition.id).length
      return h('section', { className: 'lh-panel', 'aria-label': t('graph') },
        h('header', { className: 'lh-panel-head' },
          h('div', null,
            h('h2', { className: 'lh-panel-title' }, t('graph')),
            h('p', { className: 'lh-panel-sub' }, `${graph.total.propositions} ${t('propositions')} · ${graph.total.chains} ${t('chains')}`)),
          graph.truncated ? h('span', { className: 'lh-panel-count' }, '⋯') : null),
        shownPropositions.length === 0
          ? h('div', { className: 'lh-empty-graph' },
            h('h3', null, t('noGraphTitle')),
            h('p', null, t('noGraphBody')))
          : h(React.Fragment, null,
            h('div', { className: 'lh-canvas', style: { height: 440 } },
              h('div', {
                className: 'lh-canvas-inner',
                style: { width: Math.max(view.width, 320), height: Math.max(view.height, 200) },
              },
              h('svg', { className: 'lh-edges', width: '100%', height: '100%', 'aria-hidden': true },
                view.edges.map((edge, index) => h('path', {
                  key: `${edge.id}-${index}`,
                  d: edge.d,
                  className: `lh-edge lh-edge-graph${selectedProp !== '' && (edge.from === selectedProp || edge.to === selectedProp) ? ' lh-edge-active' : ''}`,
                }))),
              view.placed.map(item => h('button', {
                key: item.id,
                type: 'button',
                className: `lh-prop${item.id === selectedProp ? ' lh-prop-selected' : ''}`,
                style: { left: item.x, top: item.y },
                onClick: () => onSelect(item.id === selectedProp ? '' : item.id),
                'aria-pressed': item.id === selectedProp,
                title: item.text,
              }, item.text))),
              view.placed.length === 0 ? h('div', { className: 'lh-canvas-empty' }, t('noGraphTitle')) : null),
            proposition === null
              ? null
              : h('div', { className: 'lh-detail' },
                h('div', { className: 'lh-detail-head' },
                  h('strong', null, t('graphSelection')),
                  h('button', { className: 'lh-icon-btn', type: 'button', onClick: () => onSelect(''), 'aria-label': t('close') }, '×')),
                h('p', { className: 'lh-detail-text' }, proposition.text),
                h('p', { className: 'lh-detail-meta' }, `${t('premiseOf')} ${chainCount} ${t('chains')}`)),
            graph.truncated
              ? h('p', { className: 'lh-footnote' }, t('graphTruncated')
                .replace('{n}', String(shownPropositions.length))
                .replace('{total}', String(graph.total.propositions)))
              : null),
        h('footer', { className: 'lh-panel-foot' },
          h('div', { className: 'lh-legend' },
            h('span', null, h('i', { className: 'lh-swatch lh-dot-verified' }), t('verified')),
            h('span', null, h('i', { className: 'lh-swatch lh-dot-teaching' }), t('teaching')),
            h('span', null, h('i', { className: 'lh-swatch lh-dot-unseen' }), t('unseen'))),
          h('span', { className: 'lh-footnote' }, 'One profile · plain JSON under ~/.dsh/learnharness')))
    }

    /** Pure visual page: a snapshot plus selection and refresh callbacks. */
    function LearnView({
      selected, snapshot, error, selectedNode, selectedProp,
      onSelectNode, onSelectProp, onChooseLesson, onRefresh, t,
    }) {
      const lessons = snapshot?.lessons ?? []
      const activeSession = selected !== '' ? selected : snapshot?.selectedSessionId ?? ''
      const lesson = snapshot?.lesson ?? null
      const graph = snapshot?.graph ?? {
        propositions: [],
        chains: [],
        total: { propositions: 0, chains: 0 },
        truncated: false,
      }
      const plan = React.useMemo(() => planLayout(lesson?.nodes ?? []), [lesson])
      const shownPropositions = graph.propositions.slice(-80)
      const shownIds = new Set(shownPropositions.map(proposition => proposition.id))
      const shownChains = graph.chains.filter(chain => shownIds.has(chain.conclusionId))
      const view = React.useMemo(() => graphLayout(shownPropositions, shownChains), [graph])

      const content = snapshot === null
        ? h('div', { className: 'lh-loading' }, t('loading'))
        : lesson === null
          ? h('div', { className: 'lh-empty' },
            h('div', { className: 'lh-empty-art' }, h(LearnIcon, { size: 44 })),
            h('h2', null, t('noLessonTitle')),
            h('p', null, t('noLessonBody')))
          : h(React.Fragment, null,
            h('div', { className: 'lh-stats' },
              h('span', { className: 'lh-chip' }, `${lesson.nodes.filter(item => item.status === 'held' || item.status === 'verified').length}/${lesson.nodes.length} ${t('done')}`),
              h('span', { className: 'lh-chip' }, `${graph.total.propositions} ${t('propositions')}`),
              h('span', { className: 'lh-chip' }, `${graph.total.chains} ${t('chains')}`),
              h('span', { className: 'lh-chip lh-chip-quiet' }, `${t('updated')} ${when(snapshot.updatedAt)}`)),
            lesson.nodes.length === 0 ? h('div', { className: 'lh-seed' }, t('emptySeed')) : null,
            h('div', { className: 'lh-grid' },
              h(PlanSection, { lesson, plan, selectedNode, onSelect: onSelectNode, t }),
              h(GraphSection, { graph, shownPropositions, view, selectedProp, onSelect: onSelectProp, t })))

      return h('div', { className: 'lh-root' },
        h('style', null, CSS),
        h('div', { className: 'lh-head' },
          h('div', null,
            h('h1', { className: 'lh-title' }, t('title')),
            h('p', { className: 'lh-sub' }, t('subtitle'))),
          h('div', { className: 'lh-actions' },
            lessons.length > 0
              ? h('label', { className: 'lh-select-wrap' },
                h('span', { className: 'lh-select-label' }, t('lesson')),
                h('select', {
                  className: 'lh-select',
                  value: activeSession,
                  onChange: onChooseLesson,
                  'aria-label': t('plan'),
                }, lessons.map(item => h('option', { key: item.sessionId, value: item.sessionId },
                  `${item.goal || item.sessionId} · ${item.doneCount}/${item.nodeCount}`))))
              : null,
            h('button', { className: 'lh-btn', type: 'button', onClick: onRefresh }, t('refresh')))),
        error === ''
          ? null
          : h('div', { className: 'lh-banner', role: 'status' },
            h('span', null, `${t('loadFailed')} ${error}`),
            h('button', { className: 'lh-btn lh-btn-small', type: 'button', onClick: onRefresh }, t('retry'))),
        content)
    }

    /** @param {object} props page props from the main slot. */
    function LearnPage(props) {
      const t = props.t ?? (key => dictionaries.en[key] ?? key)
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [selectedNode, setSelectedNode] = React.useState('')
      const [selectedProp, setSelectedProp] = React.useState('')
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        let timer = 0
        const load = async () => {
          try {
            const response = await fetch(`${API}?session=${encodeURIComponent(selected)}`, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (!alive) return
            setSnapshot(data)
            setError('')
          } catch (failure) {
            if (!alive) return
            setError(failure?.message || t('loadFailed'))
          } finally {
            if (!alive) return
            timer = setTimeout(load, POLL_MS)
          }
        }
        load()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [selected, nonce])

      const chooseLesson = event => {
        setSelected(event.target.value)
        setSelectedNode('')
        setSelectedProp('')
      }

      return h(LearnView, {
        selected,
        snapshot,
        error,
        selectedNode,
        selectedProp,
        onSelectNode: setSelectedNode,
        onSelectProp: setSelectedProp,
        onChooseLesson: chooseLesson,
        onRefresh: () => setNonce(value => value + 1),
        t,
      })
    }

    const CSS = `
.lh-root { height: 100%; overflow-y: auto; box-sizing: border-box; padding: calc(24px + var(--dsh-frame-top-clearance, 0px)) clamp(18px, 3vw, 40px) 48px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.lh-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; max-width: 1280px; margin-inline: auto; }
.lh-title { margin: 0; font-size: 22px; line-height: 30px; font-weight: 600; letter-spacing: -0.01em; }
.lh-sub { margin: 3px 0 0; font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-secondary); }
.lh-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lh-select-wrap { display: inline-flex; align-items: center; gap: 8px; }
.lh-select-label { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.lh-select { max-width: min(46vw, 420px); border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-md, 8px); padding: 6px 8px; font: inherit; font-size: 13px; }
.lh-btn { border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-md, 8px); padding: 6px 12px; font: inherit; font-size: 13px; line-height: 18px; cursor: pointer; }
.lh-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lh-btn-small { padding: 3px 9px; font-size: 12px; }
.lh-banner { max-width: 1280px; margin: 0 auto 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; border: 0.5px solid var(--dsw-alias-state-error-primary); border-radius: var(--dsw-radius-md, 8px); color: var(--dsw-alias-state-error-primary); font-size: 13px; }
.lh-loading { max-width: 1280px; margin: 60px auto; color: var(--dsw-alias-label-secondary); font-size: 14px; }
.lh-stats { max-width: 1280px; margin: 0 auto 14px; display: flex; gap: 6px; flex-wrap: wrap; }
.lh-chip { font-size: 12px; line-height: 18px; padding: 4px 9px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.lh-chip-quiet { background: transparent; }
.lh-grid { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1080px) { .lh-grid { grid-template-columns: minmax(0, 1fr); } }
.lh-panel { min-width: 0; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.lh-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 13px 15px 11px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.lh-panel-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.lh-panel-sub { margin: 2px 0 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.lh-panel-count { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.lh-canvas { position: relative; overflow: auto; scrollbar-gutter: stable; background-image: radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--dsw-alias-border-l1) 70%, transparent) 1px, transparent 0); background-size: 22px 22px; }
.lh-canvas-inner { position: relative; min-width: 100%; }
.lh-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
.lh-edge { fill: none; stroke: var(--dsw-alias-border-l4); stroke-width: 1.3; }
.lh-edge-graph { stroke-dasharray: 3 4; opacity: 0.85; }
.lh-edge-active { stroke: var(--dsw-alias-brand-primary, #8d8d8d); stroke-width: 2; opacity: 1; }
.lh-node { position: absolute; width: 216px; height: 96px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; text-align: left; overflow: hidden; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.lh-node:hover { border-color: var(--dsw-alias-border-l4); }
.lh-node-selected { border-color: var(--dsw-alias-brand-primary, #8d8d8d); }
.lh-node-current { box-shadow: 0 0 0 2px color-mix(in oklab, var(--dsw-alias-brand-primary, #8d8d8d) 55%, transparent); }
.lh-node-held { border-left: 3px solid var(--dsw-alias-state-success-primary); }
.lh-node-verified { border-left: 3px solid var(--dsw-alias-state-success-primary); background: color-mix(in oklab, var(--dsw-alias-state-success-primary) 7%, var(--dsw-alias-bg-layer-2)); }
.lh-node-teaching { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
.lh-node-probing { border-left: 3px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.lh-node-blocked { border-left: 3px solid var(--dsw-alias-state-error-primary); }
.lh-node-top { display: flex; align-items: center; gap: 5px; font-size: 10px; line-height: 13px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.lh-node-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lh-node-title { font-size: 13px; line-height: 17px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lh-node-meta { font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lh-now { margin-left: auto; color: var(--dsw-alias-state-warn-primary); letter-spacing: 0; }
.lh-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-dimmed, #777); }
.lh-dot-held, .lh-dot-verified { background: var(--dsw-alias-state-success-primary); }
.lh-dot-teaching { background: var(--dsw-alias-state-warn-primary); }
.lh-dot-probing { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.lh-dot-blocked { background: var(--dsw-alias-state-error-primary); }
.lh-prop { position: absolute; width: 184px; height: 58px; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; line-height: 14px; text-align: left; overflow: hidden; cursor: pointer; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.lh-prop:hover { border-color: var(--dsw-alias-border-l4); }
.lh-prop-selected { border-color: var(--dsw-alias-brand-primary, #8d8d8d); box-shadow: 0 0 0 1.5px color-mix(in oklab, var(--dsw-alias-brand-primary, #8d8d8d) 45%, transparent); }
.lh-canvas-empty { padding: 28px; font-size: 13px; color: var(--dsw-alias-label-secondary); text-align: center; }
.lh-detail { border-top: 0.5px solid var(--dsw-alias-border-l1); padding: 12px 15px 13px; background: var(--dsw-alias-bg-layer-2); }
.lh-detail-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.lh-detail-head strong { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
.lh-icon-btn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.lh-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.lh-badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.lh-badge-held, .lh-badge-verified { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-success-primary) 40%, transparent); }
.lh-badge-teaching { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.lh-detail-meta { margin: 5px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.lh-detail-text { margin: 7px 0 0; font-size: 13px; line-height: 19px; }
.lh-detail-empty { margin: 7px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.lh-evidence { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.lh-evidence li { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); }
.lh-evidence-kind { color: var(--dsw-alias-label-primary); font-weight: 500; }
.lh-evidence-note { color: var(--dsw-alias-label-primary); }
.lh-evidence-time { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary)); }
.lh-panel-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 9px 14px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.lh-legend { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.lh-legend span { display: inline-flex; align-items: center; gap: 5px; }
.lh-swatch { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.lh-footnote { margin: 0; font-size: 10px; color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary)); }
.lh-empty { max-width: 560px; margin: 14vh auto 0; text-align: center; }
.lh-empty-art { display: flex; justify-content: center; margin-bottom: 14px; color: var(--dsw-alias-label-secondary); }
.lh-empty h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.lh-empty p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.lh-seed { max-width: 1280px; margin: 0 auto 12px; padding: 10px 13px; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.lh-empty-graph { padding: 26px 20px; }
.lh-empty-graph h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.lh-empty-graph p { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.lh-root :focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.lh-root button, .lh-root select { font-family: inherit; }
`

    const exported = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en: dictionaries.en }), 'learnharness: locale')
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('panel'),
        }, LearnIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, LearnPage))
      },
    }
    // Present only for the offline render test; the module loader ignores it.
    if (globalThis.__LEARNHARNESS_TEST__) {
      exported.__test = { LearnView, planLayout, graphLayout }
    }
    return exported
  },
})
