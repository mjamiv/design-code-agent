# RLM Implementation Status

> **Last Updated:** January 13, 2026 (Phase 2.4 Complete)  
> **Based on:** "Recursive Language Models" by Zhang, Kraska & Khattab ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601))

---

## Executive Summary

The northstar.LM Agent Orchestrator now includes a full **RLM** implementation with **Phase 1: REPL Environment** and **Phase 2: True Recursion** complete. This enables intelligent query decomposition, parallel execution, response aggregation, in-browser Python code execution via Pyodide, and **synchronous recursive LLM calls from within Python code**.

| Component | Status | Notes |
|-----------|--------|-------|
| Query Decomposition | ✅ Complete | 4 strategies: direct, parallel, map-reduce, iterative |
| Sub-Query Execution | ✅ Complete | Parallel execution with concurrency control |
| Response Aggregation | ✅ Complete | LLM synthesis with source attribution |
| REPL Environment | ✅ Complete | Pyodide-based Python execution in Web Worker |
| Code Generator | ✅ Complete | Query classification, retry logic, few-shot examples |
| True Recursion | ✅ Complete | `sub_lm()` calls with SharedArrayBuffer sync, depth limit 3 |
| Async Fallback | ✅ Complete | Graceful degradation without SharedArrayBuffer |
| Train of Thought UI | ✅ Complete | Enhanced UI with step logging and progress callbacks |
| Unified Service Worker | ✅ Complete | COI + PWA merged into `sw.js` v4, no reload loops |
| Progress Callbacks | ✅ Complete | Real-time updates from RLM pipeline to UI |

---

## Phase 1: REPL Environment Foundation ✅ COMPLETE

### What Was Implemented

#### 1. REPL Worker (`js/rlm/repl-worker.js`)
- Web Worker running Pyodide v0.25.0
- Sandboxed Python execution environment
- Message-based communication with main thread
- Built-in Python API functions:
  - `partition(predicate)` - Filter agents by condition
  - `grep(pattern, field)` - Search agent content
  - `search_agents(query)` - Semantic search
  - `get_agent(id)` - Retrieve single agent
  - `list_agents()` - List all agents
  - `get_all_action_items()` - Aggregate action items
  - `get_all_summaries()` - Aggregate summaries
  - `FINAL(answer)` - Mark final answer
  - `FINAL_VAR(name)` - Return variable as final answer

#### 2. REPL Environment (`js/rlm/repl-environment.js`)
- Main interface for REPL operations
- Lazy initialization (Pyodide loads ~10MB on first use)
- Context synchronization with ContextStore
- Execution with configurable timeout
- Ready state management

#### 3. Code Generator (`js/rlm/code-generator.js`)
- LLM prompt generation for Python code
- Code validation and sanitization
- Output parsing for `FINAL()` and `FINAL_VAR()` tags
- Error handling and fallback logic

#### 4. Context Store Updates (`js/rlm/context-store.js`)
- `toPythonDict()` method for REPL integration
- Agent data export at multiple detail levels
- Relevance scoring for query-agent matching

#### 5. RLM Pipeline Integration (`js/rlm/index.js`)
- `initializeREPL()` - Lazy REPL initialization
- `processWithREPL()` - Code-assisted query handling
- `shouldUseREPL()` - Query routing logic
- REPL stats tracking

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Orchestrator                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐       │
│  │   Query     │     │   Context   │     │    Code     │       │
│  │ Decomposer  │     │    Store    │     │  Generator  │       │
│  └──────┬──────┘     └──────┬──────┘     └──────┬──────┘       │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│  ┌─────────────────────────────────────────────────────┐       │
│  │               RLM Pipeline (index.js)                │       │
│  │                                                       │       │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │       │
│  │  │Decompose│→ │ Execute │→ │Aggregate│→ │ Format  │  │       │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  │       │
│  │       │                                      ▲        │       │
│  │       │   ┌──────────────────────────────────┘        │       │
│  │       ▼   ▼                                           │       │
│  │  ┌─────────────────────────────────────────────────┐  │       │
│  │  │            REPL Environment                      │  │       │
│  │  │  ┌─────────────────────────────────────────┐    │  │       │
│  │  │  │         Web Worker (Pyodide)            │    │  │       │
│  │  │  │                                          │    │  │       │
│  │  │  │  agents_data = [...]  # From Context    │    │  │       │
│  │  │  │  result = analyze(agents_data)           │    │  │       │
│  │  │  │  FINAL(result)                           │    │  │       │
│  │  │  └─────────────────────────────────────────┘    │  │       │
│  │  └─────────────────────────────────────────────────┘  │       │
│  └───────────────────────────────────────────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Files Created/Modified

