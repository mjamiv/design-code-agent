# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

**northstar.LM** is a client-side web application that transforms meeting recordings, PDFs, images, or text into actionable insights using OpenAI's AI models. The entire application runs client-side with no backend server. Features include multi-meeting orchestration, agent export/import, image OCR with Vision AI, and professional document generation.

## Architecture

```
northstar.LM/
├── index.html          # Main application page (single-page app)
├── orchestrator.html   # Multi-agent orchestrator page
├── manifest.json       # PWA manifest
├── sw.js               # Service worker for offline support
├── css/
│   └── styles.css      # All styling (dark theme with gold accents)
├── js/
│   ├── app.js          # Main application logic (ES Module)
│   └── orchestrator.js # Orchestrator page logic
├── static/             # Static assets
├── templates/          # Server templates (for Flask backend option)
└── .github/
    └── workflows/
        └── deploy.yml  # GitHub Pages deployment
```

## Key Technical Decisions

### Client-Side Only
- No server-side code required - everything runs in the browser
- User provides their own OpenAI API key (stored in localStorage)
- API calls go directly from browser to OpenAI

### OpenAI Models Used
| Purpose | Model |
|---------|-------|
| Audio Transcription | `whisper-1` |
| Text Analysis (Summary, Key Points, Actions, Sentiment) | `gpt-5.2` |
| Image/PDF Vision Analysis (OCR, content extraction) | `gpt-5.2` (vision) |
| Chat with Data (Q&A) | `gpt-5.2` (with reasoning) |
| Text-to-Speech | `gpt-4o-mini-tts` |
| Image Generation | `gpt-image-1.5` |

### Libraries (CDN-loaded)
- **docx.js** (`8.5.0`) - Client-side DOCX generation with professional formatting
- **PDF.js** (`4.0.379`) - Client-side PDF text extraction and page-to-image rendering

## Common Development Tasks

### Running Locally
```bash
npx http-server -p 3000
# or
python -m http.server 3000
```

### Cache Busting
When modifying CSS or JS, update the version parameters in HTML files:
```html
<link rel="stylesheet" href="css/styles.css?v=XX">
<script src="js/app.js?v=XX" type="module"></script>
```

### Adding New Features
1. Add HTML elements to `index.html`
2. Add element references in `init()` function's `elements` object
3. Add event listeners in `setupEventListeners()`
4. Implement functionality in `app.js`
5. Add styles to `styles.css`

## State Management

The app uses a simple state object:
```javascript
const state = {
    apiKey: '',
    selectedFile: null,
    selectedPdfFile: null,
    selectedImageFile: null,
    selectedImageBase64: null, // Base64-encoded image for Vision API
    inputMode: 'audio', // 'audio', 'pdf', 'image', 'text', or 'url'
    isProcessing: false,
    results: null,        // Contains transcription, summary, keyPoints, actionItems, sentiment
    metrics: null,        // API usage metrics
    chatHistory: [],      // Chat Q&A history
    urlContent: null,
    infographicBlob: null // Generated infographic image
};
```

## Key Functions

### KPI Dashboard
- `updateKPIDashboard()` - Populates the KPI cards at top of results
- Extracts: sentiment, word count, key points count, action items count, read time, topics

### Agent Export/Import
- `downloadAgentFile()` - Exports session as markdown with YAML frontmatter
- `importAgentFile()` - Restores session from exported agent file
- Agent files are portable markdown (~90 KB) containing all analysis data

### Image & Vision Analysis
- `analyzeImageWithVision()` - Sends image to GPT-5.2 Vision for OCR and content extraction
- `renderPdfPagesToImages()` - Converts PDF pages to base64 PNG images using canvas
- `analyzeImageBasedPdf()` - Detects image-based PDFs and processes via Vision API
- `fileToBase64()` - Converts uploaded image files to base64 data URLs

### DOCX Generation
- `downloadDocx()` - Creates professionally formatted Word document
- Includes: cover page, TOC, headers/footers, styled tables, embedded images

### Orchestrator
- `orchestrator.js` - Manages multiple loaded agents
- Cross-meeting chat queries all loaded agent data simultaneously

## API Patterns

### GPT-5.2 Chat Completions
```javascript
// Note: GPT-5.2 requires max_completion_tokens, not max_tokens
body: JSON.stringify({
    model: 'gpt-5.2',
    messages: [...],
    max_completion_tokens: 1000,
    temperature: 0.7
})
```

### Token Tracking
All API calls update `currentMetrics` object for cost calculation:
```javascript
currentMetrics.gptInputTokens += usage.prompt_tokens || 0;
currentMetrics.gptOutputTokens += usage.completion_tokens || 0;
```

## Styling Conventions

- CSS variables defined in `:root` for theming
- Color scheme: Dark navy (`#0a0e17`) with gold accents (`#d4a853`)
- Font families: 'Bebas Neue' for display, 'Source Sans 3' for body
- Animations use CSS transitions and keyframes
- KPI Dashboard uses 6-column responsive grid
- Collapsible sections use native `<details>` elements

## UI Components

### KPI Dashboard
```html
<div class="kpi-dashboard">
    <div class="kpi-item">
        <span class="kpi-icon">📊</span>
        <div class="kpi-content">
            <span class="kpi-label">Label</span>
            <span class="kpi-value" id="kpi-xxx">--</span>
        </div>
    </div>
</div>
```

### Collapsible Sections
```html
<details class="result-card">
    <summary class="card-header card-header-collapsible">
        <h3>Title</h3>
        <span class="collapse-toggle">▼</span>
    </summary>
    <div class="card-content">...</div>
</details>
```

## Deployment

Automatic deployment via GitHub Actions on push to `main` branch. 

**URLs:**
- Main App: https://mjamiv.github.io/vox2txt/
- Orchestrator: https://mjamiv.github.io/vox2txt/orchestrator.html

### Files Deployed
The GitHub Actions workflow copies these to `_site`:
- `index.html`, `orchestrator.html`
- `css/`, `js/`, `static/`
- `manifest.json`, `sw.js` (PWA files)
