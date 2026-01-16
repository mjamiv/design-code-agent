# Hybrid Focus + SWM Implementation Plan (Agent)

## 0) Definition of “Done” (Acceptance Criteria)
**Functional**
- RLM can recurse + use tools without context creep.
- Prompts remain within budget automatically (no manual truncation).
- Memory is accurate, structured, query-relevant, and auditable.
- Latency/cost outliers are reduced (p95 stable across sessions).

**Operational**
- Memory and prompt usage are observable (debug UI + logs).
- Safe fallbacks when budgets are exceeded or retrieval fails.
- Gradual rollout behind a feature flag keeps the app functional at all times.

---

## 1) Memory Architecture & Data Model (Source of Truth)
### 1.1 Memory Layers (hard capped budgets)
1) **State Block (SWM)**
   - Decisions, actions, risks, constraints, entities, open questions.
   - Most durable, always included (small budget, high signal).

2) **Working Window (SWM)**
   - Last 1–2 user turns + last assistant summary.
   - Ultra-small, always included.

3) **Retrieved Slices (SWM)**
   - Top-K atomic snippets from memory index.
   - Contextual and query-specific.

4) **Knowledge Episodes (Focus)**
   - “What happened / what we learned” checkpoints (sawtooth).
   - Replace raw logs after a completed phase.

### 1.2 Shared Memory Index Schema (expanded)
- `id`, `type` (decision/action/risk/entity/constraint/episode)
- `text`, `summary`
- `tags[]`, `entities[]`
- `source_agent_ids[]`, `source_tool_ids[]`
- `timestamp`, `recency_score`, `importance_score`
- `retrieval_count`, `last_retrieved_at`
- `token_estimate`
- `confidence` (0–1)
- `source_hash` (dedupe)
- Optional: `embedding_id`

---

## 2) Focus Episode API (Macro Compression / Garbage Collection)
### 2.1 API Surface
- `start_focus(label, objective)`
- `append_focus(event, source)`
- `complete_focus() → { episode_summary, learned_facts[], decisions[], actions[], risks[], entities[], constraints[], open_questions[] }`

### 2.2 Automatic Trigger Rules (priority order)
1) **Budget pressure**: projected prompt > 80% cap.
2) **Phase complete**: plan → execute → validate.
3) **Tool use**: after N tool calls (3–5).
4) **Recursive depth**: after N sub_lm calls (2–3).
5) **Termination cues**: “done / conclusion reached”.

### 2.3 Hard Behavior on Completion
- Drop raw logs from working history.
- Persist:
  - Episode summary (Knowledge Episode).
  - Structured SWM slices extracted from it.

---

## 3) SWM Capture (Micro Memory + Structure)
### 3.1 Per Assistant Completion
- Summarize + sanitize (remove fluff, collapse repetition).
- Extract structured slices:
  - decisions, actions, risks, entities, constraints, open questions.
- Update State Block (cap + merge).
- Write atomic slices into index (1 slice per atomic fact).

### 3.2 Dedup / Merge Rules
- Entity normalization (aliases → canonical).
- Decision state transitions (tentative → confirmed).
- Action updates (latest wins, older linked).
- Risk merges (similar risks unify, confidence updated).

---

## 4) Retrieval (Two-Stage Ranker)
### Stage A: Fast Filter
- Filter by tags/entities/source_agent_ids/recency window.

### Stage B: Scoring
```
score = w_tag + w_entity + w_recency + w_importance - w_redundancy
```
- Add anti-spam penalties (frequently retrieved or redundant).
- Diversity constraints:
  - ≤ X slices per agent
  - ≤ Y per tag group
  - Optional near-duplicate removal (hash/embedding)

---

## 5) Prompt Builder (Strict Budgeting)
For every LLM call (including sub_lm):
```
System + Task Instructions
+ State Block (capped)
+ Working Window (tiny)
+ Retrieved Slices (K)
+ Local Context (optional)
```