| File | Type | Description |
|------|------|-------------|
| `js/rlm/repl-worker.js` | New | Pyodide Web Worker |
| `js/rlm/repl-environment.js` | New | REPL interface class |
| `js/rlm/code-generator.js` | New | Code generation & parsing |
| `js/rlm/context-store.js` | Modified | Added `toPythonDict()` |
| `js/rlm/index.js` | Modified | REPL integration in pipeline |
| `orchestrator.html` | Modified | Pyodide preconnect, About section |
| `CLAUDE.md` | Modified | Documentation updates |

---

## Current Capabilities

### Query Routing

The RLM pipeline automatically routes queries based on complexity:

| Condition | Route | Strategy |
|-----------|-------|----------|
| ≤2 active agents, simple query | Legacy | Direct LLM call |
| 3+ agents, comparative query | RLM | Parallel decomposition |
| "all", "every", "across" keywords | RLM | Map-reduce |
| Code/calculation keywords | REPL | Python execution |
| Complex multi-part query | RLM | Iterative with follow-up |

### Decomposition Strategies

```javascript
// Direct - Simple queries, few agents
{ type: 'direct', subQueries: 1 }

// Parallel - Compare across agents
{ type: 'parallel', subQueries: N (one per relevant agent) }

// Map-Reduce - Aggregate across all
{ type: 'map-reduce', subQueries: N + 1 (gather + synthesize) }

// Iterative - Exploratory with uncertainty
{ type: 'iterative', subQueries: 2-3 (initial + follow-ups) }
```

### REPL Triggers

Queries containing these patterns trigger REPL-based processing:

- `"calculate"`, `"compute"`, `"count"`
- `"find all"`, `"list all"`, `"filter"`
- `"aggregate"`, `"sum"`, `"average"`
- `"python"`, `"code"`, `"script"`

---

## Phase 2: True Recursion ✅ COMPLETE

### What Was Implemented

#### Phase 2.1: Enhanced LLM Code Generation

**File: `js/rlm/code-generator.js`**

1. **Query Classification** - Automatic detection of query type:
   - `FACTUAL` - Simple fact-finding queries
   - `AGGREGATIVE` - Queries that gather data across meetings
   - `COMPARATIVE` - Queries comparing multiple meetings
   - `SEARCH` - Queries looking for specific content
   - `RECURSIVE` - Complex analysis requiring `sub_lm()`

2. **Retry Logic** - `generateWithRetry()` regenerates code on validation failure with error context

3. **Enhanced Examples** - Few-shot examples for each query type, including recursive patterns

#### Phase 2.2: True Recursion with `sub_lm()`

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                     Main Thread                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               REPL Environment                           │    │
│  │  - SharedArrayBuffer (64KB)                              │    │
│  │  - LLM callback handler                                  │    │
│  │  - Atomics.notify() to signal worker                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                            ▲                                     │
│                            │ SUB_LM request/response             │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │               REPL Worker (Pyodide)                      │    │
│  │  - Python sub_lm() function                              │    │
│  │  - Atomics.wait() for blocking                           │    │
│  │  - Depth tracking (MAX_DEPTH = 3)                        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**Key Components:**

1. **SharedArrayBuffer Sync** (`js/rlm/repl-worker.js`)
   - 64KB shared buffer for LLM responses
   - `Atomics.wait()` for synchronous blocking in worker
   - Response encoding/decoding via TextEncoder

2. **SUB_LM Handler** (`js/rlm/repl-environment.js`)
   - Receives `SUB_LM` messages from worker
   - Calls LLM via registered callback
   - Writes response to shared buffer
   - Signals worker via `Atomics.notify()`

3. **Python Integration** (`js/rlm/repl-worker.js`)
   ```python
   def sub_lm(query, context_slice=None):
       """Synchronous recursive LLM call."""
       if _current_depth >= MAX_DEPTH:
           raise RecursionError("Max depth exceeded")
       _current_depth += 1
       try:
           return _sub_lm_sync(query, context_slice)
       finally:
           _current_depth -= 1
   ```

