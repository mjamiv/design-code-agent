# northstar.LM

> Transform your meetings into actionable insights with AI

**Live Demo:** https://mjamiv.github.io/vox2txt/

## Contents
- [RLM Evaluation Report](#rlm-evaluation-report)

## Overview

northstar.LM consists of two main applications:

- **Agent Builder** (`index.html`) - Analyzes recordings, videos, documents, images, and text to create intelligent meeting agents with AI-powered insights
- **Agent Orchestrator** (`orchestrator.html`) - Combines multiple agents for cross-meeting analysis using the RLM (Recursive Language Model) pipeline

## Recent Updates

### January 2026
- **Bug Fixes:**
  - Fixed orchestrator file upload button double-trigger issue (dialog opening and immediately closing)
  - Fixed JavaScript syntax error with nullish coalescing operator (`??`) mixed with logical OR (`||`)
  - Added fallback handlers for orchestrator controls when module loading is delayed
  - Improved accessibility with ARIA labels and keyboard navigation for upload zone

- **RLM Optimizations:**
  - Added intent-based query routing with data preference and format constraint classification
  - Implemented early-stop heuristics to skip full pipeline when retrieval returns few slices
  - Added eval harness scaffold for quality benchmarking (`js/rlm/eval-harness.js`)
  - Stage B scoring now applies redundancy penalty to down-rank frequently retrieved slices
  - Cached retrieval slices, prompt templates, and context slices to reduce repeated work
  - Query cache keys now include a corpus stamp to avoid stale hits after agent changes
  - Parallel/map-reduce sub-queries now run via a worker pool with higher concurrency
  - Shadow prompt diagnostics run asynchronously so hybrid mode doesn't block the response
  - Model tiering uses GPT-5-mini for sub-queries and REPL sub_lm calls when GPT-5.2 is selected
  - Summary prompts cap sub-query fan-out and use a lighter retrieval preset to reduce tail latency
  - Per-stage timing telemetry (decompose/retrieve/execute/aggregate/shadow) now lands in metrics and CSV export
  - Memory debug shows retrieval cache hit rate for cache discipline checks
  - Shadow retrieval now mirrors routing presets (intent tags + max slice caps), with optional config diff logging
  - Focus episode slices are tagged internal and excluded from retrieval by default to avoid prompt contamination
  - Metrics now separate unique sub-calls from retries in the UI and CSV exports
  - Test runs store canonical prompt-set metadata in analytics and HTML exports

- **Core Features:**
  - Agent export embeds a full JSON payload (processing metadata, prompts, metrics, chat history, artifacts, attachments) alongside the markdown summary
  - Imports now restore richer session state, and the Orchestrator consumes the embedded payload to enrich cross-meeting context without loading base64 blobs
  - GitHub Pages deploy now copies optional asset folders when present (e.g., `images/`, `flowcharts/`, `static/`) to avoid build failures
  - RLM now builds **signal-weighted chat history** (state block + working window + retrieved memory slices) to keep recursive prompts focused and within token budgets
  - Hybrid focus + shadow prompting adds structured diagnostics: a compact focus window drives live reasoning while a parallel shadow prompt logs retrieval slices and guardrail telemetry without affecting user-facing outputs
  - Orchestrator modes now let you choose between Direct chat, RLM with signal-weighted memory, or RLM with hybrid focus + shadow diagnostics

## Application Workflow

```mermaid
flowchart TB
    subgraph Input["📥 INPUT SOURCES"]
        A1[🎤 Audio<br/>MP3, WAV, M4A, OGG, FLAC]
        A2[🎥 Video<br/>MP4, WebM, MPEG]
        A3[📄 PDF<br/>Text & Scanned]
        A4[📷 Image<br/>JPG, PNG, WebP, GIF]
        A5[📝 Text<br/>Paste or Type]
        A6[🌐 URL<br/>Web Scraping]
        A7[⌚ Wearable<br/>Coming Soon]
        A8[📥 Agent Import<br/>.md Files]
    end

    subgraph Process["⚙️ CONTENT PROCESSING"]
        B1[Whisper API<br/>Audio/Video → Text]
        B2[PDF.js<br/>PDF → Text]
        B3[GPT-5.2 Vision<br/>Image/Scanned PDF → Text]
        B4[URL Parser<br/>HTML → Text]
    end

    subgraph Analysis["🧠 AI ANALYSIS (GPT-5.2)"]
        C1[Generate Summary]
        C2[Extract Key Points]
        C3[Identify Action Items]
        C4[Analyze Sentiment]
    end

    subgraph Results["📊 RESULTS DASHBOARD"]
        D0[📈 KPI Dashboard<br/>6 Key Metrics]
        D1[📝 Summary<br/>Collapsible Card]
        D2[🎯 Key Points<br/>Collapsible Card]
        D3[✅ Action Items<br/>Collapsible Card]
        D4[💭 Sentiment<br/>Analysis]
        D5[📜 Transcript<br/>Full Text]
    end

    subgraph Features["✨ ENHANCED FEATURES"]
        E1[🔊 Audio Briefing<br/>Custom TTS with gpt-4o-mini-tts]
        E2[🎨 Infographic<br/>DALL-E Generated Visual]
        E3[💬 Chat with Data<br/>Ask Questions via GPT-5.2]
        E4[📄 DOCX Export<br/>Professional Formatted Report]
    end

    subgraph Agent["🤖 AGENT SYSTEM"]
        F1[🤖 Export Agent<br/>Custom Name + .md File]
        F2[📥 Import Agent<br/>Restore Previous Session]
        F3[🎭 Agent Orchestrator<br/>Multi-Meeting Insights]
    end

    subgraph Reset["🔄 NEW ANALYSIS"]
        R1[Clear All State]
        R2[Reset UI & Files]
        R3[Start Fresh]
    end

    A1 & A2 --> B1
    A3 --> B2
    A3 -.->|Scanned PDF| B3
    A4 --> B3
    A5 --> Analysis
    A6 --> B4
    A8 --> Results

    B1 & B2 & B3 & B4 --> Analysis

    Analysis --> C1 & C2 & C3 & C4
    C1 & C2 & C3 & C4 --> Results

    D0 --> D1 & D2 & D3 & D4 & D5

    Results --> E1 & E2 & E3 & E4
    Results --> F1
    F1 --> F3
    F2 --> Results
    
    R1 --> R2 --> R3 --> Input

    style Input fill:#1a1f2e,stroke:#d4a853,color:#fff
    style Process fill:#1a2a1a,stroke:#4ade80,color:#fff
    style Analysis fill:#2a1a2a,stroke:#a855f7,color:#fff
    style Results fill:#1a2a3a,stroke:#60a5fa,color:#fff
    style Features fill:#2a2a1a,stroke:#fbbf24,color:#fff
    style Agent fill:#2a1a1a,stroke:#f87171,color:#fff
    style Reset fill:#1a1a2a,stroke:#22d3ee,color:#fff
```

## Agent Orchestrator Workflow

```mermaid
flowchart TB
    subgraph MainApp["📱 MAIN APP"]
        MA1[Complete Analysis]
        MA2[🤖 Export Agent Button]
        MA3[Name Your Agent Modal]
        MA4[Download .md File]
        MA1 --> MA2 --> MA3 --> MA4
    end

    subgraph Upload["📤 AGENT UPLOAD"]
        U1[Drag & Drop .md Files]
        U2[Multi-file Support]
        U3[Parse YAML Frontmatter<br/>version, created, source_type]
        U4[Extract Sections<br/>summary, keyPoints, actions]
    end

    subgraph KB["🧠 KNOWLEDGE BASE - Visual Chain"]
        direction LR
        K1["🟢 Agent 1<br/>──────<br/>Q4 Planning<br/>✓ Enabled"]
        K2["🟢 Agent 2<br/>──────<br/>Budget Review<br/>✓ Enabled"]
        K3["⚪ Agent 3<br/>──────<br/>Team Sync<br/>○ Disabled"]

        K1 -.-|dotted| K2
        K2 -.-|dotted| K3

        KC[Agent Controls<br/>Toggle · Rename · Remove]
    end

    subgraph RLM["🧠 RLM-LITE PIPELINE"]
        R1{3+ agents OR<br/>complex query?}
        R2[Legacy Path<br/>Single LLM Call]
        R3[Query Decomposer<br/>Classify & Strategize]
        R4[Sub-Executor<br/>Parallel Processing]
        R5[Aggregator<br/>Synthesize Results]
    end

    subgraph Chat["💬 MULTI-AGENT CHAT"]
        C0[Welcome Message<br/>+ Quick Action Buttons]
        C1[📋 Key action items]
        C2[🔗 Common themes]
        C3[✅ Main decisions]
        C4[User Query Input]
        C5[Thinking Indicator<br/>Decomposing... Analyzing... Aggregating...]
        C6[AI Response<br/>with Source Attribution]
    end

    subgraph Insights["📊 CROSS-MEETING INSIGHTS PANEL"]
        I1[🔗 Common Themes<br/>Recurring topics across meetings]
        I2[📈 Trends & Patterns<br/>Evolution of discussions]
        I3[⚠️ Risks & Blockers<br/>Shared challenges]
        I4[💡 Recommendations<br/>Strategic suggestions]
        I5[✅ Consolidated Actions<br/>All action items by priority]
    end

    MA4 -->|.md file| U1
    U1 --> U2 --> U3 --> U4
    U4 --> K1 & K2 & K3
    K1 & K2 & K3 --> KC

    KC -->|enabled agents| R1
    R1 -->|No| R2
    R1 -->|Yes| R3
    R3 --> R4 --> R5
    R2 --> C6
    R5 --> C6

    C0 --> C1 & C2 & C3
    C1 & C2 & C3 --> C4
    C4 --> C5 --> C6

    R5 --> Insights

    style MainApp fill:#1a2a1a,stroke:#4ade80,color:#fff
    style Upload fill:#1a3a1a,stroke:#22c55e,color:#fff
    style KB fill:#1a1f2e,stroke:#60a5fa,color:#fff
    style RLM fill:#2a1a2a,stroke:#d4a853,color:#fff
    style Chat fill:#1a2a3a,stroke:#a855f7,color:#fff
    style Insights fill:#2a2a1a,stroke:#fbbf24,color:#fff
```

## Orchestrator Processing Modes

Choose how the Orchestrator answers cross-meeting questions:

1. **Direct Chat (LLM only)**  
   - Single-model call using the combined meeting context.
   - No RLM decomposition or memory retrieval.

2. **RLM + Signal-Weighted Memory**  
   - Forces RLM routing with live SWM context (state block + working window + retrieved slices).
   - Focused retrieval prompt replaces the legacy full-context window.

3. **RLM + Hybrid Focus + Shadow Prompting**  
   - Uses RLM with live SWM context plus shadow prompts for diagnostics.
   - Focus tracking summarizes and logs high-signal episodes while keeping user outputs stable.

## RLM Evaluation Report

[Download the PDF report](sandbox:/mnt/data/RLM_Evaluation_Report.pdf)

### January 18, 2026 Update (full-bigger-newer run)

7 prompts × 3 modes (21 runs). RLM modes delivered large cost/token savings with higher latency:

- **Avg cost / prompt**: $0.126 (Direct) → $0.028 (RLM + SWM / Hybrid)
- **Avg tokens / prompt**: 68,158 (Direct) → ~19k (RLM modes, ~-72%)
- **Avg latency**: 12.8s (Direct) → 44.4s (SWM) / 47.2s (Hybrid) (~+247–269%)

**Recommendations:** Default to **RLM + SWM** for cost-sensitive cross-meeting synthesis. Use **Direct Chat** for time-critical responses. Reserve **Hybrid** for diagnostics/regression evaluation. Prioritize tail-latency controls (fan-out caps, retrieval depth budgets, and per-stage timing guardrails).

### 1. Executive Summary & Recommendations

#### What the data says (63 runs total)

Across all 3 test sets (small/med/large context), **RLM modes materially reduce token spend and cost**, but **increase latency**—primarily because they execute multiple sub-calls.

| Mode         | Avg input tokens | Avg total tokens | Avg cost / prompt | Avg latency | Avg sub-calls | Cost Δ vs Direct | Latency Δ vs Direct |
| ------------ | ---------------: | ---------------: | ----------------: | ----------: | ------------: | ---------------: | ------------------: |
| Direct Chat  |           68,428 |           69,031 |            $0.128 |       13.4s |           1.0 |                — |                   — |
| RLM + SWM    |           13,194 |           15,445 |            $0.055 |       27.9s |           6.0 |       **-57.4%** |           **+108%** |
| RLM + Hybrid |           13,321 |           15,495 |            $0.054 |       33.6s |          ~6.0 |       **-58.1%** |           **+150%** |

#### Recommendation (practical default)

* **Default**: **RLM + Signal-Weighted Memory** for most cross-meeting analysis (best value; lower latency than Hybrid).
* **Use Direct Chat** when response time matters more than cost (time-sensitive “chatty” interactions).
* **Use RLM + Hybrid Focus + Shadow** for **diagnostics, tuning, and regression evaluation**, not as the everyday default, because it carries the highest latency overhead.

### 2. Overview of Application

northstar.LM is built around two core apps: an **Agent Builder** (creates portable agents from meeting materials) and an **Agent Orchestrator** (runs cross-meeting analysis and Q&A).

The Orchestrator supports multiple query execution strategies—**direct**, **parallel**, **map-reduce**, **iterative**, and **REPL**—which is how it scales beyond single-context prompting.

Your test harness is already instrumented for analysis-quality telemetry (response time, token usage, cost, etc.) and exports results to CSV—exactly what the dataset reflects.

### 3. Test Evaluation & Results

#### What was tested

The README defines three processing modes (matching your Method 1/2/3 runs): **Direct Chat**, **RLM + Signal-Weighted Memory**, and **RLM + Hybrid Focus + Shadow**.

#### Token efficiency (biggest quantitative win)

The README claims token efficiency on the order of **~50–60% reduction** vs sending full context.
**Your measured results are stronger than that**:

* **~80% input token reduction** (68k → ~13k)
* **~77–79% total token reduction** (69k → ~15.5k)

This is the clearest “value of RLM” in the dataset: it dramatically compresses the prompt footprint while still producing richer outputs (output tokens increase ~3–4×).

#### Cost (directly tied to tokens)

Even with higher output length in RLM modes, the **input token collapse dominates**, yielding **~52–64% lower cost depending on test set**.

Per test set (avg cost / prompt):

* **Small context**: $0.135 → $0.054 (RLM+SWM), $0.049 (Hybrid)
* **Med context**: $0.123 → $0.059 (RLM+SWM), $0.058 (Hybrid)
* **Large context**: $0.126 → $0.051 (RLM+SWM), $0.054 (Hybrid)

#### Latency (main setback)

Latency increases primarily because RLM runs **~6 sub-calls per prompt** (vs 1 call for Direct). Your p95 latency spikes are also materially higher in RLM modes (notably in med/large context Hybrid, where p95 approaches ~80s).

This aligns with the architecture: SWM/HYBRID are doing orchestration work, not just “one big completion.”

#### Stability / runtime quality

No truncation, retries, or empty responses were observed in the captured dataset, which is good operationally (the system is stable under test load).

### 4. “Wow” Factor Analysis

#### 1) The “compression miracle”

The Orchestrator’s **Signal-Weighted Memory** structure (state block + short working window + retrieved memory slices) is doing real work: it’s precisely the kind of mechanism that explains why input tokens fall so hard in the RLM runs.

#### 2) Savings exceed the README headline

The README’s “50–60%” token efficiency claim is already compelling, but your measured test results are closer to **~77–81% reductions**, meaning RLM isn’t just marginally better—it’s a step change.

#### 3) Hybrid mode’s real value is *observability*

Hybrid Focus + Shadow is designed to add a tight “focus window” for live reasoning and a “shadow” channel for diagnostics/telemetry without affecting user-visible output. That’s not a user-facing wow; it’s a developer/operator wow (tuning, debugging, governance).

### 5. Recommendations to Enhance Tool (especially latency)

#### A. Latency reduction (highest ROI)

Status: items 1, 2, 3, and 5 are implemented; item 4 remains on the roadmap.

1. **Parallelize sub-calls by default where safe (done)**

   * The Orchestrator already supports “parallel” and “map-reduce” strategies. If subcalls are being executed sequentially in practice, the fastest win is concurrency.
2. **Make Hybrid diagnostics asynchronous (or user-toggle) (done)**

   * Hybrid is valuable, but it shouldn’t block the primary response path unless explicitly requested.
3. **Add caching (none was used in the dataset) (done)**

   * Cache retrieval slices, agent summaries, and repeated prompt templates.
4. **Tune / expand early-stop behavior (pending)**

   * The README mentions **early-stop heuristics** and other SWM optimizations; push these further so RLM can short-circuit back toward “Direct-like” latency when retrieval is light.
5. **Model-mix for orchestration (done)**

   * Run retrieval and intermediate subcalls on smaller/faster models; reserve the top model for final synthesis.

#### B. Control output cost (secondary but real)

RLM modes shift cost from input → output. Add response-length targets by query type:

* “Exec summary” (short)
* “Operational detail” (medium)
* “Deep audit” (long)

#### C. Recommended use cases (where RLM clearly wins)

Based on how the system is designed and what the metrics show:

* **Cross-meeting synthesis / trend detection / action-item rollups** (high-context tasks) — best match for RLM + SWM.
* **Large-scale meeting corpora (dozens of meetings)** where direct prompting becomes cost-prohibitive — aligns with the scalability intent in the README.
* **Diagnostics / governance / regression testing** — use Hybrid Focus + Shadow.

## RLM: Recursive Language Model

The Agent Orchestrator is powered by **RLM** (Recursive Language Model), based on the paper ["Recursive Language Models"](https://arxiv.org/abs/2512.24601) by Zhang, Kraska & Khattab.

### Hybrid Focus + Shadow Prompting

RLM now separates *execution focus* from *diagnostic context*:

- **Hybrid focus window** keeps the live prompt tight by prioritizing state summaries, active objectives, and the most recent high-signal turns.
- **Shadow prompt stream** mirrors retrieval slices and guardrail metadata in a parallel prompt used solely for logging and evaluation, so production responses stay stable while prompt quality is measured.
- **Telemetry-ready outputs** expose focus stats and shadow previews in the Orchestrator to support tuning, regression reviews, and token-budget governance.

```mermaid
flowchart TB
    subgraph Inputs["🧑‍💬 QUERY + RUNTIME SIGNALS"]
        Q[User query]
        G[Prompt budget + guardrails]
        M[Tool/Sub-LM counters]
    end

    subgraph Live["⚡ LIVE PROMPT PATH"]
        L1[Build SWM context<br/>state block + working window + retrieved slices]
        L2[Compose live prompt]
        L3[LLM response]
    end

    subgraph Focus["🎯 FOCUS TRACKER"]
        F1[Track turns + tool calls + recursion]
        F2[Trigger focus reason<br/>budget pressure · tool calls · recursive depth]
        F3[Generate focus summary]
        F4[(Persist episode?)<br/>shadow-only or stored]
    end

    subgraph Shadow["🌓 SHADOW PROMPT DIAGNOSTICS"]
        S1[Build shadow prompt<br/>same retrieval slices]
        S2[Token estimate + breakdown]
        S3[Retrieval diff + guardrail telemetry]
        S4[Orchestrator diagnostics panel]
    end

    Q --> L1 --> L2 --> L3
    Q -.-> S1
    L1 -.-> S1
    G --> L2
    G --> S2
    M --> F1
    L3 --> F1 --> F2 --> F3 --> F4
    S1 --> S2 --> S3 --> S4
```

### Complete RLM Architecture

```mermaid
flowchart TB
    subgraph UserInput["🎯 USER QUERY"]
        Q["What patterns emerge across all meetings?"]
    end

    subgraph Phase1["━━━━━━━━━━ PHASE 1: QUERY ANALYSIS ━━━━━━━━━━"]
        subgraph Classification["🏷️ QUERY CLASSIFICATION"]
            C1["Detect Type"]
            C2{"Query Type?"}
            C3["FACTUAL"]
            C4["COMPARATIVE"]
            C5["AGGREGATIVE"]
            C6["SEARCH"]
            C7["RECURSIVE"]
        end
        
        subgraph Strategy["📋 STRATEGY SELECTION"]
            S1["Direct Path"]
            S2["Parallel Path"]
            S3["Map-Reduce Path"]
            S4["REPL Path"]
        end
    end

    subgraph Phase2["━━━━━━━━━━ PHASE 2: EXECUTION ━━━━━━━━━━"]
        subgraph CodeGen["🐍 CODE GENERATION"]
            CG1["LLM generates Python"]
            CG2["Validate code safety"]
            CG3["Retry on failure"]
        end

        subgraph REPL["⚡ PYTHON REPL EXECUTION"]
            direction TB
            R1["Load meeting context"]
            R2["Execute Python code"]
            R3{"sub_lm called?"}
            R4["Continue execution"]
            R5["Parse FINAL result"]
        end

        subgraph Recursion["🔄 RECURSIVE LLM CALLS"]
            direction TB
            RC1["Python blocks"]
            RC2["Send query to main thread"]
            RC3["Main thread calls GPT-5.2"]
            RC4["Write response to SharedBuffer"]
            RC5["Signal worker to resume"]
            RC6["Python receives result"]
        end
    end

    subgraph Phase3["━━━━━━━━━━ PHASE 3: OUTPUT ━━━━━━━━━━"]
        subgraph Response["📤 RESPONSE GENERATION"]
            O1["Format answer"]
            O2["Add source attribution"]
            O3["Return to user"]
        end
    end

    Q --> C1 --> C2
    C2 -->|simple| C3 --> S1
    C2 -->|compare| C4 --> S2
    C2 -->|aggregate| C5 --> S3
    C2 -->|find| C6 --> S3
    C2 -->|analyze| C7 --> S4

    S4 --> CG1 --> CG2 --> CG3 --> R1
    R1 --> R2 --> R3
    R3 -->|No| R4 --> R5
    R3 -->|Yes| RC1
    
    RC1 --> RC2 --> RC3 --> RC4 --> RC5 --> RC6
    RC6 --> R4
    
    R5 --> O1 --> O2 --> O3
```

### Synchronous sub_lm() - The Key Innovation

The breakthrough of Phase 2 is **true synchronous LLM calls from within Python code**:

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Main as Main Thread
    participant Worker as Web Worker
    participant Buffer as SharedArrayBuffer
    participant API as OpenAI GPT-5.2

    User->>Main: Submit query
    Main->>Main: Generate Python code via LLM
    Main->>Worker: Execute Python code
    
    rect rgb(40, 40, 60)
        Note over Worker: Python Execution
        Worker->>Worker: summaries = get_all_summaries()
        Worker->>Worker: analysis = sub_lm(query, summaries)
    end
    
    rect rgb(60, 40, 40)
        Note over Worker,API: Recursive LLM Call
        Worker->>Buffer: Store signal = 0
        Worker->>Main: POST SUB_LM request
        Worker->>Buffer: Atomics.wait() - BLOCKED
        Main->>API: Call GPT-5.2
        API-->>Main: Return response
        Main->>Buffer: Write response data
        Main->>Buffer: Set signal = 1
        Main->>Buffer: Atomics.notify()
        Buffer-->>Worker: UNBLOCKED
        Worker->>Buffer: Read response
    end
    
    rect rgb(40, 60, 40)
        Note over Worker: Continue with result
        Worker->>Worker: Use analysis result
        Worker->>Worker: FINAL(formatted_answer)
    end
    
    Worker-->>Main: Return final answer
    Main-->>User: Display response
```

### Multi-Level Recursive Reasoning

Python code can chain multiple `sub_lm()` calls for deep analysis:

```mermaid
flowchart TB
    subgraph Depth0["DEPTH 0: Initial Code Execution"]
        D0A["summaries = get_all_summaries()"]
        D0B["themes = sub_lm('Find themes', summaries)"]
    end

    subgraph Depth1["DEPTH 1: First Recursive Call"]
        D1A["Analyze themes across meetings"]
        D1B["Return: 'Budget, Hiring, Timeline'"]
    end

    subgraph Depth0Continue["DEPTH 0: Continue Execution"]
        D0C["Parse themes result"]
        D0D{"'budget' in themes?"}
        D0E["budget_analysis = sub_lm('Elaborate budget', themes)"]
        D0F["general_result = themes"]
    end

    subgraph Depth1Budget["DEPTH 1: Second Recursive Call"]
        D1C["Deep dive on budget concerns"]
        D1D["Return: 'Q4 budget needs approval...'"]
    end

    subgraph Depth0Final["DEPTH 0: Final Output"]
        D0G["FINAL(budget_analysis)"]
        D0H["Return to user"]
    end

    D0A --> D0B
    D0B -.->|"sub_lm()"| D1A
    D1A --> D1B
    D1B -.->|return| D0C
    D0C --> D0D
    D0D -->|Yes| D0E
    D0D -->|No| D0F --> D0G
    D0E -.->|"sub_lm()"| D1C
    D1C --> D1D
    D1D -.->|return| D0G
    D0G --> D0H
```

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Synchronous Calls** | Python blocks until LLM responds - use result immediately |
| **Multi-Level Depth** | Chain up to 3 recursive calls for complex reasoning |
| **Conditional Logic** | Branch based on LLM responses within same execution |
| **Error Recovery** | Retry with context on code generation failures |
| **GitHub Pages** | Unified `sw.js` v4 injects COOP/COEP headers, no reload loops |

### Signal-Weighted RLM Memory (New)

Recent RLM updates replace raw chat history with **signal-weighted memory** so recursive prompts stay concise while preserving decisions, actions, risks, and entities across turns.

```mermaid
flowchart TB
    subgraph Input["🧑‍💬 NEW USER QUERY"]
        Q1[User prompt]
        Q2[Tag classifier<br/>decisions • actions • risks • entities]
    end

    subgraph Capture["🧠 SIGNAL CAPTURE (per response)"]
        C1[Assistant response]
        C2[Summarize + sanitize]
        C3[Update state block<br/>Decisions, Actions, Questions, Constraints, Entities]
        C4[Memory index entry<br/>tags + recency score]
    end

    subgraph History["📚 SIGNAL-WEIGHTED HISTORY BUILDER"]
        H1[State block<br/>compact working memory]
        H2[Working window<br/>last 2 user turns + last summary]
        H3[Retrieved memory slices<br/>tag + recency scoring]
    end

    subgraph LivePrompt["🧠 LIVE RLM PROMPT"]
        R1[System prompt + SWM context]
        R2[Subquery execution]
    end

    subgraph ShadowPrompt["🌓 SHADOW PROMPT (DIAGNOSTICS)"]
        S1[Shadow prompt builder<br/>same SWM context]
        S2[Token estimate + retrieval stats]
        S3[Telemetry surfaced in UI]
    end

    Q1 --> Q2
    C1 --> C2 --> C3 --> C4
    Q2 --> H3
    C3 --> H1
    C2 --> H2
    H1 --> R1
    H2 --> R1
    H3 --> R1
    R1 --> R2
    H1 -.-> S1
    H2 -.-> S1
    H3 -.-> S1
    S1 --> S2 --> S3

    style Input fill:#1a1f2e,stroke:#60a5fa,color:#fff
    style Capture fill:#2a2a1a,stroke:#fbbf24,color:#fff
    style History fill:#1a2a3a,stroke:#a855f7,color:#fff
    style LivePrompt fill:#2a1a2a,stroke:#d4a853,color:#fff
    style ShadowPrompt fill:#1a2a2a,stroke:#22d3ee,color:#fff
```

### Enhanced Train of Thought

The orchestrator displays detailed real-time progress during query processing:

```mermaid
flowchart LR
    subgraph TrainOfThought["🤖 RLM: Code-Assisted Analysis"]
        direction TB
        S1["→ Query received"]
        S2["🏷️ Mode: REPL with 3 agents"]
        S3["🏷️ Query type: AGGREGATIVE"]
        S4["🐍 Generating Python code..."]
        S5["✓ Code generated"]
        S6["⚡ Executing in sandbox..."]
        S7["✓ Execution complete"]
        S8["📊 Extracting answer..."]
        S9["✓ Response ready"]
    end
    
    subgraph Pipeline["RLM Pipeline"]
        P1[processWithREPL]
        P2[_emitProgress]
    end
    
    Pipeline -->|callbacks| TrainOfThought
```

**Progress Types:**

| Icon | Type | Description |
|------|------|-------------|
| 🏷️ | classify | Query classification and mode selection |
| 🔀 | decompose | Breaking query into sub-queries |
| 🐍 | code | Python code generation via LLM |
| ⚡ | execute | Code execution in Pyodide sandbox |
| 🔄 | recurse | Recursive `sub_lm()` calls |
| 📊 | aggregate | Result synthesis and aggregation |
| ✓ | success | Step completed successfully |
| ⚠️ | warning | Fallback or retry triggered |

### Query Classification

| Type | Pattern | Example |
|------|---------|---------|
| **Factual** | Simple questions | "What was decided about the budget?" |
| **Comparative** | Compare, contrast, vs | "Compare Q3 and Q4 planning outcomes" |
| **Aggregative** | All, every, across | "Get all action items from every meeting" |
| **Search** | Find, search, where | "Find mentions of the new product launch" |
| **Recursive** | Analyze, patterns, why | "Analyze themes and explain their implications" |

### Query Strategies

| Strategy | Trigger | How It Works |
|----------|---------|--------------|
| **Direct** | Simple query, ≤2 agents | Single LLM call with combined context |
| **Parallel** | Comparative queries | One sub-query per agent, run concurrently |
| **Map-Reduce** | "all", "every", "across" | Query each agent → synthesize results |
| **Iterative** | Exploratory queries | Initial query → follow-up if uncertain |
| **REPL** | Complex analysis | Generate Python code with `sub_lm()` calls |

### Benefits

- **Token Efficiency**: ~50-60% reduction vs. sending all context in one call
- **Better Accuracy**: Focused sub-queries yield more precise answers
- **Scalability**: Handle 50+ meetings without hitting context limits
- **Source Attribution**: Know which meeting each insight came from
- **True Recursion**: Chain multiple LLM calls for deep analysis

## Overview

northstar.LM is a client-side web application that uses OpenAI's AI models to analyze meeting recordings, videos, PDFs, images, or text transcripts. Get instant KPI dashboards, summaries, key points, action items, sentiment analysis, audio briefings, and visual infographics—all processed in your browser with your own API key.

## Features

### KPI Dashboard
At-a-glance metrics displayed at the top of every analysis:
- **Sentiment** - Overall meeting tone (positive/negative/neutral)
- **Words Analyzed** - Total word count processed
- **Key Points** - Number of key insights extracted
- **Action Items** - Count of actionable tasks identified
- **Read Time** - Estimated time to review the transcript
- **Topics** - Number of distinct topics covered

### Core Analysis
- **Audio Transcription** - Upload MP3, WAV, M4A, OGG, FLAC, MP4, or WEBM files for automatic transcription using OpenAI Whisper
- **Video Transcription** - Upload MP4, WebM, or MPEG video files for audio extraction and transcription using Whisper
- **PDF Text Extraction** - Upload PDF documents for client-side text extraction using PDF.js
- **Image Upload & Vision AI** - Upload JPG, PNG, GIF, or WebP images for OCR and content extraction using GPT-5.2 Vision
- **Smart PDF Processing** - Automatically detects image-based PDFs and uses Vision AI for OCR when text extraction fails
- **Text Input** - Paste meeting notes or transcripts directly
- **URL Import** - Fetch and extract text content from any webpage URL
- **AI-Powered Analysis** - Generates summaries, key points, action items, and sentiment analysis using GPT-5.2

### Audio Briefing
- Generate a 2-minute executive audio summary using OpenAI GPT-4o-mini-TTS
- Choose from 6 voice options: Alloy, Echo, Fable, Onyx, Nova, Shimmer
- Download as MP3 for on-the-go listening

### Meeting Infographic
- Create visual infographics from meeting insights using GPT-Image-1.5
- Customize the style with your own prompt (e.g., "minimalist corporate with charts")
- High-quality 1024x1024 output
- Download as PNG

### Chat with Your Data
- Interactive AI chat powered by GPT-5.2-Thinking
- Full access to transcript and analysis results
- Ask follow-up questions about decisions, action items, participants
- Maintains conversation history for context-aware responses
- Token usage tracked in real-time metrics
- Rich markdown formatting in responses (styled lists, headings, code blocks, blockquotes)

### Agent Export/Import
- **Export Agent** - Save your analyzed meeting as a portable markdown file with embedded JSON payload (processing metadata, prompts, metrics, chat history, artifacts, attachments)
- **Import Agent** - Restore the full session state when the embedded payload is present (source metadata, metrics, chat history, audio/infographic previews)
- **Orchestrator Context** - The Orchestrator reads the export payload to provide richer cross-meeting answers without embedding base64 data

### Meeting Orchestrator
- **Multi-Agent Coordination** - Load multiple meeting agents simultaneously
- **RLM Powered** - Full Recursive Language Model with true recursive reasoning
- **Cross-Meeting Analysis** - Ask questions that span multiple meetings with automatic source attribution
- **Pattern Recognition** - Identify trends and connections across sessions
- **True Recursion** - Python REPL with synchronous `sub_lm()` calls for deep analysis
- **Query Classification** - Automatic detection of factual, comparative, aggregative, search, and recursive queries
- **Knowledge Base Visualization** - Visual chain display of loaded agents with enable/disable controls
- **Smart Query Routing** - Automatically chooses optimal strategy (direct, parallel, map-reduce, iterative, REPL)
- **Model Selection** - Choose between GPT-5.2, GPT-5-mini, or GPT-5-nano
- **Model Tiering** - Uses GPT-5-mini for sub-queries and REPL sub_lm calls when GPT-5.2 is selected
- **Reasoning Effort Control** - Configure reasoning depth for GPT-5.2 (none/low/medium/high/xhigh)
- **RLM Toggle** - Enable/disable RLM processing for A/B testing
- **Enhanced Metrics** - Detailed per-prompt logging with response storage and CSV export
- **GitHub Pages Compatible** - COI Service Worker enables full features on static hosts
- **Custom Branding** - Distinctive robot mascot logo representing the orchestrator's dual nature
- Access via the Orchestrator page: https://mjamiv.github.io/vox2txt/orchestrator.html

### Professional DOCX Export
Comprehensive meeting minutes document with:
- Professional headers and footers with branding
- Auto-generated Table of Contents
- Enhanced cover page with meeting details
- Styled sections with gold accent borders
- Native Word bullet and number lists
- Formatted tables for processing statistics
- Embedded infographic images
- Full chat Q&A history export
- Document metadata (author, title, keywords)

### Usage Metrics (Agent Orchestrator)
Enhanced metrics tracking in the Agent Orchestrator with detailed per-prompt logging:
- **Session Summary** - Total tokens, estimated cost, API call count, average response time
- **Per-Prompt Breakdown** - Detailed logs for each query including:
  - Model and effort level (GPT-5.2 only)
  - Processing mode (Direct, RLM, or REPL)
  - Token usage and costs (input/output breakdown)
  - Response time and confidence metrics
  - Unique sub-calls vs retry counts (to keep retry noise visible)
  - Stage timing breakdowns (decompose, retrieve, execute, aggregate, shadow)
  - Full response text stored for analysis
- **Confidence Tracking** - Logprobs-based confidence scores (GPT-5.2 with effort='none' only)
- **CSV Export** - Download complete metrics data including responses and stage timings for offline analysis
- **Auto-collapse** - Metrics card auto-collapses after 10 seconds (can be pinned open)

## Technology Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (ES Modules)
- **PWA Support**: Installable progressive web app with offline capabilities
- **Branding**: Custom logos for main app and Orchestrator page
- **AI Models**:
  - OpenAI Whisper (audio transcription)
  - GPT-5.2 (text analysis - summary, key points, actions, sentiment)
  - GPT-5.2 Vision (image OCR, visual content extraction, image-based PDF processing)
  - GPT-5.2-Thinking (chat/Q&A with meeting data)
  - GPT-4o-mini-TTS (text-to-speech)
  - GPT-Image-1.5 (image generation)
- **Libraries**:
  - [docx.js](https://docx.js.org/) - Client-side DOCX generation
  - [PDF.js](https://mozilla.github.io/pdf.js/) - Client-side PDF text extraction and page rendering
  - [marked.js](https://marked.js.org/) - Markdown parsing for chat message formatting
- **Deployment**: GitHub Pages (static hosting)

## Getting Started

1. Visit https://mjamiv.github.io/vox2txt/
2. Enter your OpenAI API key (stored locally in your browser)
3. Upload an audio file, video, PDF, image, or paste text
4. Click "Analyze Meeting"
5. The Setup & Input section auto-collapses to focus on results
6. Review KPI dashboard and detailed analysis
7. Optionally generate audio briefing and/or infographic
8. Chat with your data for deeper insights
9. Export as DOCX report or Agent file for future use

## Multi-Meeting Workflow

1. Analyze multiple meetings and export each as an Agent file
2. Visit the Orchestrator page
3. Load multiple agent files
4. Ask cross-meeting questions to find patterns and insights
5. Fine-tune models on accumulated agent files for project-specific AI

## Privacy & Security

- Your API key is stored locally in your browser's localStorage
- All API calls are made directly from your browser to OpenAI
- No data is sent to any third-party servers
- No server-side processing—everything runs client-side

## Cost Estimation

The app provides real-time cost estimates based on OpenAI's pricing:

| Model | Pricing |
|-------|---------|
| GPT-5.2 Input | $1.75 / 1M tokens |
| GPT-5.2 Output | $14.00 / 1M tokens |
| GPT-5-mini Input | $0.25 / 1M tokens |
| GPT-5-mini Output | $2.00 / 1M tokens |
| Whisper | $0.006 / minute |
| GPT-4o-mini-TTS | $0.015 / 1K characters |
| GPT-Image-1.5 Input | $10.00 / 1M tokens |
| GPT-Image-1.5 Output | $40.00 / 1M tokens |

## Local Development

```bash
# Clone the repository
git clone https://github.com/mjamiv/vox2txt.git
cd vox2txt

# Serve locally (any static file server works)
npx http-server -p 3000

# Open http://localhost:3000
```

## License

MIT License

---

Built with ❤️ using OpenAI APIs
