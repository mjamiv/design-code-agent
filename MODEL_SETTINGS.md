# Model Settings & RLM Toggle

This document describes the model selection, reasoning effort, and RLM toggle features added to the Agent Orchestrator.

## Overview

The Agent Orchestrator now includes a settings panel that allows users to:
1. Select between different GPT models
2. Configure reasoning effort (for GPT-5.2 only)
3. Toggle RLM (Recursive Language Model) processing on/off

These settings enable A/B testing to compare results between models and evaluate the effectiveness of the RLM pipeline.

## Model Selection

### Available Models

| Model | Description | Input $/1M | Output $/1M |
|-------|-------------|-----------|-------------|
| **GPT-5.2** | Full reasoning model with effort control | $2.50 | $10.00 |
| **GPT-5-mini** | Fast, cost-efficient for well-defined tasks | $0.25 | $2.00 |
| **GPT-5-nano** | Fastest, cheapest option | $0.05 | $0.40 |

### Model Capabilities

| Feature | GPT-5.2 | GPT-5-mini | GPT-5-nano |
|---------|---------|------------|------------|
| Reasoning Effort Control | ✅ | ❌ | ❌ |
| Custom Temperature | ✅* | ❌ | ❌ |
| RLM Pipeline Support | ✅ | ✅ | ✅ |

*\*Temperature is only available when reasoning effort is set to "None". Temperature and reasoning effort are mutually exclusive.*

## Reasoning Effort (GPT-5.2 Only)

The `reasoning_effort` parameter controls how deeply the model reasons before generating a response.

| Level | Description |
|-------|-------------|
| **None (Fast)** | Minimal reasoning, fastest response (API default) |
| **Low** | Light reasoning for simple queries |
| **Medium** | Balanced reasoning depth (UI default) |
| **High** | Thorough reasoning for complex tasks |
| **X-High** | Maximum reasoning depth (new in GPT-5.2) |

> **Note:** The Effort dropdown is only visible when GPT-5.2 is selected. GPT-5-mini and GPT-5-nano do not support this parameter.

### API Format

Per OpenAI 2026 guidance, the Chat Completions API uses a **top-level** `reasoning_effort` parameter:

```json
{
  "model": "gpt-5.2",
  "messages": [...],
  "max_completion_tokens": 4000,
  "reasoning_effort": "medium"
}
```

> **Important:** When `reasoning_effort` is set to any value other than "none", the `temperature` parameter is **NOT supported** and will cause an API error. Temperature can only be used when reasoning is disabled.

When effort is set to "None", the `reasoning_effort` parameter is omitted and `temperature: 0.7` is used instead.

## RLM Toggle

The RLM (Recursive Language Model) toggle enables or disables the recursive processing pipeline.

| Setting | Behavior |
|---------|----------|
| **On** (default) | Uses RLM pipeline for complex queries, REPL for code-assisted queries |
| **Off** | Bypasses RLM, uses direct query processing for all requests |

### Use Cases

- **RLM On**: Best for complex analytical queries that benefit from recursive decomposition
- **RLM Off**: Useful for:
  - Simple direct queries
  - A/B testing to evaluate RLM effectiveness
  - Comparing response quality with/without RLM processing

## Settings Persistence

All settings are automatically saved to `localStorage` under the key `northstar.LM_settings` and restored on page load.

```javascript
{
  "model": "gpt-5.2",
  "effort": "medium",
  "useRLM": true
}
```

## UI Location

The settings panel is located in the Orchestrator AI section, directly below the chatbot header:

```
┌─────────────────────────────────────────────┐
│  🤖 ORCHESTRATOR AI                         │
├─────────────────────────────────────────────┤
│  MODEL [GPT-5.2 ▼]  EFFORT [Medium ▼]  RLM ●│
├─────────────────────────────────────────────┤
│  Chat messages...                           │
└─────────────────────────────────────────────┘
```

## Implementation Files

| File | Changes |
|------|---------|
| `orchestrator.html` | Added settings panel HTML with dropdowns and toggle |
| `js/orchestrator.js` | Added state management, event handlers, API integration |
| `css/styles.css` | Added styling for settings panel and toggle switch |

## Changelog

| Date | Commit | Description |
|------|--------|-------------|
| 2026-01-13 | `8634cf9` | Initial implementation with GPT-5.2/GPT-5.2-mini |
| 2026-01-13 | `2210c75` | Changed to gpt-5-nano model |
| 2026-01-13 | `225d5d4` | Added gpt-5-mini as third option |
| 2026-01-13 | `05b5be8` | Fixed temperature param for mini/nano models |