4. **Pipeline Integration** (`js/rlm/index.js`)
   - `processWithREPL()` sets LLM callback before execution
   - Query classification for optimal code generation
   - Sub-LM stats tracking

### Browser Requirements

SharedArrayBuffer requires:
- HTTPS or localhost
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

**GitHub Pages Solution:** COI headers are now injected by the unified service worker (`sw.js`). The service worker adds COOP/COEP headers to all responses, enabling SharedArrayBuffer on static hosts like GitHub Pages.

**Fallback:** If SharedArrayBuffer is unavailable, `sub_lm()` returns placeholders that are processed after code execution completes.

### Files Modified

| File | Changes |
|------|---------|
| `js/rlm/code-generator.js` | Query classification, retry logic, recursive examples |
| `js/rlm/repl-worker.js` | SharedArrayBuffer sync, Python `sub_lm()` with depth tracking |
| `js/rlm/repl-environment.js` | SUB_LM handler, LLM callback, sync buffer management |
| `js/rlm/index.js` | Pipeline integration, progress callbacks, stats, exports |

---

## Phase 2.3: Enhanced Train of Thought & Service Worker Unification ✅ COMPLETE

### What Was Implemented

#### 1. Enhanced Train of Thought UI

The chat now displays a detailed, real-time train of thought during query processing:

```
┌─────────────────────────────────────────────┐
│ 🤖  RLM: Code-Assisted Analysis             │
├─────────────────────────────────────────────┤
│ → Query: "What decisions were made?"        │
│ 🏷️ Mode: REPL with 3 agents                 │
│ 🏷️ Query type: AGGREGATIVE (95% confidence) │
│ 🐍 Calling GPT to generate Python code      │
│ ✓ Python code generated (1 attempt)         │
│ ⚡ Executing Python in Pyodide sandbox       │
│ ✓ Python code executed successfully          │
│ 📊 Extracting FINAL answer from output       │
│ ✓ Response ready                             │
├─────────────────────────────────────────────┤
│ ⏳ Formatting...                             │
└─────────────────────────────────────────────┘
```

**Step Types with Icons:**
| Type | Icon | Color | Description |
|------|------|-------|-------------|
| `classify` | 🏷️ | Purple | Query classification |
| `decompose` | 🔀 | Blue | Query decomposition |
| `code` | 🐍 | Green | Code generation |
| `execute` | ⚡ | Amber | Execution |
| `recurse` | 🔄 | Pink | Recursive LLM calls |
| `aggregate` | 📊 | Cyan | Result aggregation |
| `success` | ✓ | Bright green | Completion |
| `warning` | ⚠️ | Orange | Warnings/fallbacks |

#### 2. Progress Callbacks from RLM Pipeline

The RLM pipeline now emits real-time progress updates:

```javascript
// Set progress callback
rlmPipeline.setProgressCallback((step, type, details) => {
    addThinkingStep(thinkingId, step, type);
});

// Pipeline emits progress at key stages:
// - Query classification
// - Code generation start/complete
// - Execution start/complete
// - Sub-LM calls
// - Aggregation
```

#### 3. Unified Service Worker

The COI and PWA service workers were merged into a single `sw.js`:

**Before (problematic):**
```
coi-serviceworker.js  ← Registered first, added headers
sw.js                 ← PWA caching, could conflict
→ Two SWs competing for same scope caused reload loops
```

**After (fixed):**
```
sw.js (v4)            ← Single SW handles both:
                         - COOP/COEP header injection
                         - PWA caching & offline support
```

**Key changes:**
- `addCOIHeaders()` function injects isolation headers
- `networkFirst()` and `cacheFirst()` wrap responses with headers
- Removed `coi-serviceworker.js` entirely
- Fixed `controllerchange` listener to prevent reload loops

### Files Modified

| File | Changes |
|------|---------|
| `js/orchestrator.js` | Enhanced thinking UI, progress callback integration |
| `js/rlm/index.js` | `setProgressCallback()`, `_emitProgress()` methods |
| `css/styles.css` | New thinking indicator styles with colors and animations |
| `sw.js` | COI header injection, version bump to 4 |
| `orchestrator.html` | Removed COI script, fixed reload logic |
| `index.html` | Fixed reload logic |

---

## Phase 3: Future Enhancements (Planned)

