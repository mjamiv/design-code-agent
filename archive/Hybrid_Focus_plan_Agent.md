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
### Milestone 1 — Data Model + SWM Capture (No behavior change) ✅ Complete
- Implement memory schema and storage APIs.
- Add SWM capture at end of each assistant completion.
- Store slices without changing prompt assembly.
- Note: `js/rlm/memory-store.js` added with `MemoryStore` capture logic.
- Note: `js/rlm/index.js` now instantiates `memoryStore`, calls `_captureMemory()` for `process`, `_legacyProcess`, and `processWithREPL`, and exposes memory stats in `getStats()`/`reset()`.
- **Success criteria:** metrics show slice writes; no prompt assembly changes.

### Milestone 2 — Retrieval + Prompt Builder (Shadow mode)
- Add retrieval pipeline and prompt assembler.
- Run in shadow: build prompt but do not send to model.
- Log diffs: what would have been retrieved.
- **Progress update:** Stage B scoring now applies a redundancy penalty to down-rank frequently retrieved slices (see `js/rlm/memory-store.js`). The query decomposer now emits intent, data preference, and format constraints to inform routing, and the RLM pipeline can short-circuit to direct retrieval when slices are already tight (see `js/rlm/query-decomposer.js`, `js/rlm/index.js`). Orchestrator UI toggles reflect the shadow retrieval state and should remain scoped to `orchestrator.html` (not Agent Builder).
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
- **Progress update:** Prompt guardrails now trim overflow contexts, record guardrail telemetry, and fall back to SWM context when needed (see `js/rlm/index.js`). Guardrail telemetry should be surfaced via the Orchestrator debug UI only.
- **Success criteria:** zero prompt overflows in telemetry.

### Milestone 5 — Instrumentation + Debug Panel
- Add detailed token breakdown logs.
- Build Memory Debug Panel views.
- Attach Focus episode summaries to prompt logs for side-by-side review.
- **Success criteria:** operators can trace a response end-to-end.

### Milestone 6 — Evaluation + Rollout
- Run A/B tests and benchmarks.
- Ramp feature flags.
- **Success criteria:** p95 cost/latency improve and accuracy holds or rises.

---

## Milestone 3–6 Follow-up Schedule (Next up, in order)
1) **Milestone 3 — Focus Episodes (Shadow then gated)**
   - Add Focus API + triggers in `js/rlm/memory-store.js` or new focus module.
   - Keep shadow summaries logged and gated via feature flag.
   - **Acceptance:** summaries consistent with raw logs; no regressions in core flows.

2) **Milestone 4 — Guardrails + Token Budgeting**
   - Add preflight token estimator + auto-reduction in `js/rlm/index.js` and prompt utilities.
   - Enforce recursion caps + fallback to SWM-only on overflow risk.
   - **Acceptance:** zero prompt overflows in telemetry; stable latency.

3) **Milestone 5 — Instrumentation + Debug Panel**
   - Expose token breakdowns + retrieval diagnostics.
   - Build Memory Debug Panel UI in `orchestrator.html`, `js/orchestrator.js`, `css/styles.css`.
   - **Acceptance:** operators can trace a response end-to-end.

4) **Milestone 6 — Evaluation + Rollout**
   - Wire feature flags in `js/orchestrator.js`.
   - Document QA steps + A/B benchmark checklist.
   - **Acceptance:** p95 cost/latency improve and accuracy holds or rises during ramp.


## Additional Notes (Implementation Guidelines)
- **Backwards compatibility:** keep existing prompt path intact until Milestone 4.
- **Fallbacks:** if retrieval fails, default to SWM-only with minimal context.
- **Telemetry-first:** do not enable new behavior without logs.
- **Data retention:** keep raw logs for offline reprocessing until Focus proves stable.
- **Budget safety:** ensure minimum token reserve for the model response.

---

