# LearnHarness for DeepSeek Harness

A local DSH bundle that adds a **Tutor** preset and a **Learn** page. The tutor
measures what you already hold, plans the smallest dependency path to your goal,
teaches one reasoning step at a time with a check after each, and records the
propositions and reasoning chains you establish in a persistent knowledge graph.

This is an independent reimplementation of the teaching loop from
[LearnHarness](https://github.com/amosblomqvist/learnharness) on top of DSH's
session, question, storage, and UI primitives. It does not include the
LearnHarness app, its agent runtime, or its extraction pipeline, and it is not
affiliated with or endorsed by that project.

## What you get

- **Tutor preset.** Choose it when starting a session. It has no shell and no
  write tools: a persona plus read-only file access, `ask_user_question`, and
  four learning tools.
- **Four tools.**
  - `learn_state` — goal, plan, statuses, recent evidence, relevant graph.
  - `learn_plan` — create or revise the dependency plan.
  - `learn_checkpoint` — record a probe, check, or practice outcome.
  - `learn_graph` — query or commit propositions and reasoning chains.
- **Learn page.** A sidebar entry opens a visual page with the lesson's
  dependency DAG (statuses and evidence) and the profile's knowledge graph.
- **One profile.** Lessons and the graph live in one local JSON file, so every
  session shares the same knowledge.

## Install

The bundle is a local directory; DSH installs it as a linked plugin.

1. Open **Plugins → Add plugin** and choose this directory, or run the
   `plugin_manager` `install_bundle` action with the absolute path.
2. The **Tutor** preset appears in the preset roster. Existing sessions keep
   their preset; start a new session to use it.
3. Click **Learn** in the left sidebar to open the plan and graph page.

The bundle has no dependencies and no build step.

Check that the Host half is live:

```bash
# replace 8081 with the port your DSH Web UI uses
curl http://127.0.0.1:8081/learnharness/health
# {"ok":true,"version":1,"lessons":0,"propositions":0,"chains":0}
```

## Use

1. New session → preset **Tutor**.
2. Say what you want to understand, for example: "I want to understand why
   minibatch gradients are unbiased."
3. Answer the probes and checks. The tutor records evidence and advances the
   plan; the Learn page updates while you work.
4. At the end of a lesson the tutor commits the claims and chains to the graph.
   The next lesson starts from that graph instead of from nothing.

## Data

`$DSH_HOME/learnharness/learn.json` (normally `~/.dsh/learnharness/learn.json`),
`0600`, pretty-printed:

```json
{
  "version": 1,
  "lessons": {
    "session-…": {
      "goal": "…",
      "nodes": [{ "id": "…", "title": "…", "deps": [], "status": "verified", "evidence": [] }]
    }
  },
  "graph": {
    "propositions": [{ "id": "p_…", "text": "…", "sessionId": "…" }],
    "chains": [{ "id": "c_…", "premiseIds": ["p_…"], "conclusionId": "p_…" }]
  }
}
```

Set `DSH_LEARNHARNESS_DIR` to store it elsewhere. Removing the bundle does not
remove the file; reinstalling picks it up.

## Limits

- One learner profile; there is no profile switcher.
- Practice is manual. A separate practice preset and spaced review are not
  included.
- The graph is built by `learn_graph commit` at lesson boundaries; there is no
  background extractor or LLM identity audit yet.
- The visual page is read-only; the tutor tools are the only writers.
- The tutor relies on the configured DSH model and its tool-calling behavior.

## Development

```bash
node --test test/*.test.js   # store: validation, statuses, graph, persistence
```

`lib/store.js` is plain Node and has no DSH imports. `index.js` is the Host
half (store service + `/learnharness/api`), `tutor.js` is the preset plugin,
`client.js` is the Learn page.

## License

MIT.