### Adaptive Budgets by Query Type
- **Factual**: low K, tight state.
- **Aggregative**: higher K but enforce map-reduce.
- **Recursive**: prioritize risks/constraints/entities.

---

## 6) RLM Integration (Strategy-aware Memory)
Extend query classifier to output:
- query type
- expected depth
- required memory tags
- recommended K
- Focus enabled or not

**Strategy Rules**
- **Direct**: SWM only.
- **Parallel / Map-Reduce**: SWM + retrieval per agent.
- **REPL**: Focus episodes enabled, SWM used each sub_lm, recursion caps.

---

## 7) Guardrails (Safety + Stability)
### Token Guardrails
- Preflight estimator before every call.
- Reduce retrieved slices if budget exceeded.
- Output caps per mode.

### Recursion Guardrails
- Max depth (e.g., 3).
- Max sub_lm calls per REPL job (e.g., 5).
- Force Focus completion after threshold.

### Memory Safety
- State Block must include unresolved/uncertainties.
- Confidence metadata stored where available.

---

## 8) Instrumentation & Metrics (Tuning)
Per prompt:
- Tokens by section (system/state/working/retrieval/local).
- Retrieval stats (K requested vs K used).
- Hit rate by tag group.
- Cost + latency.
- Quality proxies:
  - logprob if available
  - self-check uncertainty
  - user feedback

**Memory Debug Panel**
- Retrieved slices with scoring rationale.
- Current state block.
- Last Focus episodes.

---

## 9) Evaluation Plan (Before Rollout)
- Offline benchmark of retrieval quality.
- A/B test vs baseline (latency, cost, accuracy).
- Measure:
  - p50/p95 latency
  - average tokens per response
  - task accuracy (manual rating or rubric)

---

## 10) Rollout Strategy (Keep App Functional)
- Feature flag per user/project.
- Limited cohort → gradual ramp.
- Fallback to SWM-only if Focus fails.

---

## 11) Risks & Mitigations
- **Over-compression** → keep raw logs in cold storage.
- **Bad retrieval** → fallback to SWM-only.
- **Tag drift** → periodic reindex + normalization.

---

## 12) Implementation Order (Milestones)
### Milestone 1 — Data Model + SWM Capture (No behavior change)
- Implement memory schema and storage APIs.
- Add SWM capture at end of each assistant completion.
- Store slices without changing prompt assembly.
- **Success criteria:** metrics show slice writes; existing behavior unchanged.

### Milestone 2 — Retrieval + Prompt Builder (Shadow mode)
- Add retrieval pipeline and prompt assembler.
- Run in shadow: build prompt but do not send to model.
- Log diffs: what would have been retrieved.
- **Success criteria:** retrieval logs populated; latency stable.

### Milestone 3 — Focus Episodes (Shadow then gated)
- Add Focus API and triggers in shadow.
- Compare episode summaries vs raw logs.
- Gate enablement with feature flag.
- **Success criteria:** summaries consistent; no regressions in core flows.

### Milestone 4 — Guardrails + Token Budgeting
- Enforce preflight token estimator.
- Add auto-reduction of retrieval K.
- Add recursion caps.
- **Success criteria:** zero prompt overflows in telemetry.

### Milestone 5 — Instrumentation + Debug Panel
- Add detailed token breakdown logs.
- Build Memory Debug Panel views.
- **Success criteria:** operators can trace a response end-to-end.

### Milestone 6 — Evaluation + Rollout
- Run A/B tests and benchmarks.
- Ramp feature flags.
- **Success criteria:** p95 cost/latency improve and accuracy holds or rises.

---

## Additional Notes (Implementation Guidelines)
- **Backwards compatibility:** keep existing prompt path intact until Milestone 4.
- **Fallbacks:** if retrieval fails, default to SWM-only with minimal context.
- **Telemetry-first:** do not enable new behavior without logs.
- **Data retention:** keep raw logs for offline reprocessing until Focus proves stable.
- **Budget safety:** ensure minimum token reserve for the model response.