## Validation Notes (2026-01-16 Test Readout)
**Observed vs expected behavior (based on Milestones 1–3 so far):**
- **Direct mode** still shows very large input context sizes, which is expected because it bypasses RLM, retrieval, and Focus compression entirely.
- **RLM mode** shows sharply reduced input tokens, consistent with SWM capture, retrieval shadowing, and aggregation. This is expected with Milestone 2 shadow prompt builder enabled (no behavioral change, just telemetry).
- **Shadow Prompt + Focus Shadow** runs remain low-token and stable, which is expected because they do not alter the live prompt path; they only emit telemetry and focus summaries.
- **Focus Episodes** (when enabled) should stay low-token and primarily affect memory persistence, not prompt size, until Milestone 4 prompt budgeting is enforced.
- **Recent run** confirms the pattern: direct mode input tokens were orders of magnitude higher (~261k) while RLM modes stayed under ~1k input tokens, with focus shadow/episodes remaining stable and low-token.

**Interpretation:** The results align with current enhancements: shadow prompt and focus are emitting structured telemetry without changing the live prompt path. Any remaining latency/quality deltas should be evaluated once Milestone 4 guardrails are active.

**Latest run snapshot (2026-01-16T19:17–19:18Z):**
- **Direct mode** still shows very large input contexts (~261k tokens) with normal output size (~593 tokens) and expected higher total cost.
- **RLM modes** remain compact (≈846–914 input tokens) with output tokens ~541–669 and stable response times (~12.5–13.9s), indicating shadow prompt + focus telemetry are low-overhead.
- **Focus Shadow/Episodes** runs remain within similar token bands, reinforcing that focus summaries are not inflating live prompts in shadow mode.

---

## Usage Guidance: When to Use RLM, Shadow Prompt, Focus Shadow, Focus Episodes
**RLM (enableRLM = true)**
- **Use for:** Aggregation queries, long-thread synthesis, multi-source reconciliation, or when direct-chat context grows beyond a safe threshold.
- **Why:** RLM decomposes the query, bounds context per sub-query, and avoids long-context drift.
- **Trigger cues:** Input context > 8k tokens, “summarize many items,” multi-meeting or multi-phase analyses, or user asks for “themes,” “differences,” or “trade-offs.”

**Shadow Prompt (enableShadowPrompt = true)**
- **Use for:** Any traffic where you want retrieval telemetry without changing behavior.
- **Why:** It logs what would have been retrieved and how it affects token estimates so you can tune retrieval weights safely.
- **Trigger cues:** After every RLM call in shadow mode; also on legacy/direct flows for baseline comparison.

**Focus Shadow (enableFocusShadow = true)**
- **Use for:** Long or tool-heavy flows where you want to evaluate focus summaries without persisting them.
- **Why:** It validates Focus Episode quality in production without affecting memory state.
- **Trigger cues:** Tool-call bursts, recursive depth, or prompt-estimate budget pressure.

**Focus Episodes (enableFocusEpisodes = true)**
- **Use for:** Stable deployments after shadow validation shows reliable summaries.
- **Why:** It compresses long histories into durable “episode” memory slices, preventing context bloat.
- **Trigger cues:** After a phase completes (plan → execute → validate), after N tool calls, or when prompt size nears the budget threshold.

---

## Next Actions (Continue Milestones)
1) **Milestone 3 (Focus Episodes):** ✅ Shadow mode implemented. Next: Gate Focus Episodes behind feature flags and verify summary quality on real traffic.
2) **Milestone 4 (Guardrails):** ✅ Preflight estimator and auto-reduction implemented. Next: Turn on prompt budgeting in live calls to actively trim retrieval K and avoid overflow.
3) **Milestone 5 (Instrumentation):** Add UI telemetry for shadow prompt and focus summaries to compare with direct mode.
4) **Milestone 6 (Evaluation):** Formal A/B with latency/cost dashboards; require eval-gated acceptance.

**Bug Fixes Completed (2026-01-17):**
- ✅ Orchestrator file upload button double-trigger fix
- ✅ JavaScript syntax error fix (nullish coalescing with logical OR)
- ✅ Fallback handlers with longer timeout for module loading

---

