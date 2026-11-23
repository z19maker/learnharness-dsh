# LearnHarness

A Tutor preset and a visual Learn page for DSH.

## What it does

The tutor runs a learning loop rather than answering questions:

1. **Measure** — probe what the learner already holds, and how confident they are.
2. **Plan** — build the smallest dependency map from that edge to the goal.
3. **Teach** — one reasoning step, one check, repair before continuing.
4. **Practice** — a problem that requires the knowledge without naming it.
5. **Carry forward** — commit the propositions and reasoning chains to a graph
   that the next session can read.

The **Learn** page shows the current lesson plan as a status DAG, the evidence
behind each node, and the profile's proposition/chain graph. It updates while a
lesson runs.

## The Tutor preset

The preset contains a replacing persona, the LearnHarness method section, the
four learning tools, `ask_user_question`, read-only file tools, and compaction.
It deliberately has no shell and no write tools.

Start a new session, choose **Tutor**, and describe what you want to understand.
The tools are available only in that preset.

## Where the data lives

One profile, one file: `$DSH_HOME/learnharness/learn.json`. It is plain,
pretty-printed JSON with lessons keyed by session and a graph of propositions
and chains. Set `DSH_LEARNHARNESS_DIR` to move it.

Removing the bundle leaves the data in place.

## Limitations

- One learner profile; no switcher.
- Practice is manual; no scheduled review.
- Graph commits happen at lesson boundaries; no background extraction yet.
- The page is read-only.
- Question answers are options plus free text, not a bespoke confidence UI.
