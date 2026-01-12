# northstar.LM

> Transform your meetings into actionable insights with AI

**Live Demo:** https://mjamiv.github.io/vox2txt/

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

## RLM-Lite: Intelligent Query Processing

The Agent Orchestrator is powered by **RLM-Lite** (Recursive Language Model), based on the paper ["Recursive Language Models"](https://arxiv.org/abs/2512.24601) by Zhang, Kraska & Khattab.

### How RLM-Lite Works

```mermaid
flowchart LR
    subgraph Input["📥 INPUT"]
        Q[User Query]
    end

    subgraph Decompose["1️⃣ DECOMPOSE"]
        D1[Classify Intent]
        D2[Select Strategy]
        D3[Generate Sub-Queries]
    end

    subgraph Execute["2️⃣ EXECUTE"]
        E1[Agent 1<br/>Sub-Query]
        E2[Agent 2<br/>Sub-Query]
        E3[Agent 3<br/>Sub-Query]
    end

    subgraph Aggregate["3️⃣ AGGREGATE"]
        A1[Collect Results]
        A2[Deduplicate]
        A3[Synthesize]
    end

    subgraph Output["📤 OUTPUT"]
        R[Final Response<br/>with Sources]
    end

    Q --> D1 --> D2 --> D3
    D3 --> E1 & E2 & E3
    E1 & E2 & E3 --> A1
    A1 --> A2 --> A3 --> R

    style Decompose fill:#1a2a1a,stroke:#4ade80,color:#fff
    style Execute fill:#1a1a2a,stroke:#a855f7,color:#fff
    style Aggregate fill:#2a1a1a,stroke:#ef4444,color:#fff
```

### Query Strategies

| Strategy | Trigger | How It Works |
|----------|---------|--------------|
| **Direct** | Simple query, ≤2 agents | Single LLM call with combined context |
| **Parallel** | Comparative queries | One sub-query per agent, run concurrently |
| **Map-Reduce** | "all", "every", "across" | Query each agent → synthesize results |
| **Iterative** | Exploratory queries | Initial query → follow-up if uncertain |

### Benefits

- **Token Efficiency**: ~50-60% reduction vs. sending all context in one call
- **Better Accuracy**: Focused sub-queries yield more precise answers
- **Scalability**: Handle 50+ meetings without hitting context limits
- **Source Attribution**: Know which meeting each insight came from

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
- **Export Agent** - Save your analyzed meeting as a portable markdown file (~90 KB)
- **Import Agent** - Load a previously exported agent to restore the full session
- Enables building a library of meeting agents for future reference

### Meeting Orchestrator
- **Multi-Agent Coordination** - Load multiple meeting agents simultaneously
- **RLM-Lite Powered** - Intelligent query processing with decomposition, parallel execution, and aggregation
- **Cross-Meeting Analysis** - Ask questions that span multiple meetings with automatic source attribution
- **Pattern Recognition** - Identify trends and connections across sessions
- **Knowledge Base Visualization** - Visual chain display of loaded agents with enable/disable controls
- **Smart Query Routing** - Automatically chooses optimal strategy (direct, parallel, map-reduce, iterative)
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

### Usage Metrics
Collapsible panel with real-time tracking of:
- Token usage (input/output)
- TTS character count
- DALL-E image count
- Estimated cost breakdown by API call

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
| GPT-5.2 Input | $2.50 / 1M tokens |
| GPT-5.2 Output | $10.00 / 1M tokens |
| GPT-5-mini Input | $0.40 / 1M tokens |
| GPT-5-mini Output | $1.60 / 1M tokens |
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