## Frontend Alignment Plan (Fix for Misplaced Controls)
1) **Scope controls to Orchestrator only:** Keep RLM toggles, context gauge, and Memory Debug UI in `orchestrator.html` to match `js/orchestrator.js` bindings.
2) **Remove controls from Agent Builder:** Strip RLM/guardrail UI elements from `index.html` to avoid duplicate IDs and unsupported flows.
3) **Verify Milestone 2/4 wiring:** Confirm shadow retrieval metrics and guardrail telemetry render in Orchestrator, with no reliance on Agent Builder.
4) **Re-run UI sanity pass:** Ensure the Agent Builder still loads without orphaned UI, and Orchestrator continues to show telemetry panels.

---

## Detailed Plan to Finish Milestones 2–4

### Milestone 2 — Retrieval + Prompt Builder (Shadow → Real)
**Goal:** Build retrieval pipeline and prompt assembler, initially shadow-only.

1) **Define retrieval I/O**
   - Inputs: query type, tags/entities, recency window, K.
   - Outputs: ordered slices + scoring metadata.

2) **Stage A filter**
   - Filter by tags/entities/source_agent_ids/recency window.
   - Log candidate pool size for telemetry.

3) **Stage B scoring + diversity**
   - ✅ Apply scoring formula with redundancy penalty (implemented in `js/rlm/memory-store.js`).
   - Enforce per-agent and per-tag caps.

4) **Prompt assembly (shadow)**
   - Assemble prompt sections: System + State + Working + Retrieved + Local.
   - Log token estimates and “would include” slices.

5) **Shadow telemetry**
   - Log retrieval hits, token section sizes, and diffs vs baseline.

**Exit criteria:** retrieval logs populated; latency stable; no behavior change.

### Milestone 3 — Focus Episodes (Shadow then gated)
**Goal:** Add Focus API and triggers; validate summaries; gate enablement.

1) **Implement Focus API**
   - `start_focus`, `append_focus`, `complete_focus` returning structured outputs.

2) **Trigger logic**
   - Budget pressure, phase completion, tool-call count, recursive depth.

3) **Shadow mode first**
   - Generate summary but do not persist.
   - Emit telemetry for quality review.

4) **Gated persistence**
   - Feature flag to persist Focus Episodes.
   - Store episode summary + derived SWM slices.

5) **Quality validation**
   - Compare summaries vs raw logs for fidelity.

**Exit criteria:** summaries consistent; no regressions in core flows; safe gating.

### Milestone 4 — Guardrails + Token Budgeting
**Goal:** Enforce safe prompt sizes and recursion limits in live calls.

1) **Preflight token estimator**
   - ✅ Estimate section sizes before each call.
   - ✅ Calculate overflow risk.

2) **Auto-reduction logic**
   - ✅ Trim overflow contexts in guarded LLM calls.
   - Preserve State Block + Working Window.

3) **Recursion caps**
   - Max depth + max sub_lm calls.
   - Force Focus completion on threshold.

4) **Fallback behavior**
   - ✅ Fall back to SWM context when trimmed context is empty or over budget.

5) **Telemetry**
   - ✅ Log guardrail actions, trim deltas, and SWM fallback metadata.

**Exit criteria:** zero prompt overflows; stable latency in telemetry.

---

## 13) Reviewer Suggestions Plan (Routing, Latency, Eval, Intent Retrieval)

### A) Routing Rules by Query Type (Biggest Win)
**Goal:** Route queries to the most effective retrieval + execution strategy.

1) **Add query-type routing taxonomy**
   - Metrics/KPI lookup → prefer structured payloads (metrics/state) over transcript slices.
   - Selective extraction across meetings (decisions/risks/blockers/teaming) → default to RLM + SWM.
   - Format-constrained summarization (e.g., “6 bullets per topic”) → direct with strict template or RLM with capped scope + paging.

2) **Implement routing layer in decomposer**
   - ✅ Extend query classifier to emit `intent`, `format_constraints`, and `data_preference`.
   - Map classifier outputs to retrieval presets (structured vs slices vs hybrid).

3) **Prompt builder alignment**
   - Enforce template budgets for strict formatting requests.
   - Add paging for long multi-topic summaries.

**Exit criteria:** query routing decisions are visible in telemetry and influence retrieval strategy.

### B) Latency Wins Without Losing RLM
**Goal:** Reduce p50/p95 latency while retaining RLM strengths.

1) **Parallelize sub-executors**
   - Increase map-step concurrency where safe.
   - Add configurable concurrency cap per query type.