### Timeline Estimate

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| 3.1 Optimization & Caching | 1-2 days | Phase 2 ✅ |
| 3.2 Testing & Polish | 2-3 days | Phase 3.1 |
| **Total** | **3-5 days** | |

---

## Configuration Reference

```javascript
// js/rlm/index.js - RLM_CONFIG

{
    // Decomposition
    maxSubQueries: 5,        // Max sub-queries per decomposition
    minRelevanceScore: 2,    // Min score to include agent
    
    // Execution
    maxConcurrent: 3,        // Parallel execution limit
    maxDepth: 3,             // Max recursion depth for sub_lm calls
    tokensPerSubQuery: 800,  // Token budget per sub-query
    timeout: 30000,          // Execution timeout (ms)
    
    // Aggregation
    maxFinalLength: 4000,    // Max response length
    enableLLMSynthesis: true, // Use LLM to synthesize
    deduplicationThreshold: 0.7, // Similarity threshold
    
    // REPL
    enableREPL: true,        // Master REPL switch
    replTimeout: 30000,      // REPL execution timeout
    autoInitREPL: false,     // Lazy vs eager init
    preferREPL: false,       // REPL over decomposition
    subLmTimeout: 60000,     // Timeout for sub_lm calls
    
    // Feature Flags
    enableRLM: true,         // Master RLM switch
    fallbackToLegacy: true,  // Fallback on error
    enableSyncSubLm: true    // Enable synchronous sub_lm
}
```

---

## API Reference

### RLMPipeline

```javascript
const pipeline = getRLMPipeline(config);

// Load agents
pipeline.loadAgents(agentsArray);

// Process query
const result = await pipeline.process(query, llmCall, context);

// Check REPL status
const ready = pipeline.isREPLReady();
await pipeline.initializeREPL();

// Get statistics
const stats = pipeline.getStats();

// Reset
pipeline.reset();
```

### ContextStore

```javascript
const store = getContextStore();

store.loadAgents(agents);
store.getActiveAgents();
store.getAgentsForQuery(query); // Returns relevance-scored agents
store.toPythonDict();           // Export for REPL
```

### REPLEnvironment

```javascript
const repl = getREPLEnvironment(options);

// Set LLM callback for sub_lm calls (Phase 2.2)
repl.setLLMCallback(async (query, context) => {
    return await callLLM(query, context);
});

await repl.initialize();
const result = await repl.execute(pythonCode);
await repl.setContext(agentsData);

// Status checks
repl.isReady();
repl.isSyncEnabled();       // SharedArrayBuffer available?
repl.getCapabilities();     // Full capability info
repl.getSubLmStats();       // sub_lm call statistics

repl.terminate();
```

---

## Metrics & Monitoring

The RLM pipeline tracks these metrics:

```javascript
pipeline.getStats();
// Returns:
{
    queriesProcessed: 42,
    totalSubQueries: 156,
    avgExecutionTime: 2340,  // ms
    strategies: {
        direct: 12,
        parallel: 18,
        'map-reduce': 8,
        iterative: 4
    },
    replExecutions: 15,
    replErrors: 2,
    subLmCalls: 28,        // Phase 2.2
    subLmErrors: 1,
    repl: {
        isReady: true,
        syncEnabled: true,
        subLm: {
            totalCalls: 28,
            successfulCalls: 27,
            failedCalls: 1,
            avgTime: 1250
        },
        capabilities: {
            syncEnabled: true,
            sharedArrayBufferSupported: true,
            maxRecursionDepth: 3
        }
    }
}
```

---

## Known Limitations

1. **Pyodide Size**: ~10MB initial download (cached after first load)
2. **No NumPy/Pandas**: Only standard library available in REPL
3. **SharedArrayBuffer Requirements**: Requires HTTPS and COOP/COEP headers for sync sub_lm
4. **Context Size**: Large agent data may slow REPL operations
5. **No Persistence**: REPL state resets on page reload
6. **Recursion Depth**: Limited to 3 levels to prevent runaway LLM calls

---

## Next Steps

1. **Immediate**: Add result caching for repeated queries
2. **Short-term**: Implement progress indicators during sub_lm execution
3. **Medium-term**: Token optimization and batch similar sub-queries
4. **Long-term**: Explore fine-tuning for domain-specific code generation

---

## References

- [RLM Paper](https://arxiv.org/abs/2512.24601) - Zhang, Kraska & Khattab
- [Pyodide Documentation](https://pyodide.org/en/stable/)
- [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
