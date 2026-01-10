# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

**northstar.LM** is a static web application that transforms meeting recordings, PDFs, or text into actionable insights using OpenAI's AI models. The entire application runs client-side with no backend server.

## Architecture

```
northstar.LM/
├── index.html          # Main application page (single-page app)
├── css/
│   └── styles.css      # All styling (dark theme with gold accents)
├── js/
│   └── app.js          # All application logic (ES Module)
├── .github/
│   └── workflows/
│       └── deploy.yml  # GitHub Pages deployment
└── static/             # Static assets
```

## Key Technical Decisions

### Client-Side Only
- No server-side code - everything runs in the browser
- User provides their own OpenAI API key (stored in localStorage)
- API calls go directly from browser to OpenAI

### OpenAI Models Used
| Purpose | Model |
|---------|-------|
| Audio Transcription | `whisper-1` |
| Text Analysis & Chat | `gpt-5.2` |
| Text-to-Speech | `gpt-4o-mini-tts` |
| Image Generation | `gpt-image-1.5` |

### Libraries (CDN-loaded)
- **docx.js** (`8.5.0`) - Client-side DOCX generation
- **PDF.js** (`4.0.379`) - Client-side PDF text extraction

## Common Development Tasks

### Running Locally
```bash
npx http-server -p 3000
# or
python -m http.server 3000
```

### Cache Busting
When modifying `app.js`, update the version parameter in `index.html`:
```html
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
    inputMode: 'audio', // 'audio', 'pdf', 'text', or 'url'
    isProcessing: false,
    results: null,
    metrics: null,
    chatHistory: [],
    urlContent: null
};
```

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

## Deployment

Automatic deployment via GitHub Actions on push to `main` branch. The app is served at: https://mjamiv.github.io/vox2txt/