2) **Model tiering**
   - Use smaller models for decomposer/subtasks.
   - Reserve GPT-5.2 for aggregation/synthesis.

3) **Early-stop heuristics**
   - ✅ If retrieval returns ≤ N slices, skip full multi-call pipeline.
   - ✅ Short-circuit to direct synthesis on low-variance answers.

**Exit criteria:** lower latency telemetry without quality regressions on eval set.

### C) Evaluation Harness Beyond Logprob
**Goal:** Add lightweight evaluation to measure correctness and compliance.

1) **Define per-test rubric**
   - Coverage, correctness, formatting compliance, citations to meeting sources.

2) **Add eval runner**
   - ✅ Eval harness scaffold added (see `js/rlm/eval-harness.js`).
   - Manual scoring option + automated judge pass for regression checks.

3) **Track key metrics**
   - Format compliance rates.
   - Meeting coverage across relevant agents.

**Exit criteria:** eval reports include rubric scores and regression diffs per run.

### D) Intent-Tuned Retrieval Prompts (SWM)
**Goal:** Align SWM retrieval with intent-based tags.

1) **Intent → Tag mapping**
   - Sentiment → KPI/metrics tags first.
   - Risks → risk/constraint tags first.
   - Teaming → partners/contacts/pursuits tags first.

2) **Update SWM retrieval prompts**
   - Include intent tags in Stage A filter.
   - Score boosts for matched intent tags in Stage B.

**Exit criteria:** retrieval outputs show intent-tag alignment in telemetry.

---

## 14) Implementation Agent (Owner + Operating Protocol)

**Agent Name:** `RLM-Optimization-Driver`  
**Mission:** Implement the reviewer suggestions end-to-end, keeping routing, latency, eval, and intent-tuned retrieval aligned with telemetry and feature flags.

### Primary Responsibilities
1) **Routing & Intent**
   - Maintain classifier taxonomy.
   - Ensure routing → retrieval presets → prompt templates are consistent.

2) **Latency**
   - Own concurrency settings, model tiering, and early-stop heuristics.
   - Validate against latency telemetry.

3) **Evaluation**
   - Keep eval harness up to date with rubric + regression checks.
   - Track compliance and coverage metrics.

4) **Retrieval Quality**
   - Ensure SWM intent tags drive Stage A/B ranking.
   - Monitor tag drift and adjust weights.

### Operating Protocol
- **Before change:** update the “Session Update” section with planned changes.
- **After change (end of session):** record what shipped, telemetry deltas, and next actions.
- **Guardrail:** avoid shipping changes without telemetry visibility.

---

## 15) Session Update (End-of-Session Required)

### Session: 2026-01-17

**Completed This Session:**
- Fixed orchestrator file upload button double-trigger issue (removed conflicting `for` attribute)
- Fixed JavaScript syntax error: nullish coalescing (`??`) mixed with logical OR (`||`) requires parentheses per ECMAScript spec
- Added fallback handlers with longer timeout (1500ms) for slower module loading
- Improved accessibility with ARIA labels and `role="button"` on upload zone
- Updated README.md and CLAUDE.md with recent changes
- Verified RLM components table reflects all 12 modules in `js/rlm/`

**Current State:**
- Milestones 1-2 complete (Data Model + SWM Capture, Retrieval + Prompt Builder shadow mode)
- Milestone 3 (Focus Episodes) in progress - shadow mode implemented, gated persistence pending
- Milestone 4 (Guardrails) partially complete - preflight estimator and auto-reduction implemented
- Milestone 5-6 (Instrumentation + Evaluation) pending

**Planned Updates (Next Session):**
- Gate Focus Episodes behind feature flags and verify summary quality on real traffic
- Turn on prompt budgeting in live calls to actively trim retrieval K and avoid overflow
- Add UI telemetry for shadow prompt and focus summaries to compare with direct mode
- Map routing presets to structured payload vs transcript-heavy retrieval in prompt builder
- Add model tiering controls and telemetry for decomposer/aggregation calls
- Expand eval harness with rubric scoring + regression report output
- Update SWM retrieval Stage A/B with intent tag boosts
