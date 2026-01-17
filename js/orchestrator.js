/**
 * northstar.LM - Agent Orchestrator
 * Combines multiple meeting agents for cross-meeting insights
 *
 * Now powered by RLM-Lite (Recursive Language Model) for:
 * - Query decomposition into targeted sub-queries
 * - Parallel execution for efficiency
 * - Intelligent response aggregation
 */

import { getRLMPipeline, RLM_CONFIG } from './rlm/index.js';
import { generateCodePrompt } from './rlm/code-generator.js';

// ============================================
// RLM Pipeline Instance
// ============================================

const rlmPipeline = getRLMPipeline();

// ============================================
// State Management
// ============================================

const state = {
    apiKey: '',
    agents: [],  // In-memory storage (session-only)
    insights: null,
    chatHistory: [],
    signalState: {
        decisions: [],
        actionItems: [],
        openQuestions: [],
        constraints: [],
        entities: [],
        sourcePointers: []
    },
    stateBlockMarkdown: '',
    summaryLastTurn: '',
    memoryIndex: [],
    promptCounter: 0,
    isProcessing: false,
    settings: {
        model: 'gpt-5.2',      // 'gpt-5.2', 'gpt-5-mini', or 'gpt-5-nano'
        effort: 'none',        // 'none', 'low', 'medium', 'high' (only for gpt-5.2) - default 'none' for compatibility
        processingMode: 'rlm-hybrid', // 'direct', 'rlm-swm', 'rlm-hybrid'
        useRLM: true,          // Enable/disable RLM processing
        rlmAuto: false,        // Auto-route RLM only for ambiguous prompts
        enableShadowPrompt: true,
        enableRetrievalPrompt: true,
        enableFocusShadow: true,
        enableFocusEpisodes: true,
        enablePromptBudgeting: RLM_CONFIG.enablePromptBudgeting,
        showMemoryDebug: false
    }
};

const PROCESSING_MODE_CONFIG = {
    direct: {
        useRLM: false,
        rlmAuto: false,
        enableShadowPrompt: false,
        enableRetrievalPrompt: false,
        enableFocusShadow: false,
        enableFocusEpisodes: false
    },
    'rlm-swm': {
        useRLM: true,
        rlmAuto: false,
        enableShadowPrompt: false,
        enableRetrievalPrompt: true,
        enableFocusShadow: false,
        enableFocusEpisodes: false
    },
    'rlm-hybrid': {
        useRLM: true,
        rlmAuto: false,
        enableShadowPrompt: true,
        enableRetrievalPrompt: true,
        enableFocusShadow: true
    }
};

// Model pricing (per 1M tokens) - Standard tier
const PRICING = {
    'gpt-5.2': { input: 1.75, output: 14.00 },      // Full reasoning model
    'gpt-5-mini': { input: 0.25, output: 2.00 },    // Fast, cost-efficient
    'gpt-5-nano': { input: 0.05, output: 0.40 }     // Fastest, cheapest
};

const MODEL_DISPLAY_NAMES = {
    'gpt-5.2': 'GPT-5.2',
    'gpt-5-mini': 'GPT-5-mini',
    'gpt-5-nano': 'GPT-5-nano'
};

const fallbackNoticeKeys = new Set();

// Model-specific max completion token limits (model caps)
const MODEL_TOKEN_LIMITS = {
    'gpt-5.2': 128000,
    'gpt-5-mini': 128000,
    'gpt-5-nano': 128000  // Updated max output tokens per model spec
};

// Estimated context window sizes for visualization (tokens)
const MODEL_CONTEXT_WINDOWS = {
    'gpt-5.2': 400000,
    'gpt-5-mini': 400000,
    'gpt-5-nano': 400000
};

const TEST_PROMPT_LIMIT = 10;
const TEST_SETTINGS_KEYS = [
    'useRLM',
    'rlmAuto',
    'enableShadowPrompt',
    'enableRetrievalPrompt',
    'enableFocusShadow',
    'enableFocusEpisodes',
    'enablePromptBudgeting',
    'showMemoryDebug'
];
const DEFAULT_TEST_PROMPTS = [
    'Summarize the key decisions made throughout the meetings.',
    'What were the main blockers discussed across the meetings.',
    'List the action items and owners that came out of the Q3 and Q4 meetings.',
    'Which risks keep showing up across all meetings.',
    'What were the main concerns with the capital markets in 2025.',
    'Highlight any commitments made to external stakeholders since Q2.',
    'Summarize this conversation with 6 bullets per topic.'
];

function deriveProcessingMode(settings) {
    if (!settings.useRLM) {
        return 'direct';
    }
    if (settings.enableShadowPrompt || settings.enableFocusShadow) {
        return 'rlm-hybrid';
    }
    return 'rlm-swm';
}

function applyProcessingMode(mode, { persist = true, syncUI = true, updatePipeline = true } = {}) {
    const config = PROCESSING_MODE_CONFIG[mode] || PROCESSING_MODE_CONFIG['rlm-hybrid'];
    state.settings.processingMode = mode;
    state.settings.useRLM = config.useRLM;
    state.settings.rlmAuto = config.rlmAuto;
    state.settings.enableShadowPrompt = config.enableShadowPrompt;
    state.settings.enableRetrievalPrompt = config.enableRetrievalPrompt;
    state.settings.enableFocusShadow = config.enableFocusShadow;

    if (typeof config.enableFocusEpisodes === 'boolean') {
        state.settings.enableFocusEpisodes = config.enableFocusEpisodes;
    } else if (!state.settings.enableFocusShadow) {
        state.settings.enableFocusEpisodes = false;
    }

    if (persist) {
        saveSettings();
    }
    if (syncUI) {
        updateSettingsUI();
    }
    if (updatePipeline) {
        applyRlmFeatureFlags();
    }
}

function syncProcessingModeFromSettings() {
    const derivedMode = deriveProcessingMode(state.settings);
    if (state.settings.processingMode !== derivedMode) {
        state.settings.processingMode = derivedMode;
    }
}

// Metrics tracking for current session - ENHANCED per-prompt logging
let currentMetrics = {
    // Running totals
    gptInputTokens: 0,
    gptOutputTokens: 0,
    totalCost: 0,
    totalResponseTime: 0,
    
    // Per-prompt detailed logs (grouped by user query)
    promptLogs: []
};

// Active prompt group for tracking RLM sub-calls together
let activePromptGroup = null;

// Metrics card state
let metricsState = {
    isPinned: false,
    autoCollapseTimeout: null
};

let testPromptState = {
    prompts: [],
    selectedCount: 0,
    run: null,
    settings: null
};

let testPromptIdCounter = 0;
function createTestPrompt(text, options = {}) {
    return {
        id: `test-prompt-${++testPromptIdCounter}`,
        text,
        selected: options.selected || false,
        isCustom: options.isCustom || false
    };
}

// Generate unique ID for each prompt log
let promptLogIdCounter = 0;
function generatePromptLogId() {
    return `prompt-${++promptLogIdCounter}-${Date.now()}`;
}

function formatModelName(model) {
    return MODEL_DISPLAY_NAMES[model] || model || 'unknown';
}

function recordModelFallback(requestedModel, actualModel, callName = 'API Call') {
    if (!requestedModel || !actualModel || requestedModel === actualModel) {
        return;
    }

    if (activePromptGroup) {
        if (!activePromptGroup.modelFallbackNotified) {
            activePromptGroup.modelFallbackNotified = true;
            appendChatMessage(
                'assistant',
                `⚠️ Model fallback detected: requested ${formatModelName(requestedModel)}, but the API responded with ${formatModelName(actualModel)}. Metrics will record the actual model.`
            );
        }
        return;
    }

    const noticeKey = `${requestedModel}->${actualModel}`;
    if (fallbackNoticeKeys.has(noticeKey)) {
        return;
    }

    fallbackNoticeKeys.add(noticeKey);
    appendChatMessage(
        'assistant',
        `⚠️ Model fallback detected: requested ${formatModelName(requestedModel)}, but the API responded with ${formatModelName(actualModel)}. Metrics will record the actual model.`
    );
}

/**
 * Start a new prompt group for tracking a user query
 * All API calls within this group will be aggregated together
 * @param {string} queryName - Name/description of the user query
 * @param {boolean} usesRLM - Whether this query uses RLM processing
 * @param {string} mode - Processing mode ('direct', 'rlm', 'repl')
 */
function startPromptGroup(queryName, usesRLM = false, mode = 'direct') {
    console.log('[Metrics] startPromptGroup:', queryName, 'mode:', mode, 'usesRLM:', usesRLM);
    activePromptGroup = {
        id: generatePromptLogId(),
        timestamp: new Date().toISOString(),
        name: queryName,
        usesRLM: usesRLM,
        mode: mode,  // 'direct', 'rlm', or 'repl'
        model: state.settings.model,
        requestedModel: state.settings.model,
        effort: state.settings.model === 'gpt-5.2' ? state.settings.effort : 'N/A',
        startTime: performance.now(),
        subCalls: [],  // Individual API calls within this group
        tokens: { input: 0, output: 0, total: 0 },
        cost: { input: 0, output: 0, total: 0 },
        confidence: { available: false, samples: [] },
        emptyResponse: false,  // Track if any sub-call had empty response
        maxRetryAttempt: 0,  // Track maximum retry attempts across sub-calls
        actualModels: [],
        modelFallbacks: [],
        modelFallbackNotified: false,
        cached: false,
        focusEpisodes: []
    };
    return activePromptGroup.id;
}

function appendCallToGroup(group, callData) {
    group.subCalls.push(callData);
    group.tokens.input += callData.tokens.input;
    group.tokens.output += callData.tokens.output;
    group.tokens.total += callData.tokens.total;
    group.cost.input += callData.cost.input;
    group.cost.output += callData.cost.output;
    group.cost.total += callData.cost.total;

    if (callData.actualModel) {
        if (!group.actualModels.includes(callData.actualModel)) {
            group.actualModels.push(callData.actualModel);
        }
    }
    if (callData.modelFallback) {
        group.modelFallbacks.push({
            requestedModel: callData.requestedModel,
            actualModel: callData.actualModel,
            callName: callData.name
        });
    }

    if (callData.emptyResponse) {
        group.emptyResponse = true;
    }
    if (callData.retryAttempt && callData.retryAttempt > group.maxRetryAttempt) {
        group.maxRetryAttempt = callData.retryAttempt;
    }

    if (callData.confidence) {
        if (!group.confidence) {
            group.confidence = { available: false, samples: [] };
        }
        if (!Array.isArray(group.confidence.samples)) {
            group.confidence.samples = [];
        }
        group.confidence.samples.push(callData.confidence);
    }

    group.lastCallAt = Date.now();
}

function updateGroupFinishReason(group) {
    if (!group.subCalls || group.subCalls.length === 0) {
        return;
    }

    const finishReasonPriority = {
        'content_filter': 4,
        'length': 3,
        'stop_sequence': 2,
        'stop': 1,
        'unknown': 0
    };

    let highestPriorityReason = 'stop';
    let highestPriority = 1;

    const successfulCalls = group.subCalls.filter(subCall => !subCall.emptyResponse);
    const callsForReason = successfulCalls.length > 0 ? successfulCalls : group.subCalls;

    callsForReason.forEach(subCall => {
        const reason = subCall.finishReason || 'unknown';
        const priority = finishReasonPriority[reason] !== undefined ? finishReasonPriority[reason] : 0;
        if (priority > highestPriority) {
            highestPriority = priority;
            highestPriorityReason = reason;
        }
    });

    group.finishReason = highestPriorityReason;
}

function updateGroupConfidence(group) {
    if (!group.confidence || !group.confidence.samples || group.confidence.samples.length === 0) {
        return;
    }

    const validSamples = group.confidence.samples.filter(s => s && s.avgLogprob !== null && s.avgLogprob !== undefined);
    if (validSamples.length > 0) {
        group.confidence.available = true;
        group.confidence.avgLogprob =
            validSamples.reduce((sum, s) => sum + s.avgLogprob, 0) / validSamples.length;
    }
    group.confidence.truncated =
        group.confidence.samples.some(s => s && s.truncated);
    const reasoningSamples = group.confidence.samples.filter(s => s && s.reasoningTokens !== null && s.reasoningTokens !== undefined);
    if (reasoningSamples.length > 0) {
        const reasoningTotal = reasoningSamples.reduce((sum, s) => sum + s.reasoningTokens, 0);
        if (reasoningTotal > 0) {
            group.confidence.reasoningTokens = reasoningTotal;
            group.confidence.available = true;
        }
    }
}

function updateGroupModel(group) {
    if (!group.actualModels || group.actualModels.length === 0) {
        return;
    }

    if (group.actualModels.length === 1) {
        group.model = group.actualModels[0];
        if (group.model !== 'gpt-5.2') {
            group.effort = 'N/A';
        }
    } else {
        group.model = 'mixed';
        group.effort = 'N/A';
    }
}

function attachShadowPromptTelemetry(userMessage) {
    if (!activePromptGroup || !rlmPipeline?.getStats) {
        return;
    }

    const stats = rlmPipeline.getStats();
    const shadowPrompt = stats?.shadowPrompt;

    if (!stats?.config?.enableShadowPrompt || !shadowPrompt) {
        return;
    }

    if (shadowPrompt.query && shadowPrompt.query !== userMessage) {
        return;
    }

    activePromptGroup.shadowPrompt = {
        mode: shadowPrompt.mode,
        createdAt: shadowPrompt.createdAt,
        promptPreview: shadowPrompt.promptPreview,
        retrievalStats: shadowPrompt.retrievalStats,
        tokenEstimate: shadowPrompt.tokenEstimate,
        tokenBreakdown: shadowPrompt.tokenBreakdown
    };
}

function attachRetrievalPromptTelemetry(userMessage) {
    if (!activePromptGroup || !rlmPipeline?.getStats) {
        return;
    }

    const stats = rlmPipeline.getStats();
    if (!stats?.config?.enableRetrievalPrompt || !stats?.guardrails?.lastRetrievalStats) {
        return;
    }

    const shadowPrompt = stats?.shadowPrompt;
    if (shadowPrompt?.query && shadowPrompt.query !== userMessage) {
        return;
    }

    activePromptGroup.retrievalPrompt = {
        ...stats.guardrails.lastRetrievalStats
    };
}

function recordFocusTelemetry(details = {}) {
    if (!activePromptGroup || !details?.focusSummary) {
        return;
    }

    if (!Array.isArray(activePromptGroup.focusEpisodes)) {
        activePromptGroup.focusEpisodes = [];
    }

    activePromptGroup.focusEpisodes.push({
        summary: details.focusSummary,
        reason: details.focusReason || 'unknown',
        shadowOnly: Boolean(details.shadowOnly)
    });
}

/**
 * End the current prompt group and add it to the logs
 */
function endPromptGroup() {
    console.log('[Metrics] endPromptGroup called, activePromptGroup:', !!activePromptGroup);
    if (!activePromptGroup) return;
    
    // Calculate total response time (wall-clock time for entire group, not sum of sub-calls)
    activePromptGroup.responseTime = Math.round(performance.now() - activePromptGroup.startTime);
    console.log('[Metrics] Ending prompt group:', activePromptGroup.name, 'with', activePromptGroup.subCalls?.length || 0, 'sub-calls');
    
    updateGroupFinishReason(activePromptGroup);
    updateGroupConfidence(activePromptGroup);
    updateGroupModel(activePromptGroup);
    
    // Add to prompt logs
    currentMetrics.promptLogs.push(activePromptGroup);
    
    // Update running totals
    currentMetrics.totalResponseTime += activePromptGroup.responseTime;
    
    // Clear active group
    activePromptGroup = null;
    
    // Update display
    updateMetricsDisplay();
}

/**
 * Add an API call to the current prompt group (or create standalone if no group)
 * @param {Object} callData - API call data
 */
function addAPICallToMetrics(callData) {
    console.log('[Metrics] addAPICallToMetrics:', callData.name, 'tokens:', callData.tokens?.total);
    
    // Update running totals
    currentMetrics.gptInputTokens += callData.tokens.input;
    currentMetrics.gptOutputTokens += callData.tokens.output;
    currentMetrics.totalCost += callData.cost.total;
    
    if (activePromptGroup) {
        appendCallToGroup(activePromptGroup, callData);
        return;
    }

    const inferredMode = callData.name?.startsWith('REPL:')
        ? 'repl'
        : (callData.name?.startsWith('RLM:') ? 'rlm' : null);
    const lastLog = currentMetrics.promptLogs[currentMetrics.promptLogs.length - 1];
    const lastCallAt = lastLog?.lastCallAt || (lastLog?.timestamp ? new Date(lastLog.timestamp).getTime() : 0);
    const shouldMerge = inferredMode
        && lastLog
        && lastLog.inferredGroup
        && lastLog.name === callData.name
        && (Date.now() - lastCallAt < 120000);

    if (shouldMerge) {
        appendCallToGroup(lastLog, callData);
        lastLog.responseTime += callData.responseTime;
        currentMetrics.totalResponseTime += callData.responseTime;
        updateGroupFinishReason(lastLog);
        updateGroupConfidence(lastLog);
        updateGroupModel(lastLog);
        updateMetricsDisplay();
        return;
    }

    if (inferredMode) {
        const inferredEntry = {
            id: generatePromptLogId(),
            timestamp: callData.timestamp,
            name: callData.name,
            usesRLM: true,
            mode: inferredMode,
            model: callData.model,
            requestedModel: callData.requestedModel,
            effort: callData.effort,
            responseTime: callData.responseTime,
            subCalls: [],
            actualModels: callData.actualModel ? [callData.actualModel] : [],
            modelFallbacks: callData.modelFallback ? [{
                requestedModel: callData.requestedModel,
                actualModel: callData.actualModel,
                callName: callData.name
            }] : [],
            cached: false,
            tokens: { input: 0, output: 0, total: 0 },
            cost: { input: 0, output: 0, total: 0 },
            confidence: { available: false, samples: [] },
            promptPreview: callData.promptPreview,
            response: callData.response,
            emptyResponse: false,
            finishReason: callData.finishReason || 'unknown',
            maxRetryAttempt: callData.retryAttempt || 0,
            inferredGroup: true,
            lastCallAt: Date.now()
        };
        appendCallToGroup(inferredEntry, callData);
        updateGroupFinishReason(inferredEntry);
        updateGroupConfidence(inferredEntry);
        updateGroupModel(inferredEntry);
        currentMetrics.promptLogs.push(inferredEntry);
        currentMetrics.totalResponseTime += callData.responseTime;
        updateMetricsDisplay();
        return;
    }

    // No active group - create standalone entry
    const standaloneEntry = {
        id: generatePromptLogId(),
        timestamp: callData.timestamp,
        name: callData.name,
        usesRLM: false,
        mode: 'direct',
        model: callData.model,
        requestedModel: callData.requestedModel,
        effort: callData.effort,
        responseTime: callData.responseTime,
        subCalls: [callData],
        actualModels: callData.actualModel ? [callData.actualModel] : [],
        modelFallbacks: callData.modelFallback ? [{
            requestedModel: callData.requestedModel,
            actualModel: callData.actualModel,
            callName: callData.name
        }] : [],
        cached: false,
        tokens: callData.tokens,
        cost: callData.cost,
        confidence: callData.confidence,
        promptPreview: callData.promptPreview,
        response: callData.response,  // Store the response from the call
        emptyResponse: callData.emptyResponse || false,  // Track empty responses
        finishReason: callData.finishReason || 'unknown',  // Track finish reason
        retryAttempt: callData.retryAttempt || 0  // Track retry attempts
    };
    currentMetrics.promptLogs.push(standaloneEntry);
    currentMetrics.totalResponseTime += callData.responseTime;
    updateMetricsDisplay();
}

// ============================================
// DOM Elements
// ============================================

let elements = {};

function initElements() {
    elements = {
        // API Key
        apiKeyInput: document.getElementById('api-key'),
        apiKeyContainer: document.getElementById('api-key-container'),
        apiKeyCollapsed: document.getElementById('api-key-collapsed'),
        expandKeyBtn: document.getElementById('expand-key-btn'),
        toggleKeyBtn: document.getElementById('toggle-key'),
        saveKeyBtn: document.getElementById('save-key'),

        // Knowledge Base
        agentFilesInput: document.getElementById('agent-files'),
        agentsDropZone: document.getElementById('agents-drop-zone'),
        knowledgeBaseContainer: document.getElementById('knowledge-base-container'),
        agentsList: document.getElementById('agents-list'),
        agentsCount: document.getElementById('agents-count'),
        activeAgentsCount: document.getElementById('active-agents-count'),
        chainEmptyState: document.getElementById('chain-empty-state'),
        clearCacheBtn: document.getElementById('clear-cache-btn'),
        clearAllBtn: document.getElementById('clear-all-agents'),
        generateInsightsBtn: document.getElementById('generate-insights-btn'),
        orchestratorBrain: document.getElementById('orchestrator-brain'),
        brainStatus: document.getElementById('brain-status'),
        kbFlow: document.getElementById('kb-flow'),

        // Chat (now integrated into knowledge base section)
        chatContainer: document.getElementById('chat-interface-container'),
        chatMessages: document.getElementById('chat-messages'),
        chatInput: document.getElementById('chat-input'),
        chatSendBtn: document.getElementById('chat-send-btn'),
        chatAgentCount: document.getElementById('chat-agent-count'),
        chatKbIndicator: document.getElementById('chat-kb-indicator'),
        runTestPromptingBtn: document.getElementById('run-test-prompting-btn'),

        // Insights
        insightsSection: document.getElementById('insights-section'),
        insightThemes: document.getElementById('insight-themes'),
        insightTrends: document.getElementById('insight-trends'),
        insightRisks: document.getElementById('insight-risks'),
        insightRecommendations: document.getElementById('insight-recommendations'),
        insightActions: document.getElementById('insight-actions'),

        // Metrics
        metricsCard: document.getElementById('metrics-card'),
        metricsToggle: document.getElementById('metrics-toggle'),
        metricsContent: document.getElementById('metrics-content'),
        memoryDebugSection: document.getElementById('memory-debug-section'),
        memoryDebugContent: document.getElementById('result-memory-debug'),

        // Error
        errorSection: document.getElementById('error-section'),
        errorMessage: document.getElementById('error-message'),
        dismissErrorBtn: document.getElementById('dismiss-error'),
        
        // Help Modal
        helpBtn: document.getElementById('help-btn'),
        helpModal: document.getElementById('help-modal'),
        helpCloseBtn: document.getElementById('help-close-btn'),
        helpGotItBtn: document.getElementById('help-got-it-btn'),
        
        // About Dropdown
        aboutBtn: document.getElementById('about-btn'),
        aboutDropdown: document.getElementById('about-dropdown'),
        
        // Model Settings
        modelSettings: document.getElementById('model-settings'),
        modelSelect: document.getElementById('model-select'),
        effortGroup: document.getElementById('effort-group'),
        effortSelect: document.getElementById('effort-select'),
        processingModeSelect: document.getElementById('processing-mode-select'),
        rlmToggle: document.getElementById('rlm-toggle'),
        rlmAutoToggle: document.getElementById('rlm-auto-toggle'),
        shadowPromptToggle: document.getElementById('shadow-prompt-toggle'),
        retrievalPromptToggle: document.getElementById('retrieval-prompt-toggle'),
        focusShadowToggle: document.getElementById('focus-shadow-toggle'),
        focusEpisodesToggle: document.getElementById('focus-episodes-toggle'),
        promptBudgetToggle: document.getElementById('prompt-budget-toggle'),
        memoryDebugToggle: document.getElementById('memory-debug-toggle'),

        // Context Window Gauge
        contextGauge: document.getElementById('context-gauge'),
        contextGaugeStatus: document.getElementById('context-gauge-status'),
        contextGaugeUsage: document.getElementById('context-gauge-usage'),
        contextGaugeRomFill: document.getElementById('context-gauge-rom-fill'),
        contextGaugeRawFill: document.getElementById('context-gauge-raw-fill'),
        contextGaugeRomValue: document.getElementById('context-gauge-rom-value'),
        contextGaugeRawValue: document.getElementById('context-gauge-raw-value'),
        contextGaugeFootnote: document.getElementById('context-gauge-footnote'),

        // Test Prompting
        testPromptingModal: document.getElementById('test-prompting-modal'),
        testPromptingCloseBtn: document.getElementById('test-prompting-close-btn'),
        testPromptingCancelBtn: document.getElementById('test-prompting-cancel-btn'),
        testPromptList: document.getElementById('test-prompt-list'),
        testSelectedCount: document.getElementById('test-selected-count'),
        addCustomPromptBtn: document.getElementById('add-custom-prompt-btn'),
        deployTestAgentBtn: document.getElementById('deploy-test-agent-btn'),
        testPromptError: document.getElementById('test-prompt-error'),
        testSettingsResetBtn: document.getElementById('test-settings-reset-btn'),
        testRlmToggle: document.getElementById('test-rlm-toggle'),
        testRlmAutoToggle: document.getElementById('test-rlm-auto-toggle'),
        testShadowPromptToggle: document.getElementById('test-shadow-prompt-toggle'),
        testRetrievalPromptToggle: document.getElementById('test-retrieval-prompt-toggle'),
        testFocusShadowToggle: document.getElementById('test-focus-shadow-toggle'),
        testFocusEpisodesToggle: document.getElementById('test-focus-episodes-toggle'),
        testPromptBudgetToggle: document.getElementById('test-prompt-budget-toggle'),
        testMemoryDebugToggle: document.getElementById('test-memory-debug-toggle'),
        testRunningScreen: document.getElementById('test-running-screen'),
        testProgressFill: document.getElementById('test-progress-fill'),
        testProgressLabel: document.getElementById('test-progress-label'),
        testProgressCount: document.getElementById('test-progress-count'),
        testStatusStream: document.getElementById('test-status-stream'),
        testAnalyticsModal: document.getElementById('test-analytics-modal'),
        testAnalyticsCloseBtn: document.getElementById('test-analytics-close-btn'),
        testAnalyticsDismissBtn: document.getElementById('test-analytics-dismiss-btn'),
        testAnalyticsSummary: document.getElementById('test-analytics-summary'),
        testAnalyticsList: document.getElementById('test-analytics-list'),
        exportTestHtmlBtn: document.getElementById('export-test-html-btn')
    };
}

// ============================================
// State Persistence (sessionStorage)
// ============================================

const STORAGE_KEYS = {
    AGENTS: 'orch_agents',
    CHAT_HISTORY: 'orch_chat_history',
    INSIGHTS: 'orch_insights',
    SIGNAL_STATE: 'orch_signal_state',
    STATE_BLOCK_MD: 'orch_state_block_md',
    SUMMARY_LAST_TURN: 'orch_summary_last_turn',
    MEMORY_INDEX: 'orch_memory_index',
    PROMPT_COUNTER: 'orch_prompt_counter'
};

/**
 * Save state to sessionStorage
 */
function saveState() {
    try {
        sessionStorage.setItem(STORAGE_KEYS.AGENTS, JSON.stringify(state.agents));
        sessionStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(state.chatHistory));
        sessionStorage.setItem(STORAGE_KEYS.SIGNAL_STATE, JSON.stringify(state.signalState));
        sessionStorage.setItem(STORAGE_KEYS.STATE_BLOCK_MD, state.stateBlockMarkdown || '');
        sessionStorage.setItem(STORAGE_KEYS.SUMMARY_LAST_TURN, state.summaryLastTurn || '');
        sessionStorage.setItem(STORAGE_KEYS.MEMORY_INDEX, JSON.stringify(state.memoryIndex));
        sessionStorage.setItem(STORAGE_KEYS.PROMPT_COUNTER, String(state.promptCounter || 0));
        if (state.insights) {
            sessionStorage.setItem(STORAGE_KEYS.INSIGHTS, JSON.stringify(state.insights));
        }
        console.log('[State] Saved to sessionStorage:', {
            agents: state.agents.length,
            chatHistory: state.chatHistory.length,
            memoryIndex: state.memoryIndex.length
        });
    } catch (error) {
        console.warn('[State] Failed to save state:', error.message);
    }
}

/**
 * Restore state from sessionStorage
 */
function restoreState() {
    try {
        const savedAgents = sessionStorage.getItem(STORAGE_KEYS.AGENTS);
        const savedChatHistory = sessionStorage.getItem(STORAGE_KEYS.CHAT_HISTORY);
        const savedInsights = sessionStorage.getItem(STORAGE_KEYS.INSIGHTS);
        const savedSignalState = sessionStorage.getItem(STORAGE_KEYS.SIGNAL_STATE);
        const savedStateBlockMarkdown = sessionStorage.getItem(STORAGE_KEYS.STATE_BLOCK_MD);
        const savedSummaryLastTurn = sessionStorage.getItem(STORAGE_KEYS.SUMMARY_LAST_TURN);
        const savedMemoryIndex = sessionStorage.getItem(STORAGE_KEYS.MEMORY_INDEX);
        const savedPromptCounter = sessionStorage.getItem(STORAGE_KEYS.PROMPT_COUNTER);

        if (savedAgents) {
            state.agents = JSON.parse(savedAgents);
            console.log('[State] Restored agents:', state.agents.length);
        }

        if (savedChatHistory) {
            state.chatHistory = JSON.parse(savedChatHistory);
            console.log('[State] Restored chat history:', state.chatHistory.length);

            // Restore chat messages in UI
            if (state.chatHistory.length > 0) {
                restoreChatHistoryUI();
            }
        }

        if (savedInsights) {
            state.insights = JSON.parse(savedInsights);
            console.log('[State] Restored insights');
            // Display restored insights
            if (state.insights) {
                displayInsights(state.insights);
            }
        }

        if (savedSignalState) {
            state.signalState = JSON.parse(savedSignalState);
            console.log('[State] Restored signal state');
        }

        if (savedStateBlockMarkdown !== null) {
            state.stateBlockMarkdown = savedStateBlockMarkdown;
        }

        if (savedSummaryLastTurn !== null) {
            state.summaryLastTurn = savedSummaryLastTurn;
        }

        if (savedMemoryIndex) {
            state.memoryIndex = JSON.parse(savedMemoryIndex);
            console.log('[State] Restored memory index:', state.memoryIndex.length);
        }

        if (savedPromptCounter) {
            state.promptCounter = Number(savedPromptCounter) || 0;
        }

        if (!state.stateBlockMarkdown && state.signalState) {
            state.stateBlockMarkdown = buildStateBlockMarkdown();
        }

        return state.agents.length > 0; // Return true if we restored anything
    } catch (error) {
        console.warn('[State] Failed to restore state:', error.message);
        return false;
    }
}

/**
 * Restore chat history to UI
 */
function restoreChatHistoryUI() {
    // Remove welcome card
    const welcomeCard = elements.chatMessages.querySelector('.chat-welcome-card');
    if (welcomeCard) {
        welcomeCard.remove();
    }

    // Restore messages
    state.chatHistory.forEach((msg) => {
        appendChatMessage(msg.role, msg.content, false); // Don't save again
    });
}

/**
 * Load settings from localStorage
 */
function loadSettings() {
    try {
        const savedSettings = localStorage.getItem('northstar.LM_settings');
        if (savedSettings) {
            const parsed = JSON.parse(savedSettings);
            state.settings = { ...state.settings, ...parsed };
            state.settings.enablePromptBudgeting = true;
            if (typeof state.settings.enableFocusEpisodes !== 'boolean') {
                state.settings.enableFocusEpisodes = true;
            }
            if (!state.settings.processingMode) {
                state.settings.processingMode = deriveProcessingMode(state.settings);
            }
            applyProcessingMode(state.settings.processingMode, { persist: false, syncUI: false, updatePipeline: false });

            // Migration: Reset effort to 'none' if it was the old default 'medium'
            // This prevents the fictional 'reasoning' parameter from being sent
            // Users who explicitly want effort can re-select it
            const settingsVersion = localStorage.getItem('northstar.LM_settings_v');
            if (!settingsVersion || settingsVersion < '2') {
                if (state.settings.effort === 'medium') {
                    state.settings.effort = 'none';
                    console.log('[Settings] Migrated: Reset effort from medium to none for API compatibility');
                }
                localStorage.setItem('northstar.LM_settings_v', '2');
                saveSettings(); // Save the migrated settings
            }

            console.log('[Settings] Loaded from localStorage:', state.settings);
        }
    } catch (error) {
        console.warn('[Settings] Failed to load settings:', error.message);
    }
}

/**
 * Save settings to localStorage
 */
function saveSettings() {
    try {
        localStorage.setItem('northstar.LM_settings', JSON.stringify(state.settings));
        console.log('[Settings] Saved to localStorage:', state.settings);
    } catch (error) {
        console.warn('[Settings] Failed to save settings:', error.message);
    }
}

/**
 * Update settings UI to match state
 */
function updateSettingsUI() {
    if (elements.modelSelect) {
        elements.modelSelect.value = state.settings.model;
    }
    if (elements.effortSelect) {
        elements.effortSelect.value = state.settings.effort;
    }
    if (elements.processingModeSelect) {
        elements.processingModeSelect.value = state.settings.processingMode;
    }
    if (elements.rlmToggle) {
        elements.rlmToggle.checked = state.settings.useRLM;
    }
    if (elements.rlmAutoToggle) {
        elements.rlmAutoToggle.checked = state.settings.rlmAuto;
    }
    if (elements.shadowPromptToggle) {
        elements.shadowPromptToggle.checked = state.settings.enableShadowPrompt;
    }
    if (elements.retrievalPromptToggle) {
        elements.retrievalPromptToggle.checked = state.settings.enableRetrievalPrompt;
    }
    if (elements.focusShadowToggle) {
        elements.focusShadowToggle.checked = state.settings.enableFocusShadow;
    }
    if (elements.focusEpisodesToggle) {
        elements.focusEpisodesToggle.checked = state.settings.enableFocusEpisodes;
    }
    if (elements.promptBudgetToggle) {
        elements.promptBudgetToggle.checked = state.settings.enablePromptBudgeting;
    }
    if (elements.memoryDebugToggle) {
        elements.memoryDebugToggle.checked = state.settings.showMemoryDebug;
    }
    updateModeControlState();
    // Show/hide effort dropdown based on model
    updateEffortVisibility();
    updateMemoryDebugPanel();
}

function updateModeControlState() {
    if (elements.rlmToggle) {
        elements.rlmToggle.disabled = true;
    }
    if (elements.rlmAutoToggle) {
        elements.rlmAutoToggle.disabled = true;
    }
    if (elements.shadowPromptToggle) {
        elements.shadowPromptToggle.disabled = true;
    }
    if (elements.retrievalPromptToggle) {
        elements.retrievalPromptToggle.disabled = true;
    }
    if (elements.focusShadowToggle) {
        elements.focusShadowToggle.disabled = true;
    }
    if (elements.focusEpisodesToggle) {
        elements.focusEpisodesToggle.disabled = !state.settings.enableFocusShadow;
    }
    if (elements.promptBudgetToggle) {
        elements.promptBudgetToggle.disabled = true;
    }
}

function applyRlmFeatureFlags() {
    if (!rlmPipeline?.updateConfig) {
        return;
    }
    rlmPipeline.updateConfig({
        enableShadowPrompt: state.settings.enableShadowPrompt,
        enableRetrievalPrompt: state.settings.enableRetrievalPrompt,
        enableFocusShadow: state.settings.enableFocusShadow,
        enableFocusEpisodes: state.settings.enableFocusEpisodes,
        enablePromptBudgeting: state.settings.enablePromptBudgeting
    });
}

/**
 * Update effort dropdown visibility based on selected model
 */
function updateEffortVisibility() {
    if (elements.effortGroup) {
        // Only show effort for GPT-5.2 (reasoning model), not for mini
        const showEffort = state.settings.model === 'gpt-5.2';
        elements.effortGroup.style.display = showEffort ? 'flex' : 'none';
    }
}

/**
 * Clear saved state
 */
function clearSavedState() {
    sessionStorage.removeItem(STORAGE_KEYS.AGENTS);
    sessionStorage.removeItem(STORAGE_KEYS.CHAT_HISTORY);
    sessionStorage.removeItem(STORAGE_KEYS.INSIGHTS);
    sessionStorage.removeItem(STORAGE_KEYS.SIGNAL_STATE);
    sessionStorage.removeItem(STORAGE_KEYS.STATE_BLOCK_MD);
    sessionStorage.removeItem(STORAGE_KEYS.SUMMARY_LAST_TURN);
    sessionStorage.removeItem(STORAGE_KEYS.MEMORY_INDEX);
    sessionStorage.removeItem(STORAGE_KEYS.PROMPT_COUNTER);
    console.log('[State] Cleared sessionStorage');
}

// ============================================
// Initialization
// ============================================

function init() {
    initElements();
    loadApiKey();
    loadSettings();

    // Restore state from sessionStorage if available
    const restored = restoreState();
    if (restored) {
        console.log('[Init] State restored from previous session');
    }

    setupEventListeners();
    updateSettingsUI();
    applyRlmFeatureFlags();
    updateUI();
}

function setupEventListeners() {
    // API Key
    elements.toggleKeyBtn.addEventListener('click', toggleApiKeyVisibility);
    elements.saveKeyBtn.addEventListener('click', saveApiKey);
    if (elements.expandKeyBtn) {
        elements.expandKeyBtn.addEventListener('click', expandApiKeySection);
    }

    // Agent Upload
    elements.agentsDropZone.addEventListener('dragover', handleDragOver);
    elements.agentsDropZone.addEventListener('dragleave', handleDragLeave);
    elements.agentsDropZone.addEventListener('drop', handleDrop);
    elements.agentFilesInput.addEventListener('change', handleFileSelect);
    if (elements.clearCacheBtn) {
        elements.clearCacheBtn.addEventListener('click', clearChatAndCache);
    }
    elements.clearAllBtn.addEventListener('click', clearAllAgents);

    // Generate Insights
    elements.generateInsightsBtn.addEventListener('click', generateCrossInsights);

    // Chat
    elements.chatSendBtn.addEventListener('click', sendChatMessage);
    elements.chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });

    if (elements.runTestPromptingBtn) {
        elements.runTestPromptingBtn.addEventListener('click', openTestPromptingModal);
    }
    if (elements.testPromptingCloseBtn) {
        elements.testPromptingCloseBtn.addEventListener('click', closeTestPromptingModal);
    }
    if (elements.testPromptingCancelBtn) {
        elements.testPromptingCancelBtn.addEventListener('click', closeTestPromptingModal);
    }
    if (elements.addCustomPromptBtn) {
        elements.addCustomPromptBtn.addEventListener('click', addCustomTestPrompt);
    }
    if (elements.deployTestAgentBtn) {
        elements.deployTestAgentBtn.addEventListener('click', deployTestAgent);
    }
    if (elements.testSettingsResetBtn) {
        elements.testSettingsResetBtn.addEventListener('click', () => {
            initializeTestSettings();
        });
    }
    if (elements.testRlmToggle) {
        elements.testRlmToggle.addEventListener('change', (e) => {
            updateTestSetting('useRLM', e.target.checked);
        });
    }
    if (elements.testRlmAutoToggle) {
        elements.testRlmAutoToggle.addEventListener('change', (e) => {
            updateTestSetting('rlmAuto', e.target.checked);
        });
    }
    if (elements.testShadowPromptToggle) {
        elements.testShadowPromptToggle.addEventListener('change', (e) => {
            updateTestSetting('enableShadowPrompt', e.target.checked);
        });
    }
    if (elements.testRetrievalPromptToggle) {
        elements.testRetrievalPromptToggle.addEventListener('change', (e) => {
            updateTestSetting('enableRetrievalPrompt', e.target.checked);
        });
    }
    if (elements.testFocusShadowToggle) {
        elements.testFocusShadowToggle.addEventListener('change', (e) => {
            updateTestSetting('enableFocusShadow', e.target.checked);
        });
    }
    if (elements.testFocusEpisodesToggle) {
        elements.testFocusEpisodesToggle.addEventListener('change', (e) => {
            updateTestSetting('enableFocusEpisodes', e.target.checked);
        });
    }
    if (elements.testPromptBudgetToggle) {
        elements.testPromptBudgetToggle.addEventListener('change', (e) => {
            updateTestSetting('enablePromptBudgeting', e.target.checked);
        });
    }
    if (elements.testMemoryDebugToggle) {
        elements.testMemoryDebugToggle.addEventListener('change', (e) => {
            updateTestSetting('showMemoryDebug', e.target.checked);
        });
    }
    if (elements.testPromptingModal) {
        elements.testPromptingModal.addEventListener('click', (e) => {
            if (e.target === elements.testPromptingModal) closeTestPromptingModal();
        });
    }
    if (elements.testAnalyticsCloseBtn) {
        elements.testAnalyticsCloseBtn.addEventListener('click', closeTestAnalyticsModal);
    }
    if (elements.testAnalyticsDismissBtn) {
        elements.testAnalyticsDismissBtn.addEventListener('click', closeTestAnalyticsModal);
    }
    if (elements.exportTestHtmlBtn) {
        elements.exportTestHtmlBtn.addEventListener('click', exportTestReportHtml);
    }
    if (elements.testAnalyticsModal) {
        elements.testAnalyticsModal.addEventListener('click', (e) => {
            if (e.target === elements.testAnalyticsModal) closeTestAnalyticsModal();
        });
    }
    
    // Auto-resize textarea
    elements.chatInput.addEventListener('input', autoResizeTextarea);
    
    // Suggestion chips
    document.querySelectorAll('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const query = chip.dataset.query;
            if (query) {
                elements.chatInput.value = query;
                autoResizeTextarea();
                sendChatMessage();
            }
        });
    });

    // Metrics
    if (elements.metricsToggle) {
        elements.metricsToggle.addEventListener('click', toggleMetricsCard);
    }

    const metricsPinBtn = document.getElementById('metrics-pin-btn');
    if (metricsPinBtn) {
        metricsPinBtn.addEventListener('click', toggleMetricsPin);
    }

    const metricsDownloadBtn = document.getElementById('metrics-download-csv');
    if (metricsDownloadBtn) {
        metricsDownloadBtn.addEventListener('click', downloadMetricsCSV);
    }

    // Error
    elements.dismissErrorBtn.addEventListener('click', hideError);
    
    // Help Modal
    if (elements.helpBtn) {
        elements.helpBtn.addEventListener('click', showHelpModal);
    }
    if (elements.helpCloseBtn) {
        elements.helpCloseBtn.addEventListener('click', hideHelpModal);
    }
    if (elements.helpGotItBtn) {
        elements.helpGotItBtn.addEventListener('click', hideHelpModal);
    }
    if (elements.helpModal) {
        elements.helpModal.addEventListener('click', (e) => {
            if (e.target === elements.helpModal) hideHelpModal();
        });
    }
    
    // About Dropdown
    if (elements.aboutBtn && elements.aboutDropdown) {
        elements.aboutBtn.addEventListener('click', () => {
            elements.aboutDropdown.classList.toggle('hidden');
        });
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!elements.aboutBtn.contains(e.target) && !elements.aboutDropdown.contains(e.target)) {
                elements.aboutDropdown.classList.add('hidden');
            }
        });
    }
    
    // Model Settings
    if (elements.modelSelect) {
        elements.modelSelect.addEventListener('change', handleModelChange);
    }
    if (elements.effortSelect) {
        elements.effortSelect.addEventListener('change', handleEffortChange);
    }
    if (elements.processingModeSelect) {
        elements.processingModeSelect.addEventListener('change', handleProcessingModeChange);
    }
    if (elements.rlmToggle) {
        elements.rlmToggle.addEventListener('change', handleRLMToggle);
    }
    if (elements.rlmAutoToggle) {
        elements.rlmAutoToggle.addEventListener('change', handleRLMAutoToggle);
    }
    if (elements.shadowPromptToggle) {
        elements.shadowPromptToggle.addEventListener('change', handleShadowPromptToggle);
    }
    if (elements.retrievalPromptToggle) {
        elements.retrievalPromptToggle.addEventListener('change', handleRetrievalPromptToggle);
    }
    if (elements.focusShadowToggle) {
        elements.focusShadowToggle.addEventListener('change', handleFocusShadowToggle);
    }
    if (elements.focusEpisodesToggle) {
        elements.focusEpisodesToggle.addEventListener('change', handleFocusEpisodesToggle);
    }
    if (elements.promptBudgetToggle) {
        elements.promptBudgetToggle.addEventListener('change', handlePromptBudgetToggle);
    }
    if (elements.memoryDebugToggle) {
        elements.memoryDebugToggle.addEventListener('change', handleMemoryDebugToggle);
    }
}

// ============================================
// Model Settings Handlers
// ============================================

/**
 * Handle model selection change
 */
function handleModelChange(e) {
    state.settings.model = e.target.value;
    updateEffortVisibility();
    saveSettings();
    updateContextGauge();
    console.log('[Settings] Model changed to:', state.settings.model);
}

/**
 * Handle effort level change
 */
function handleEffortChange(e) {
    state.settings.effort = e.target.value;
    saveSettings();
    console.log('[Settings] Effort changed to:', state.settings.effort);
}

/**
 * Handle processing mode change
 */
function handleProcessingModeChange(e) {
    const nextMode = e.target.value;
    applyProcessingMode(nextMode);
    updateContextGauge();
    console.log('[Settings] Processing mode changed to:', nextMode);
}

/**
 * Handle RLM toggle change
 */
function handleRLMToggle(e) {
    state.settings.useRLM = e.target.checked;
    syncProcessingModeFromSettings();
    saveSettings();
    console.log('[Settings] RLM toggled:', state.settings.useRLM ? 'enabled' : 'disabled');
    updateSettingsUI();
    updateContextGauge();
}

/**
 * Handle RLM auto-routing toggle change
 */
function handleRLMAutoToggle(e) {
    state.settings.rlmAuto = e.target.checked;
    saveSettings();
    console.log('[Settings] RLM auto-routing toggled:', state.settings.rlmAuto ? 'enabled' : 'disabled');
    updateContextGauge();
}

function handleShadowPromptToggle(e) {
    state.settings.enableShadowPrompt = e.target.checked;
    syncProcessingModeFromSettings();
    saveSettings();
    applyRlmFeatureFlags();
}

function handleRetrievalPromptToggle(e) {
    state.settings.enableRetrievalPrompt = e.target.checked;
    syncProcessingModeFromSettings();
    saveSettings();
    applyRlmFeatureFlags();
}

function handleFocusShadowToggle(e) {
    state.settings.enableFocusShadow = e.target.checked;
    if (!state.settings.enableFocusShadow) {
        state.settings.enableFocusEpisodes = false;
    }
    syncProcessingModeFromSettings();
    saveSettings();
    updateSettingsUI();
    applyRlmFeatureFlags();
}

function handleFocusEpisodesToggle(e) {
    state.settings.enableFocusEpisodes = e.target.checked;
    if (state.settings.enableFocusEpisodes) {
        state.settings.enableFocusShadow = true;
    }
    saveSettings();
    updateSettingsUI();
    applyRlmFeatureFlags();
}

function handlePromptBudgetToggle(e) {
    state.settings.enablePromptBudgeting = e.target.checked;
    saveSettings();
    applyRlmFeatureFlags();
}

function handleMemoryDebugToggle(e) {
    state.settings.showMemoryDebug = e.target.checked;
    saveSettings();
    updateMemoryDebugPanel();
}

// ============================================
// API Key Management
// ============================================

function loadApiKey() {
    const savedKey = localStorage.getItem('northstar.LM_api_key');
    if (savedKey) {
        state.apiKey = savedKey;
        elements.apiKeyInput.value = savedKey;
        collapseApiKeySection();
    }
}

function saveApiKey() {
    const key = elements.apiKeyInput.value.trim();
    if (key) {
        state.apiKey = key;
        localStorage.setItem('northstar.LM_api_key', key);
        showTemporaryMessage(elements.saveKeyBtn, 'Saved!', 'Save');
        // Collapse after showing saved message
        setTimeout(() => {
            collapseApiKeySection();
        }, 1000);
    }
}

function collapseApiKeySection() {
    if (elements.apiKeyContainer && elements.apiKeyCollapsed) {
        elements.apiKeyContainer.classList.add('hidden');
        elements.apiKeyCollapsed.classList.remove('hidden');
    }
}

function expandApiKeySection() {
    if (elements.apiKeyContainer && elements.apiKeyCollapsed) {
        elements.apiKeyContainer.classList.remove('hidden');
        elements.apiKeyCollapsed.classList.add('hidden');
    }
}

function toggleApiKeyVisibility() {
    const type = elements.apiKeyInput.type === 'password' ? 'text' : 'password';
    elements.apiKeyInput.type = type;
    elements.toggleKeyBtn.textContent = type === 'password' ? '👁' : '🙈';
}

function showTemporaryMessage(button, message, originalText) {
    const originalHtml = button.innerHTML;
    button.textContent = message;
    setTimeout(() => {
        button.innerHTML = originalHtml;
    }, 1500);
}

// ============================================
// File Upload Handling
// ============================================

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.agentsDropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.agentsDropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.agentsDropZone.classList.remove('dragover');
    
    const allFiles = Array.from(e.dataTransfer.files);
    const mdFiles = allFiles.filter(f => f.name.endsWith('.md') || f.name.endsWith('.markdown'));
    
    if (mdFiles.length > 0) {
        processAgentFiles(mdFiles);
    } else if (allFiles.length > 0) {
        showError(`Please upload .md files. You selected: ${allFiles.map(f => f.name).join(', ')}`);
    }
}

function handleFileSelect(e) {
    const allFiles = Array.from(e.target.files);
    const mdFiles = allFiles.filter(f => f.name.endsWith('.md') || f.name.endsWith('.markdown'));
    
    if (mdFiles.length > 0) {
        processAgentFiles(mdFiles);
    } else if (allFiles.length > 0) {
        showError(`Please upload .md files. You selected: ${allFiles.map(f => f.name).join(', ')}`);
    }
    e.target.value = ''; // Reset for re-upload
}

async function processAgentFiles(files) {
    for (const file of files) {
        try {
            const content = await readFileContent(file);
            const agentData = parseAgentFile(content);
            
            if (agentData) {
                // Add filename and enabled state
                agentData.filename = file.name;
                agentData.displayName = agentData.title || file.name.replace('.md', '');
                agentData.enabled = true;
                agentData.id = 'agent-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                
                // Check for duplicates by filename
                const existingIndex = state.agents.findIndex(a => a.filename === file.name);
                if (existingIndex >= 0) {
                    // Preserve enabled state when updating
                    agentData.enabled = state.agents[existingIndex].enabled;
                    state.agents[existingIndex] = agentData;
                } else {
                    state.agents.push(agentData);
                }
            }
        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            showError(`Failed to parse ${file.name}: ${error.message}`);
        }
    }
    
    updateUI();
}

function readFileContent(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
    });
}

// ============================================
// Agent File Parsing
// ============================================

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractJsonSection(content, sectionName) {
    const safeName = escapeRegex(sectionName);
    const regex = new RegExp(`## ${safeName}[\\s\\S]*?\\n\`\`\`json\\s*\\n([\\s\\S]*?)\\n\`\`\``, 'i');
    const match = content.match(regex);
    if (!match || !match[1]) return null;
    try {
        return JSON.parse(match[1].trim());
    } catch (error) {
        console.warn('Failed to parse JSON section:', sectionName, error);
        return null;
    }
}

function stripBase64Fields(value, keyHint = '') {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        if (keyHint && keyHint.toLowerCase().includes('base64')) {
            return `[base64 omitted: ${value.length} chars]`;
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => stripBase64Fields(item));
    }
    if (typeof value === 'object') {
        const next = {};
        Object.entries(value).forEach(([key, entry]) => {
            next[key] = stripBase64Fields(entry, key);
        });
        return next;
    }
    return value;
}

function summarizeAttachments(attachments) {
    const summary = {};
    if (!attachments || typeof attachments !== 'object') return summary;

    Object.entries(attachments).forEach(([key, attachment]) => {
        if (!attachment) {
            summary[key] = null;
            return;
        }
        const base64Length = typeof attachment.base64 === 'string' ? attachment.base64.length : 0;
        summary[key] = {
            mimeType: attachment.mimeType || '',
            base64Length
        };
    });

    return summary;
}

function sanitizeExportPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const sanitized = stripBase64Fields(payload);
    if (payload.attachments && typeof payload.attachments === 'object') {
        sanitized.attachments = summarizeAttachments(payload.attachments);
    }
    return sanitized;
}

function buildExtendedContext(payload) {
    if (!payload) return '';
    const contextPayload = JSON.parse(JSON.stringify(payload));

    if (contextPayload.analysis) {
        delete contextPayload.analysis.summary;
        delete contextPayload.analysis.keyPoints;
        delete contextPayload.analysis.actionItems;
        delete contextPayload.analysis.sentiment;
        delete contextPayload.analysis.transcript;
    }

    return JSON.stringify(contextPayload, null, 2);
}

function parseAgentFile(content) {
    const result = {
        title: 'Untitled Meeting',
        date: null,
        sourceType: 'unknown',
        summary: '',
        keyPoints: '',
        actionItems: '',
        sentiment: '',
        transcript: '',
        payload: null,
        extendedContext: ''
    };
    
    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        
        // Get creation date
        const createdMatch = frontmatter.match(/created:\s*"?([^"\n]+)"?/);
        if (createdMatch) {
            try {
                const date = new Date(createdMatch[1].trim());
                result.date = date.toLocaleDateString('en-US', { 
                    year: 'numeric', month: 'short', day: 'numeric' 
                });
            } catch (e) {
                result.date = createdMatch[1].trim();
            }
        }
        
        const sourceMatch = frontmatter.match(/source_type:\s*(\w+)/);
        if (sourceMatch) result.sourceType = sourceMatch[1].trim();
    }
    
    // Parse title from heading (# Meeting Agent: <title>)
    const titleMatch = content.match(/# Meeting Agent:\s*(.+)/);
    if (titleMatch) {
        result.title = titleMatch[1].trim();
    }
    
    // Parse sections with flexible matching (handles both old and new formats)
    // Executive Summary or Summary
    const summaryMatch = content.match(/## (?:Executive )?Summary\n\n?([\s\S]*?)(?=\n---|\n## |$)/);
    if (summaryMatch) result.summary = summaryMatch[1].trim();
    
    // Key Points
    const keyPointsMatch = content.match(/## Key Points\n\n?([\s\S]*?)(?=\n---|\n## |$)/);
    if (keyPointsMatch) result.keyPoints = keyPointsMatch[1].trim();
    
    // Action Items
    const actionItemsMatch = content.match(/## Action Items\n\n?([\s\S]*?)(?=\n---|\n## |$)/);
    if (actionItemsMatch) result.actionItems = actionItemsMatch[1].trim();
    
    // Sentiment Analysis or Sentiment
    const sentimentMatch = content.match(/## Sentiment(?: Analysis)?\n\n?([\s\S]*?)(?=\n---|\n## |$)/);
    if (sentimentMatch) result.sentiment = sentimentMatch[1].trim();
    
    // Full Transcript (may be in code block)
    const transcriptMatch = content.match(/## Full Transcript[\s\S]*?```\n?([\s\S]*?)```/);
    if (transcriptMatch) {
        result.transcript = transcriptMatch[1].trim();
    } else {
        // Try without code block
        const plainTranscriptMatch = content.match(/## (?:Full )?Transcript\n\n?([\s\S]*?)(?=\n## |$)/);
        if (plainTranscriptMatch) result.transcript = plainTranscriptMatch[1].trim();
    }

    const exportPayload = extractJsonSection(content, 'Export Payload (JSON)');
    if (exportPayload) {
        const sanitizedPayload = sanitizeExportPayload(exportPayload);
        result.payload = sanitizedPayload;
        result.extendedContext = buildExtendedContext(sanitizedPayload);

        if (exportPayload.agent?.name) {
            result.title = exportPayload.agent.name;
        }

        if (exportPayload.agent?.readableDate) {
            result.date = exportPayload.agent.readableDate;
        } else if (exportPayload.agent?.created || exportPayload.exportedAt) {
            const dateInput = exportPayload.agent?.created || exportPayload.exportedAt;
            const parsedDate = new Date(dateInput);
            result.date = isNaN(parsedDate.getTime())
                ? dateInput
                : parsedDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }

        result.sourceType = exportPayload.agent?.sourceType || exportPayload.source?.inputMode || result.sourceType;

        const analysis = exportPayload.analysis || {};
        result.summary = analysis.summary || result.summary;
        result.keyPoints = analysis.keyPoints || result.keyPoints;
        result.actionItems = analysis.actionItems || result.actionItems;
        result.sentiment = analysis.sentiment || result.sentiment;
        result.transcript = analysis.transcript || result.transcript;
    }
    
    return result;
}

// ============================================
// Agent Management
// ============================================

function removeAgent(index) {
    state.agents.splice(index, 1);
    updateUI();
}

function clearAllAgents() {
    state.agents = [];
    state.insights = null;
    state.chatHistory = [];
    resetSignalMemory();
    resetMetrics();
    rlmPipeline.reset(); // Reset RLM pipeline state
    clearSavedState(); // Clear sessionStorage
    updateUI();
}

/**
 * Clear the chat and query caches
 * Clears: RLM query cache, chat history, and resets chat UI
 */
function clearChatAndCache() {
    // Clear RLM query cache
    rlmPipeline.clearCache();
    
    // Clear chat history
    state.chatHistory = [];
    resetSignalMemory();
    
    // Clear chat session storage
    sessionStorage.removeItem(STORAGE_KEYS.CHAT_HISTORY);
    sessionStorage.removeItem(STORAGE_KEYS.SIGNAL_STATE);
    sessionStorage.removeItem(STORAGE_KEYS.STATE_BLOCK_MD);
    sessionStorage.removeItem(STORAGE_KEYS.SUMMARY_LAST_TURN);
    sessionStorage.removeItem(STORAGE_KEYS.MEMORY_INDEX);
    sessionStorage.removeItem(STORAGE_KEYS.PROMPT_COUNTER);
    
    // Reset chat UI to welcome state
    if (elements.chatMessages) {
        elements.chatMessages.innerHTML = `
            <div class="chat-welcome-card">
                <div class="welcome-avatar">🤖</div>
                <div class="welcome-content">
                    <p class="welcome-title">Hello! I'm your Orchestrator AI</p>
                    <p class="welcome-text">I have access to your knowledge base. Ask me about decisions, action items, patterns, or insights from your meeting agents.</p>
                    <div class="welcome-suggestions">
                        <button class="suggestion-chip" data-query="What are the key action items across all meetings?">📋 Key action items</button>
                        <button class="suggestion-chip" data-query="What common themes appear in these meetings?">🔗 Common themes</button>
                        <button class="suggestion-chip" data-query="Summarize the main decisions made">✅ Main decisions</button>
                    </div>
                </div>
            </div>
        `;
        
        // Re-attach suggestion chip listeners
        elements.chatMessages.querySelectorAll('.suggestion-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const query = chip.dataset.query;
                if (query) {
                    elements.chatInput.value = query;
                    autoResizeTextarea();
                    sendChatMessage();
                }
            });
        });
    }
    
    // Show temporary feedback on button
    if (elements.clearCacheBtn) {
        const originalHtml = elements.clearCacheBtn.innerHTML;
        elements.clearCacheBtn.innerHTML = '✓ Cleared!';
        elements.clearCacheBtn.disabled = true;
        setTimeout(() => {
            elements.clearCacheBtn.innerHTML = originalHtml;
            elements.clearCacheBtn.disabled = false;
        }, 1500);
    }

    updateContextGauge();
    
    console.log('[Orchestrator] Chat history and query cache cleared');
}

// ============================================
// UI Updates
// ============================================

function updateUI() {
    updateAgentsList();
    updateButtonStates();
    updateSectionsVisibility();
    syncAgentsToRLM();
    updateContextGauge();
    saveState(); // Save state after UI updates
}

/**
 * Sync agents to the RLM context store
 * This keeps the RLM pipeline in sync with the current agent state
 */
function syncAgentsToRLM() {
    try {
        rlmPipeline.loadAgents(state.agents);
    } catch (error) {
        console.warn('[RLM] Failed to sync agents:', error.message);
    }
}

function updateAgentsList() {
    const totalCount = state.agents.length;
    const activeCount = state.agents.filter(a => a.enabled).length;
    
    elements.agentsCount.textContent = totalCount;
    if (elements.activeAgentsCount) {
        elements.activeAgentsCount.textContent = activeCount;
    }
    if (elements.chatAgentCount) {
        elements.chatAgentCount.textContent = activeCount;
    }
    
    // Update brain status
    updateBrainStatus();
    
    // Show/hide empty state
    if (elements.chainEmptyState) {
        elements.chainEmptyState.style.display = totalCount === 0 ? 'flex' : 'none';
    }
    
    // Render agent nodes
    const nodesHtml = state.agents.map((agent, index) => `
        <div class="agent-node ${agent.enabled ? '' : 'disabled'}" data-id="${agent.id}" data-index="${index}">
            <div class="agent-node-icon">${agent.enabled ? '📋' : '📋'}</div>
            <input type="text" 
                   class="agent-node-name" 
                   value="${escapeHtml(agent.displayName)}" 
                   data-index="${index}"
                   title="Click to edit name" />
            <div class="agent-node-meta">${agent.date || 'No date'}</div>
            <div class="agent-node-controls">
                <button class="agent-control-btn toggle-btn ${agent.enabled ? 'active' : ''}" 
                        data-index="${index}" 
                        title="${agent.enabled ? 'Disable agent' : 'Enable agent'}">
                    ${agent.enabled ? '●' : '○'}
                </button>
                <button class="agent-control-btn remove-btn" 
                        data-index="${index}" 
                        title="Remove agent permanently">
                    ✕
                </button>
            </div>
        </div>
    `).join('');
    
    // Keep the empty state element, append nodes
    if (elements.chainEmptyState) {
        elements.agentsList.innerHTML = '';
        elements.agentsList.appendChild(elements.chainEmptyState);
        elements.agentsList.insertAdjacentHTML('beforeend', nodesHtml);
        elements.chainEmptyState.style.display = totalCount === 0 ? 'flex' : 'none';
    } else {
        elements.agentsList.innerHTML = nodesHtml;
    }
    
    // Add event handlers
    elements.agentsList.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            toggleAgent(parseInt(btn.dataset.index));
        });
    });
    
    elements.agentsList.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            removeAgent(parseInt(btn.dataset.index));
        });
    });
    
    elements.agentsList.querySelectorAll('.agent-node-name').forEach(input => {
        input.addEventListener('change', (e) => {
            updateAgentName(parseInt(input.dataset.index), e.target.value);
        });
        input.addEventListener('blur', (e) => {
            updateAgentName(parseInt(input.dataset.index), e.target.value);
        });
    });
}

function toggleAgent(index) {
    if (state.agents[index]) {
        state.agents[index].enabled = !state.agents[index].enabled;
        updateUI();
    }
}

function updateAgentName(index, newName) {
    if (state.agents[index] && newName.trim()) {
        state.agents[index].displayName = newName.trim();
    }
}

function updateBrainStatus() {
    const brainStatusEl = elements.brainStatus || document.getElementById('brain-status');
    if (!brainStatusEl) return;
    
    const activeCount = state.agents.filter(a => a.enabled).length;
    const statusDot = brainStatusEl.querySelector('.status-dot') || document.createElement('span');
    
    if (activeCount === 0) {
        brainStatusEl.innerHTML = '<span class="status-dot"></span> Waiting for agents...';
        brainStatusEl.classList.remove('ready');
    } else if (activeCount === 1) {
        brainStatusEl.innerHTML = '<span class="status-dot"></span> Ready • 1 agent active';
        brainStatusEl.classList.add('ready');
    } else {
        brainStatusEl.innerHTML = `<span class="status-dot"></span> Ready • ${activeCount} agents active`;
        brainStatusEl.classList.add('ready');
    }
}

function autoResizeTextarea() {
    const textarea = elements.chatInput;
    if (!textarea) return;
    
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    updateContextGauge();
}

function updateButtonStates() {
    const activeAgents = state.agents.filter(a => a.enabled);
    const hasEnoughAgents = activeAgents.length >= 2;
    const hasApiKey = state.apiKey.trim().length > 0;
    
    elements.generateInsightsBtn.disabled = !hasEnoughAgents || !hasApiKey || state.isProcessing;
    
    if (activeAgents.length === 0) {
        elements.generateInsightsBtn.title = 'Enable at least 2 agents for cross-meeting insights';
    } else if (activeAgents.length === 1) {
        elements.generateInsightsBtn.title = 'Enable at least 2 agents for cross-meeting insights';
    } else if (!hasApiKey) {
        elements.generateInsightsBtn.title = 'Enter your API key first';
    } else {
        elements.generateInsightsBtn.title = `Generate insights from ${activeAgents.length} active agents`;
    }
    
    // Update chat indicator
    if (elements.chatKbIndicator) {
        const indicatorDot = elements.chatKbIndicator.querySelector('.indicator-dot');
        if (indicatorDot) {
            if (activeAgents.length > 0) {
                indicatorDot.classList.add('active');
            } else {
                indicatorDot.classList.remove('active');
            }
        }
    }

    if (elements.runTestPromptingBtn) {
        const hasActiveAgents = activeAgents.length > 0;
        elements.runTestPromptingBtn.disabled = !hasActiveAgents || !hasApiKey || state.isProcessing;
        if (!hasActiveAgents) {
            elements.runTestPromptingBtn.title = 'Upload and enable at least one agent to run tests';
        } else if (!hasApiKey) {
            elements.runTestPromptingBtn.title = 'Enter your API key first';
        } else if (state.isProcessing) {
            elements.runTestPromptingBtn.title = 'Finish the current task before running a test';
        } else {
            elements.runTestPromptingBtn.title = 'Run a curated prompt test';
        }
    }
}

// ============================================
// Test Prompting
// ============================================

function initializeTestPrompts() {
    if (testPromptState.prompts.length === 0) {
        testPromptState.prompts = DEFAULT_TEST_PROMPTS.map(prompt => createTestPrompt(prompt));
    }
    updateTestSelectedCount();
}

function getTestSettingsSnapshot(source = state.settings) {
    return TEST_SETTINGS_KEYS.reduce((acc, key) => {
        acc[key] = source[key];
        return acc;
    }, {});
}

function normalizeTestSettings(settings) {
    const normalized = { ...settings };
    if (!normalized.useRLM) {
        normalized.rlmAuto = false;
    }
    if (!normalized.enableFocusShadow) {
        normalized.enableFocusEpisodes = false;
    }
    if (normalized.enableFocusEpisodes) {
        normalized.enableFocusShadow = true;
    }
    return normalized;
}

function initializeTestSettings() {
    testPromptState.settings = normalizeTestSettings(getTestSettingsSnapshot());
    updateTestSettingsUI();
}

function updateTestSettingsUI() {
    if (!testPromptState.settings) return;

    if (elements.testRlmToggle) {
        elements.testRlmToggle.checked = testPromptState.settings.useRLM;
    }
    if (elements.testRlmAutoToggle) {
        elements.testRlmAutoToggle.checked = testPromptState.settings.rlmAuto;
        elements.testRlmAutoToggle.disabled = !testPromptState.settings.useRLM;
    }
    if (elements.testShadowPromptToggle) {
        elements.testShadowPromptToggle.checked = testPromptState.settings.enableShadowPrompt;
    }
    if (elements.testRetrievalPromptToggle) {
        elements.testRetrievalPromptToggle.checked = testPromptState.settings.enableRetrievalPrompt;
    }
    if (elements.testFocusShadowToggle) {
        elements.testFocusShadowToggle.checked = testPromptState.settings.enableFocusShadow;
    }
    if (elements.testFocusEpisodesToggle) {
        elements.testFocusEpisodesToggle.checked = testPromptState.settings.enableFocusEpisodes;
        elements.testFocusEpisodesToggle.disabled = !testPromptState.settings.enableFocusShadow;
    }
    if (elements.testPromptBudgetToggle) {
        elements.testPromptBudgetToggle.checked = testPromptState.settings.enablePromptBudgeting;
    }
    if (elements.testMemoryDebugToggle) {
        elements.testMemoryDebugToggle.checked = testPromptState.settings.showMemoryDebug;
    }
}

function updateTestSetting(key, value) {
    if (!testPromptState.settings) {
        testPromptState.settings = normalizeTestSettings(getTestSettingsSnapshot());
    }
    testPromptState.settings = normalizeTestSettings({
        ...testPromptState.settings,
        [key]: value
    });
    updateTestSettingsUI();
}

function formatTestSettingsSummary(settings) {
    if (!settings) return '';
    const status = (flag) => flag ? 'On' : 'Off';
    return [
        `RLM: ${status(settings.useRLM)}`,
        `RLM Auto: ${status(settings.rlmAuto)}`,
        `Shadow Prompt: ${status(settings.enableShadowPrompt)}`,
        `Retrieval Prompt: ${status(settings.enableRetrievalPrompt)}`,
        `Focus Shadow: ${status(settings.enableFocusShadow)}`,
        `Focus Episodes: ${status(settings.enableFocusEpisodes)}`,
        `Prompt Guardrails: ${status(settings.enablePromptBudgeting)}`,
        `Memory Debug: ${status(settings.showMemoryDebug)}`
    ].join(' • ');
}

function updateTestSelectedCount() {
    testPromptState.selectedCount = testPromptState.prompts.filter(prompt => prompt.selected).length;
    if (elements.testSelectedCount) {
        elements.testSelectedCount.textContent = testPromptState.selectedCount;
    }
}

function setTestPromptError(message = '') {
    if (!elements.testPromptError) return;
    if (!message) {
        elements.testPromptError.classList.add('hidden');
        elements.testPromptError.textContent = '';
        return;
    }
    elements.testPromptError.textContent = message;
    elements.testPromptError.classList.remove('hidden');
}

function renderTestPromptList() {
    if (!elements.testPromptList) return;
    elements.testPromptList.innerHTML = '';

    testPromptState.prompts.forEach((prompt) => {
        const row = document.createElement('div');
        row.className = 'test-prompt-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = prompt.selected;
        checkbox.addEventListener('change', () => {
            if (checkbox.checked && testPromptState.selectedCount >= TEST_PROMPT_LIMIT) {
                checkbox.checked = false;
                setTestPromptError(`You can select up to ${TEST_PROMPT_LIMIT} prompts.`);
                return;
            }
            prompt.selected = checkbox.checked;
            updateTestSelectedCount();
            setTestPromptError('');
        });

        const content = document.createElement('div');
        const textarea = document.createElement('textarea');
        textarea.value = prompt.text;
        textarea.placeholder = 'Enter a test prompt...';
        textarea.addEventListener('input', () => {
            prompt.text = textarea.value;
        });
        const tag = document.createElement('div');
        tag.className = 'prompt-tag';
        tag.textContent = prompt.isCustom ? 'Custom' : 'Preloaded';
        content.appendChild(textarea);
        content.appendChild(tag);

        const actionSlot = document.createElement('div');
        if (prompt.isCustom) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-text btn-sm';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => {
                testPromptState.prompts = testPromptState.prompts.filter(item => item.id !== prompt.id);
                updateTestSelectedCount();
                renderTestPromptList();
            });
            actionSlot.appendChild(removeBtn);
        } else {
            actionSlot.className = 'prompt-tag';
            actionSlot.textContent = 'Preset';
        }

        row.appendChild(checkbox);
        row.appendChild(content);
        row.appendChild(actionSlot);
        elements.testPromptList.appendChild(row);
    });
}

function openTestPromptingModal() {
    initializeTestPrompts();
    initializeTestSettings();
    renderTestPromptList();
    setTestPromptError('');
    if (elements.testPromptingModal) {
        elements.testPromptingModal.classList.remove('hidden');
    }
}

function closeTestPromptingModal() {
    if (elements.testPromptingModal) {
        elements.testPromptingModal.classList.add('hidden');
    }
    setTestPromptError('');
}

function addCustomTestPrompt() {
    const canSelect = testPromptState.selectedCount < TEST_PROMPT_LIMIT;
    const prompt = createTestPrompt('', { selected: canSelect, isCustom: true });
    if (!canSelect) {
        setTestPromptError(`You can only select up to ${TEST_PROMPT_LIMIT} prompts.`);
    }
    testPromptState.prompts.push(prompt);
    updateTestSelectedCount();
    renderTestPromptList();
    const lastTextarea = elements.testPromptList?.querySelector('textarea:last-of-type');
    if (lastTextarea) {
        lastTextarea.focus();
    }
}

function getSelectedTestPrompts() {
    return testPromptState.prompts
        .filter(prompt => prompt.selected)
        .map(prompt => ({
            id: prompt.id,
            text: prompt.text.trim(),
            isCustom: prompt.isCustom
        }));
}

function applyTestSettings(settings) {
    const normalized = normalizeTestSettings(settings);
    TEST_SETTINGS_KEYS.forEach((key) => {
        if (typeof normalized[key] !== 'undefined') {
            state.settings[key] = normalized[key];
        }
    });
    state.settings.processingMode = deriveProcessingMode(state.settings);
    updateSettingsUI();
    applyRlmFeatureFlags();
}

function resetTestRunningScreen(totalPrompts) {
    if (elements.testProgressFill) {
        elements.testProgressFill.style.width = '0%';
    }
    if (elements.testProgressLabel) {
        elements.testProgressLabel.textContent = 'Preparing prompts...';
    }
    if (elements.testProgressCount) {
        elements.testProgressCount.textContent = `0 / ${totalPrompts}`;
    }
    if (elements.testStatusStream) {
        elements.testStatusStream.innerHTML = '';
    }
}

function updateTestProgress(currentIndex, totalPrompts, label) {
    const percent = totalPrompts > 0 ? Math.round((currentIndex / totalPrompts) * 100) : 0;
    if (elements.testProgressFill) {
        elements.testProgressFill.style.width = `${percent}%`;
    }
    if (elements.testProgressLabel) {
        elements.testProgressLabel.textContent = label;
    }
    if (elements.testProgressCount) {
        elements.testProgressCount.textContent = `${currentIndex} / ${totalPrompts}`;
    }
}

function addTestStatusLine(message, emphasis = '') {
    if (!elements.testStatusStream) return;
    const line = document.createElement('div');
    line.className = 'test-status-line';
    const timestamp = new Date().toLocaleTimeString();
    line.innerHTML = `<span>${timestamp}</span> <strong>${escapeHtml(emphasis)}</strong> ${escapeHtml(message)}`;
    elements.testStatusStream.appendChild(line);
    elements.testStatusStream.scrollTop = elements.testStatusStream.scrollHeight;
}

function addTestStreamingLine(promptText, emphasis = '') {
    if (!elements.testStatusStream) return null;
    const line = document.createElement('div');
    line.className = 'test-status-line streaming';
    const timestamp = new Date().toLocaleTimeString();
    line.innerHTML = `
        <span>${timestamp}</span>
        <strong>${escapeHtml(emphasis)}</strong>
        <span class="test-stream-status">Awaiting response...</span>
        <div class="test-stream-prompt">${escapeHtml(promptText)}</div>
        <div class="test-stream-body">
            <span class="test-stream-text"></span>
            <span class="streaming-cursor">▍</span>
        </div>
    `;
    elements.testStatusStream.appendChild(line);
    elements.testStatusStream.scrollTop = elements.testStatusStream.scrollHeight;

    return {
        line,
        status: line.querySelector('.test-stream-status'),
        text: line.querySelector('.test-stream-text'),
        cursor: line.querySelector('.streaming-cursor')
    };
}

function updateTestStreamStatus(streamLine, statusText) {
    if (!streamLine?.status) return;
    streamLine.status.textContent = statusText;
}

function updateTestStreamingLine(streamLine, chunk) {
    if (!streamLine?.text || !chunk) return;
    streamLine.text.textContent += chunk;
    elements.testStatusStream.scrollTop = elements.testStatusStream.scrollHeight;
}

function finalizeTestStreamingLine(streamLine, { status = 'complete', message = '' } = {}) {
    if (!streamLine?.line) return;
    const isError = status === 'error';
    streamLine.line.classList.toggle('streaming-error', isError);
    updateTestStreamStatus(streamLine, isError ? 'Streaming error' : 'Stream complete');
    if (isError && streamLine.text) {
        streamLine.text.textContent = message || 'Unknown error';
    }
    if (streamLine.cursor) {
        streamLine.cursor.remove();
    }
    elements.testStatusStream.scrollTop = elements.testStatusStream.scrollHeight;
}

function showTestRunningScreen() {
    if (elements.testRunningScreen) {
        elements.testRunningScreen.classList.remove('hidden');
    }
}

function hideTestRunningScreen() {
    if (elements.testRunningScreen) {
        elements.testRunningScreen.classList.add('hidden');
    }
}

function closeTestAnalyticsModal() {
    if (elements.testAnalyticsModal) {
        elements.testAnalyticsModal.classList.add('hidden');
    }
}

function showTestAnalyticsModal() {
    if (elements.testAnalyticsModal) {
        elements.testAnalyticsModal.classList.remove('hidden');
    }
}

function deployTestAgent() {
    const selectedPrompts = getSelectedTestPrompts();
    if (selectedPrompts.length === 0) {
        setTestPromptError('Select at least one prompt to deploy the test agent.');
        return;
    }
    if (selectedPrompts.length > TEST_PROMPT_LIMIT) {
        setTestPromptError(`You can select up to ${TEST_PROMPT_LIMIT} prompts.`);
        return;
    }
    const emptyPrompt = selectedPrompts.find(prompt => !prompt.text);
    if (emptyPrompt) {
        setTestPromptError('All selected prompts must include text.');
        return;
    }
    if (!state.apiKey.trim()) {
        setTestPromptError('Enter your API key before deploying a test agent.');
        return;
    }
    const activeAgents = state.agents.filter(a => a.enabled);
    if (activeAgents.length === 0) {
        setTestPromptError('Upload and enable at least one agent before running tests.');
        return;
    }

    closeTestPromptingModal();
    const testSettings = testPromptState.settings
        ? { ...testPromptState.settings }
        : getTestSettingsSnapshot();
    runTestSequence(selectedPrompts, testSettings);
}

function getPromptProcessingMode(promptText) {
    const rlmEnabled = state.settings.useRLM;
    const rlmAuto = state.settings.rlmAuto;
    const useREPL = rlmEnabled && rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(promptText, { auto: rlmAuto });
    const useRLM = rlmEnabled && !useREPL && rlmPipeline.shouldUseRLM(promptText, { auto: rlmAuto });
    const processingMode = useREPL ? 'repl' : (useRLM ? 'rlm' : 'direct');

    return { useREPL, useRLM, processingMode };
}

async function runPromptWithMetrics(promptText, labelPrefix = 'Test', streamHandlers = null) {
    const queryPreview = promptText.substring(0, 50) + (promptText.length > 50 ? '...' : '');
    const { useREPL, useRLM, processingMode } = getPromptProcessingMode(promptText);

    startPromptGroup(`${labelPrefix}: ${queryPreview}`, useRLM || useREPL, processingMode);

    try {
        const response = await chatWithAgents(promptText, null, streamHandlers);
        if (activePromptGroup) {
            activePromptGroup.promptPreview = queryPreview;
            activePromptGroup.response = response;
        }
        return response;
    } catch (error) {
        if (activePromptGroup) {
            activePromptGroup.promptPreview = queryPreview;
            activePromptGroup.response = `Error: ${error.message}`;
        }
        throw error;
    } finally {
        endPromptGroup();
    }
}

async function runTestSequence(prompts, testSettings) {
    const previousSettings = getTestSettingsSnapshot();

    state.isProcessing = true;
    updateButtonStates();
    showTestRunningScreen();
    resetTestRunningScreen(prompts.length);
    addTestStatusLine('Initializing test run...', 'Setup');

    const normalizedTestSettings = normalizeTestSettings(testSettings || getTestSettingsSnapshot());
    applyTestSettings(normalizedTestSettings);

    testPromptState.run = {
        startedAt: new Date(),
        settings: normalizedTestSettings,
        prompts,
        startIndex: currentMetrics.promptLogs.length,
        results: []
    };

    for (let i = 0; i < prompts.length; i += 1) {
        const prompt = prompts[i];
        const promptLabel = `Prompt ${i + 1}`;
        updateTestProgress(i + 1, prompts.length, `Running ${promptLabel}`);
        const streamLine = addTestStreamingLine(prompt.text, promptLabel);
        const streamHandlers = streamLine
            ? {
                onStart: () => updateTestStreamStatus(streamLine, 'Streaming response...'),
                onToken: (chunk) => updateTestStreamingLine(streamLine, chunk),
                onComplete: () => finalizeTestStreamingLine(streamLine, { status: 'complete' })
            }
            : null;

        try {
            const response = await runPromptWithMetrics(prompt.text, 'Test', streamHandlers);
            const logEntry = currentMetrics.promptLogs[currentMetrics.promptLogs.length - 1] || null;
            testPromptState.run.results.push({
                prompt: prompt.text,
                response,
                log: logEntry
            });
            addTestStatusLine('Response received.', promptLabel);
        } catch (error) {
            const logEntry = currentMetrics.promptLogs[currentMetrics.promptLogs.length - 1] || null;
            testPromptState.run.results.push({
                prompt: prompt.text,
                response: '',
                error: error.message || 'Unknown error',
                log: logEntry
            });
            if (streamLine) {
                finalizeTestStreamingLine(streamLine, { status: 'error', message: error.message || 'Unknown error' });
            }
            addTestStatusLine(`Error: ${error.message || 'Unknown error'}`, promptLabel);
        }
    }

    updateTestProgress(prompts.length, prompts.length, 'Test complete');
    addTestStatusLine('All prompts complete. Generating analytics...', 'Complete');

    applyTestSettings(previousSettings);
    state.isProcessing = false;
    updateButtonStates();
    hideTestRunningScreen();

    renderTestAnalytics();
    showTestAnalyticsModal();
}

function renderTestAnalytics() {
    if (!testPromptState.run) return;
    const logs = currentMetrics.promptLogs.slice(testPromptState.run.startIndex);

    const totals = logs.reduce((acc, log) => {
        acc.inputTokens += log?.tokens?.input || 0;
        acc.outputTokens += log?.tokens?.output || 0;
        acc.totalCost += log?.cost?.total || 0;
        acc.totalTime += log?.responseTime || 0;
        return acc;
    }, { inputTokens: 0, outputTokens: 0, totalCost: 0, totalTime: 0 });

    const totalPrompts = testPromptState.run.prompts.length;
    const avgResponse = totalPrompts > 0 ? Math.round(totals.totalTime / totalPrompts) : 0;
    const settingsSummary = formatTestSettingsSummary(testPromptState.run.settings);

    if (elements.testAnalyticsSummary) {
        elements.testAnalyticsSummary.innerHTML = `
            <div class="test-summary-card">
                <h4>Prompts</h4>
                <p>${totalPrompts}</p>
            </div>
            <div class="test-summary-card">
                <h4>Tokens</h4>
                <p>${formatTokens(totals.inputTokens + totals.outputTokens)}</p>
            </div>
            <div class="test-summary-card">
                <h4>Est. Cost</h4>
                <p>${formatCost(totals.totalCost)}</p>
            </div>
            <div class="test-summary-card">
                <h4>Avg Response</h4>
                <p>${formatTime(avgResponse)}</p>
            </div>
            <div class="test-summary-card test-summary-card-wide">
                <h4>Test Settings</h4>
                <p>${escapeHtml(settingsSummary)}</p>
            </div>
        `;
    }

    if (elements.testAnalyticsList) {
        elements.testAnalyticsList.innerHTML = testPromptState.run.results.map((result, index) => {
            const log = result.log;
            const tokens = log?.tokens || { input: 0, output: 0, total: 0 };
            const cost = log?.cost || { total: 0 };
            const model = log?.model ? formatModelName(log.model) : state.settings.model;
            const responseTime = log?.responseTime || 0;
            const status = result.error ? 'Error' : 'Complete';
            return `
                <div class="test-analytics-item">
                    <h5>Prompt ${index + 1}: ${escapeHtml(result.prompt)}</h5>
                    <p>Status: ${status}</p>
                    <div class="test-analytics-meta">
                        <span>Model: ${escapeHtml(model)}</span>
                        <span>Tokens: ${formatTokens(tokens.input + tokens.output)}</span>
                        <span>Cost: ${formatCost(cost.total)}</span>
                        <span>Time: ${formatTime(responseTime)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function buildTestReportHtml() {
    if (!testPromptState.run) return '';
    const logs = currentMetrics.promptLogs.slice(testPromptState.run.startIndex);
    const totals = logs.reduce((acc, log) => {
        acc.inputTokens += log?.tokens?.input || 0;
        acc.outputTokens += log?.tokens?.output || 0;
        acc.totalCost += log?.cost?.total || 0;
        acc.totalTime += log?.responseTime || 0;
        return acc;
    }, { inputTokens: 0, outputTokens: 0, totalCost: 0, totalTime: 0 });

    const totalPrompts = testPromptState.run.prompts.length;
    const avgResponse = totalPrompts > 0 ? Math.round(totals.totalTime / totalPrompts) : 0;
    const timestamp = testPromptState.run.startedAt.toLocaleString();
    const settingsSummary = formatTestSettingsSummary(testPromptState.run.settings);

    const promptRows = testPromptState.run.results.map((result, index) => {
        const log = result.log;
        const tokens = log?.tokens || { input: 0, output: 0, total: 0 };
        const cost = log?.cost || { total: 0 };
        const model = log?.model ? formatModelName(log.model) : state.settings.model;
        const responseTime = log?.responseTime || 0;
        const status = result.error ? `Error: ${result.error}` : 'Complete';
        return `
            <tr>
                <td>${index + 1}</td>
                <td>${escapeHtml(result.prompt)}</td>
                <td>${escapeHtml(model)}</td>
                <td>${formatTokens(tokens.input + tokens.output)}</td>
                <td>${formatCost(cost.total)}</td>
                <td>${formatTime(responseTime)}</td>
                <td>${escapeHtml(status)}</td>
            </tr>
        `;
    }).join('');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>northstar.LM Test Prompting Report</title>
            <style>
                body { font-family: 'Source Sans 3', Arial, sans-serif; margin: 32px; color: #0a0e17; }
                h1 { color: #b17d1b; margin-bottom: 8px; }
                h2 { margin-top: 32px; }
                .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 24px 0; }
                .summary-card { padding: 16px; border-radius: 12px; border: 1px solid #e0d6c3; background: #f8f4ee; }
                table { width: 100%; border-collapse: collapse; margin-top: 16px; }
                th, td { text-align: left; border-bottom: 1px solid #e0d6c3; padding: 12px; vertical-align: top; }
                th { background: #f1e9dc; }
            </style>
        </head>
        <body>
            <h1>northstar.LM Test Prompting Report</h1>
            <p>Generated ${escapeHtml(timestamp)}</p>
            <p><strong>Settings:</strong> ${escapeHtml(settingsSummary)}</p>
            <p>This report documents a batch test run of orchestrator prompts for meeting-minute analysis.</p>
            <div class="summary">
                <div class="summary-card">
                    <strong>Prompts</strong>
                    <div>${totalPrompts}</div>
                </div>
                <div class="summary-card">
                    <strong>Total Tokens</strong>
                    <div>${formatTokens(totals.inputTokens + totals.outputTokens)}</div>
                </div>
                <div class="summary-card">
                    <strong>Est. Cost</strong>
                    <div>${formatCost(totals.totalCost)}</div>
                </div>
                <div class="summary-card">
                    <strong>Avg Response</strong>
                    <div>${formatTime(avgResponse)}</div>
                </div>
                <div class="summary-card">
                    <strong>Settings</strong>
                    <div>${escapeHtml(settingsSummary)}</div>
                </div>
            </div>
            <h2>Prompt Metrics</h2>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Prompt</th>
                        <th>Model</th>
                        <th>Tokens</th>
                        <th>Cost</th>
                        <th>Time</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${promptRows}
                </tbody>
            </table>
        </body>
        </html>
    `;
}

function exportTestReportHtml() {
    const html = buildTestReportHtml();
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `northstar-test-report-${Date.now()}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function updateSectionsVisibility() {
    // Insights shown after generation
    if (state.insights) {
        elements.insightsSection.classList.remove('hidden');
    } else {
        elements.insightsSection.classList.add('hidden');
    }
    
    // Chat is now always visible as part of the knowledge base section
    // Just update its visual state based on agent availability
    const hasActiveAgents = state.agents.filter(a => a.enabled).length > 0;
    if (elements.chatContainer) {
        if (hasActiveAgents) {
            elements.chatContainer.classList.remove('disabled');
            elements.chatInput.disabled = false;
            elements.chatSendBtn.disabled = false;
        } else {
            elements.chatContainer.classList.add('disabled');
            elements.chatInput.disabled = true;
            elements.chatSendBtn.disabled = true;
        }
    }
}

// ============================================
// Context Window Gauge
// ============================================

function estimateTokens(text) {
    if (!text) return 0;
    const trimmed = String(text).trim();
    if (!trimmed) return 0;
    return Math.ceil(trimmed.length / 4);
}

const CONTEXT_GAUGE_MESSAGE_OVERHEAD = 4;
let contextGaugeRunId = 0;

const SIGNAL_MEMORY_LIMITS = {
    stateBlockMaxTokens: 1200,
    summaryMinTokens: 200,
    summaryMaxTokens: 500,
    workingWindowMaxTokens: 900,
    retrievalMaxTokens: 2400,
    chunkMaxTokens: 350
};

const RLM_SUBQUERY_SYSTEM_PROMPT = `You are analyzing meeting data to answer a specific question.
Be concise and focus only on information relevant to the question.
If the information is not available in the provided context, say so briefly.`;

function estimateMessageTokens(message) {
    if (!message || !message.content) return 0;
    return estimateTokens(message.content) + CONTEXT_GAUGE_MESSAGE_OVERHEAD;
}

function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateTokensFromParts(parts) {
    if (!Array.isArray(parts)) return 0;
    return parts.reduce((sum, part) => {
        if (typeof part === 'number') return sum + part;
        return sum + estimateTokens(part);
    }, 0);
}

function formatTokenCount(value) {
    if (value >= 1000000) {
        return `${(value / 1000000).toFixed(1)}M`;
    }
    if (value >= 1000) {
        return `${Math.round(value / 100) / 10}k`;
    }
    return `${value}`;
}

function getDraftQuery() {
    return elements.chatInput ? elements.chatInput.value.trim() : '';
}

function getHistoryForPrompt(systemPrompt, userPrompt) {
    return buildSignalWeightedHistory(systemPrompt, userPrompt);
}

function estimatePromptTokens(systemPrompt, historyMessages, userPrompt) {
    const systemTokens = estimateMessageTokens({ role: 'system', content: systemPrompt });
    const historyTokens = estimateMessagesTokens(historyMessages);
    const userTokens = estimateMessageTokens({ role: 'user', content: userPrompt || '' });
    return systemTokens + historyTokens + userTokens;
}

function buildRlmUserPrompt(agentContext, query) {
    return `Context from meetings:
${agentContext}

Question: ${query}

Provide a focused answer based only on the context above.`;
}

function buildSubLmUserPrompt(contextSlice, query) {
    if (!contextSlice) {
        return `Question: ${query}`;
    }
    return `Context:
${contextSlice}

Question: ${query}`;
}

function normalizeBulletText(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function truncateTextToTokenBudget(text, maxTokens) {
    if (!text) return '';
    const tokenEstimate = estimateTokens(text);
    if (tokenEstimate <= maxTokens) return text.trim();

    const maxChars = Math.max(maxTokens * 4, 0);
    let truncated = text.slice(0, maxChars);
    const lastBullet = truncated.lastIndexOf('\n- ');
    const lastSentence = truncated.lastIndexOf('. ');
    const cutPoint = Math.max(lastBullet, lastSentence);
    if (cutPoint > 50) {
        truncated = truncated.slice(0, cutPoint).trim();
    }
    return `${truncated.trim()}...`;
}

function sanitizeHistoryChunk(text, maxTokens = SIGNAL_MEMORY_LIMITS.chunkMaxTokens) {
    if (!text) return '';
    const boilerplatePatterns = [
        /^as an ai/i,
        /^i (?:cannot|can't|won't|am unable)/i,
        /^sorry/i,
        /^note:/i
    ];

    const lines = String(text)
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const bulletLines = [];
    lines.forEach(line => {
        if (boilerplatePatterns.some(pattern => pattern.test(line))) {
            return;
        }
        if (/^[-*•]\s+/.test(line)) {
            bulletLines.push(line.replace(/^[-*•]\s+/, '- '));
            return;
        }
        if (/^\d+\.\s+/.test(line)) {
            bulletLines.push(line.replace(/^\d+\.\s+/, '- '));
            return;
        }
        const sentences = line.split(/(?<=[.!?])\s+/);
        sentences.forEach(sentence => {
            const trimmed = sentence.trim();
            if (trimmed) {
                bulletLines.push(`- ${trimmed}`);
            }
        });
    });

    const seen = new Set();
    const deduped = [];
    bulletLines.forEach(line => {
        const normalized = normalizeBulletText(line);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        deduped.push(line);
    });

    const sanitized = deduped.join('\n');
    return truncateTextToTokenBudget(sanitized, maxTokens);
}

function extractSentences(text) {
    if (!text) return [];
    return String(text)
        .replace(/\r/g, '\n')
        .split(/(?<=[.!?])\s+/)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length > 0);
}

function summarizeAssistantResponse(responseText) {
    if (!responseText) return '';
    let summary = sanitizeHistoryChunk(responseText, SIGNAL_MEMORY_LIMITS.summaryMaxTokens);
    const summaryTokens = estimateTokens(summary);

    if (summaryTokens < SIGNAL_MEMORY_LIMITS.summaryMinTokens) {
        const sentences = extractSentences(responseText);
        const additional = [];
        for (const sentence of sentences) {
            const bullet = `- ${sentence}`;
            additional.push(bullet);
            const combined = [summary, ...additional].filter(Boolean).join('\n');
            if (estimateTokens(combined) >= SIGNAL_MEMORY_LIMITS.summaryMinTokens) {
                summary = combined;
                break;
            }
            if (estimateTokens(combined) >= SIGNAL_MEMORY_LIMITS.summaryMaxTokens) {
                summary = truncateTextToTokenBudget(combined, SIGNAL_MEMORY_LIMITS.summaryMaxTokens);
                break;
            }
        }
    }

    return truncateTextToTokenBudget(summary, SIGNAL_MEMORY_LIMITS.summaryMaxTokens);
}

function addUniqueItems(target, items, maxItems = 20) {
    const seen = new Set(target.map(item => normalizeBulletText(item)));
    items.forEach(item => {
        const normalized = normalizeBulletText(item);
        if (!normalized || seen.has(normalized)) return;
        target.push(item);
        seen.add(normalized);
    });
    if (target.length > maxItems) {
        target.splice(0, target.length - maxItems);
    }
}

function extractEntities(text) {
    if (!text) return [];
    const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) || [];
    const stopWords = new Set(['Meeting', 'Summary', 'Action', 'Actions', 'Decision', 'Decisions', 'Open', 'Question', 'Questions']);
    return [...new Set(matches.filter(match => !stopWords.has(match)))];
}

function updateSignalState(summary, userPrompt) {
    if (!summary) return;
    const lines = summary.split('\n').map(line => line.replace(/^[-*•]\s+/, '').trim()).filter(Boolean);

    const decisions = lines.filter(line => /decided|decision|approved|agreed|commit|commitment/i.test(line));
    const actionItems = lines.filter(line => /action item|todo|follow[- ]?up|owner|assign|due|deliverable/i.test(line));
    const openQuestions = lines.filter(line => /open question|question|unresolved|tbd|unknown/i.test(line));
    const constraints = lines.filter(line => /constraint|assumption|dependency|risk|limit/i.test(line));

    addUniqueItems(state.signalState.decisions, decisions);
    addUniqueItems(state.signalState.actionItems, actionItems);
    addUniqueItems(state.signalState.openQuestions, openQuestions);
    addUniqueItems(state.signalState.constraints, constraints);
    addUniqueItems(state.signalState.entities, extractEntities(summary));

    const pointer = `P${state.promptCounter}: ${userPrompt.substring(0, 80)}${userPrompt.length > 80 ? '…' : ''}`;
    addUniqueItems(state.signalState.sourcePointers, [pointer], 30);
}

function buildStateBlockMarkdown() {
    const sections = [
        { title: 'Decisions', items: state.signalState.decisions },
        { title: 'Action Items (owner + due date)', items: state.signalState.actionItems },
        { title: 'Open Questions', items: state.signalState.openQuestions },
        { title: 'Key Constraints / Assumptions', items: state.signalState.constraints },
        { title: 'Entities / Glossary', items: state.signalState.entities },
        { title: 'Source pointers', items: state.signalState.sourcePointers }
    ];

    const content = sections.map(section => {
        const bullets = section.items.length > 0
            ? section.items.map(item => `- ${item}`).join('\n')
            : '- None';
        return `## ${section.title}\n${bullets}`;
    }).join('\n\n');

    const truncated = truncateTextToTokenBudget(content, SIGNAL_MEMORY_LIMITS.stateBlockMaxTokens);
    state.stateBlockMarkdown = truncated;
    return truncated;
}

function classifyPromptTags(prompt) {
    const tags = new Set();
    const text = (prompt || '').toLowerCase();
    if (/decision|decide|approve|agreement|commit/.test(text)) tags.add('decisions');
    if (/action|todo|owner|assign|due|deadline|follow up/.test(text)) tags.add('actions');
    if (/risk|blocker|issue|concern/.test(text)) tags.add('risks');
    if (/contradiction|conflict|inconsistent/.test(text)) tags.add('contradictions');
    if (/who|owner|team|person|stakeholder/.test(text)) tags.add('entities');
    if (/when|deadline|date|timeline/.test(text)) tags.add('deadlines');
    if (/question|unknown|open/.test(text)) tags.add('open_questions');
    return Array.from(tags).slice(0, 3);
}

function buildMemoryIndexEntry(summary, userPrompt, tags) {
    const cleanSummary = sanitizeHistoryChunk(summary, SIGNAL_MEMORY_LIMITS.chunkMaxTokens);
    const summaryLines = cleanSummary
        .split('\n')
        .slice(0, 2)
        .map(line => line.replace(/^-\s+/, '').trim())
        .filter(Boolean)
        .join(' • ');
    const entityMatches = extractEntities(summaryLines);
    return {
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        promptNumber: state.promptCounter,
        tags,
        summary: summaryLines,
        hasDecision: /decided|decision|approved|agreed|commit|commitment/i.test(summaryLines),
        hasAction: /action item|todo|follow[- ]?up|owner|assign|due|deliverable/i.test(summaryLines),
        hasRisk: /risk|blocker|issue|concern/i.test(summaryLines),
        hasContradiction: /contradiction|conflict|inconsistent/i.test(summaryLines),
        hasEntities: entityMatches.length > 0,
        hasDeadline: /due|deadline|by\s+\w+|date/i.test(summaryLines),
        createdAt: Date.now()
    };
}

function scoreMemoryEntry(entry, queryTags) {
    let score = 0;
    if (entry.hasDecision) score += 3;
    if (entry.hasAction) score += 3;
    if (entry.hasRisk || entry.hasContradiction) score += 2;
    if (entry.hasEntities || entry.hasDeadline) score += 2;
    if (entry.summary && estimateTokens(entry.summary) > SIGNAL_MEMORY_LIMITS.chunkMaxTokens) {
        score -= 2;
    }

    const tagMatch = entry.tags?.some(tag => queryTags.includes(tag));
    if (tagMatch) score += 2;

    const ageMinutes = (Date.now() - entry.createdAt) / (1000 * 60);
    const recencyBoost = Math.max(0, 1 - (ageMinutes / 120));
    score += recencyBoost;

    return score;
}

function retrieveMemorySlices(userPrompt, budgetTokens = SIGNAL_MEMORY_LIMITS.retrievalMaxTokens) {
    if (!state.memoryIndex.length) return [];
    const queryTags = classifyPromptTags(userPrompt);
    const requireTagMatch = queryTags.length > 0;
    const scored = state.memoryIndex.map(entry => ({
        entry,
        score: scoreMemoryEntry(entry, queryTags)
    }));

    const sorted = scored
        .filter(item => item.score > 0 && (!requireTagMatch || item.entry.tags?.some(tag => queryTags.includes(tag))))
        .sort((a, b) => b.score - a.score);

    const selected = [];
    let usedTokens = 0;

    for (const item of sorted) {
        const sanitized = sanitizeHistoryChunk(item.entry.summary, SIGNAL_MEMORY_LIMITS.chunkMaxTokens)
            .replace(/^-\s+/, '')
            .trim();
        const tokens = estimateTokens(sanitized);
        if (usedTokens + tokens > budgetTokens) continue;
        usedTokens += tokens;
        selected.push({
            promptNumber: item.entry.promptNumber,
            summary: sanitized
        });
        if (usedTokens >= budgetTokens) break;
    }

    if (selected.length === 0) return [];

    const content = selected
        .map(item => `- [P${item.promptNumber}] ${item.summary}`)
        .join('\n');

    return [{
        role: 'system',
        content: `Retrieved memory snippets:\n${content}`
    }];
}

function buildWorkingWindowMessages() {
    const userMessages = state.chatHistory
        .filter(message => message.role === 'user')
        .slice(-2)
        .map(message => ({
            role: 'user',
            content: sanitizeHistoryChunk(message.content, SIGNAL_MEMORY_LIMITS.chunkMaxTokens)
        }));

    const summary = state.summaryLastTurn
        ? sanitizeHistoryChunk(state.summaryLastTurn, SIGNAL_MEMORY_LIMITS.chunkMaxTokens)
        : '';
    const assistantMessage = summary
        ? [{ role: 'assistant', content: summary }]
        : [];

    const combined = [...userMessages, ...assistantMessage];
    if (combined.length === 0) return [];

    const trimmed = [];
    let totalTokens = 0;
    for (let i = combined.length - 1; i >= 0; i -= 1) {
        const message = combined[i];
        const messageTokens = estimateMessageTokens(message);
        if (totalTokens + messageTokens > SIGNAL_MEMORY_LIMITS.workingWindowMaxTokens) {
            break;
        }
        trimmed.push(message);
        totalTokens += messageTokens;
    }

    return trimmed.reverse();
}

function buildSignalWeightedHistory(systemPrompt, userPrompt) {
    const messages = [];

    const stateBlock = buildStateBlockMarkdown();
    if (stateBlock) {
        messages.push({
            role: 'system',
            content: `State Block (compact working memory):\n${stateBlock}`
        });
    }

    messages.push(...buildWorkingWindowMessages());

    const retrieved = retrieveMemorySlices(userPrompt, SIGNAL_MEMORY_LIMITS.retrievalMaxTokens);
    messages.push(...retrieved);

    return messages;
}

function recordSignalMemory(userPrompt, assistantResponse) {
    state.promptCounter += 1;
    const summary = summarizeAssistantResponse(assistantResponse);
    state.summaryLastTurn = summary;
    updateSignalState(summary, userPrompt);
    state.stateBlockMarkdown = buildStateBlockMarkdown();

    if (!summary) {
        return;
    }

    const tags = classifyPromptTags(userPrompt);
    const entry = buildMemoryIndexEntry(summary, userPrompt, tags);
    state.memoryIndex.push(entry);
    if (state.memoryIndex.length > 120) {
        state.memoryIndex = state.memoryIndex.slice(-120);
    }
}

function resetSignalMemory() {
    state.signalState = {
        decisions: [],
        actionItems: [],
        openQuestions: [],
        constraints: [],
        entities: [],
        sourcePointers: []
    };
    state.stateBlockMarkdown = '';
    state.summaryLastTurn = '';
    state.memoryIndex = [];
    state.promptCounter = 0;
}

function resolveContextGaugeMode(draftMessage) {
    if (!state.settings.useRLM || !draftMessage) {
        return { mode: 'direct', label: 'Direct' };
    }

    const rlmAuto = state.settings.rlmAuto;
    if (rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(draftMessage, { auto: rlmAuto })) {
        return { mode: 'repl', label: 'REPL' };
    }
    if (rlmPipeline.shouldUseRLM && rlmPipeline.shouldUseRLM(draftMessage, { auto: rlmAuto })) {
        return { mode: 'rlm', label: 'RLM' };
    }

    return { mode: 'direct', label: 'Direct' };
}

function estimateDirectContextUsage(draftMessage) {
    const relevantAgents = getRelevantAgentsForChat(draftMessage, 5);
    const transcriptLimit = Math.floor(30000 / Math.max(relevantAgents.length, 1));

    const context = buildChatContext(draftMessage, { maxAgents: 5 });
    const rawContext = buildChatContext(draftMessage, { maxAgents: 5, useFullTranscripts: true });
    const history = getHistoryForPrompt(buildDirectSystemPrompt(context), draftMessage);
    const rawHistory = getHistoryForPrompt(buildDirectSystemPrompt(rawContext), draftMessage);

    const currentTokens = estimatePromptTokens(buildDirectSystemPrompt(context), history, draftMessage);
    const rawTokens = estimatePromptTokens(buildDirectSystemPrompt(rawContext), rawHistory, draftMessage);

    return {
        currentTokens,
        rawTokens,
        details: {
            mode: 'direct',
            historyCount: history.length,
            agentCount: relevantAgents.length,
            transcriptLimit
        }
    };
}

async function estimateRlmContextUsage(draftMessage) {
    const contextStore = rlmPipeline.contextStore;
    const decomposer = rlmPipeline.decomposer;

    if (!contextStore || !decomposer) {
        return estimateDirectContextUsage(draftMessage);
    }

    let decomposition;
    try {
        decomposition = await decomposer.decompose(draftMessage, {});
    } catch (error) {
        console.warn('[ContextGauge] RLM decomposition failed:', error.message);
        return estimateDirectContextUsage(draftMessage);
    }

    const subQueries = decomposition?.subQueries || [];
    if (subQueries.length === 0) {
        return estimateDirectContextUsage(draftMessage);
    }

    const systemTokens = estimateMessageTokens({ role: 'system', content: RLM_SUBQUERY_SYSTEM_PROMPT });
    const mapQueries = subQueries.filter(sq => sq.type === 'map');
    const estimatedMapTokens = mapQueries.length * (RLM_CONFIG.tokensPerSubQuery || 800);

    let currentMax = 0;
    let rawMax = 0;

    subQueries.forEach(subQuery => {
        if (!subQuery) return;

        const queryText = subQuery.query || draftMessage;

        if (subQuery.type === 'reduce') {
            const reduceContentTokens = estimateTokensFromParts([
                'Context from meetings:\n',
                estimatedMapTokens,
                '\n\nQuestion: ',
                queryText,
                '\n\nProvide a focused answer based only on the context above.'
            ]);
            const reduceUserTokens = reduceContentTokens + CONTEXT_GAUGE_MESSAGE_OVERHEAD;
            const reduceHistory = getHistoryForPrompt(RLM_SUBQUERY_SYSTEM_PROMPT, queryText);
            const reduceHistoryTokens = estimateMessagesTokens(reduceHistory);
            const reduceTotal = systemTokens + reduceHistoryTokens + reduceUserTokens;
            currentMax = Math.max(currentMax, reduceTotal);
            rawMax = Math.max(rawMax, reduceTotal);
            return;
        }

        const targetAgents = Array.isArray(subQuery.targetAgents) ? subQuery.targetAgents : [];
        const contextLevel = subQuery.contextLevel || 'standard';

        const agentContext = contextStore.getCombinedContext(targetAgents, contextLevel);
        const userPrompt = buildRlmUserPrompt(agentContext, queryText);
        const history = getHistoryForPrompt(RLM_SUBQUERY_SYSTEM_PROMPT, userPrompt);
        const currentTokens = systemTokens + estimateMessagesTokens(history) + estimateMessageTokens({ role: 'user', content: userPrompt });
        currentMax = Math.max(currentMax, currentTokens);

        const rawContext = contextStore.getCombinedContext(targetAgents, 'full');
        const rawPrompt = buildRlmUserPrompt(rawContext, queryText);
        const rawHistory = getHistoryForPrompt(RLM_SUBQUERY_SYSTEM_PROMPT, rawPrompt);
        const rawTokens = systemTokens + estimateMessagesTokens(rawHistory) + estimateMessageTokens({ role: 'user', content: rawPrompt });
        rawMax = Math.max(rawMax, rawTokens);
    });

    return {
        currentTokens: currentMax,
        rawTokens: rawMax,
        details: {
            mode: 'rlm',
            historyCount: getHistoryForPrompt(RLM_SUBQUERY_SYSTEM_PROMPT, draftMessage).length,
            subQueryCount: subQueries.length,
            strategy: decomposition?.strategy?.type || 'unknown'
        }
    };
}

function estimateReplContextUsage(draftMessage) {
    const contextStore = rlmPipeline.contextStore;
    const stats = contextStore?.getStats ? contextStore.getStats() : { activeAgents: 0 };
    const agentNames = contextStore?.getAgentNames ? contextStore.getAgentNames() : [];

    const prompts = generateCodePrompt(draftMessage || '', {
        activeAgents: stats.activeAgents || 0,
        agentNames
    });
    const history = getHistoryForPrompt(prompts.systemPrompt, prompts.userPrompt);

    let currentTokens = estimatePromptTokens(prompts.systemPrompt, history, prompts.userPrompt);
    let rawTokens = currentTokens;
    let subLmEstimated = false;

    if (prompts.classification?.suggestSubLm && contextStore?.getActiveAgents) {
        const activeAgentIds = contextStore.getActiveAgents().map(agent => agent.id);
        const summaryContext = contextStore.getCombinedContext(activeAgentIds, 'summary');
        const fullContext = contextStore.getCombinedContext(activeAgentIds, 'full');

        const subLmSystemTokens = estimateMessageTokens({ role: 'system', content: RLM_SUBQUERY_SYSTEM_PROMPT });
        const subLmUserPrompt = buildSubLmUserPrompt(summaryContext, draftMessage);
        const subLmRawPrompt = buildSubLmUserPrompt(fullContext, draftMessage);
        const subLmHistory = getHistoryForPrompt(RLM_SUBQUERY_SYSTEM_PROMPT, subLmUserPrompt);
        const subLmRawHistory = getHistoryForPrompt(RLM_SUBQUERY_SYSTEM_PROMPT, subLmRawPrompt);
        const subLmUserTokens = estimateMessageTokens({ role: 'user', content: subLmUserPrompt });
        const subLmRawTokens = estimateMessageTokens({ role: 'user', content: subLmRawPrompt });

        currentTokens = Math.max(currentTokens, subLmSystemTokens + estimateMessagesTokens(subLmHistory) + subLmUserTokens);
        rawTokens = Math.max(rawTokens, subLmSystemTokens + estimateMessagesTokens(subLmRawHistory) + subLmRawTokens);
        subLmEstimated = true;
    }

    return {
        currentTokens,
        rawTokens,
        details: {
            mode: 'repl',
            historyCount: history.length,
            subLmEstimated
        }
    };
}

function buildContextGaugeFootnote(details, currentTokens, rawTokens) {
    if (currentTokens === 0 && rawTokens === 0) {
        return 'Add meetings and a query to estimate context usage.';
    }

    const savings = Math.max(rawTokens - currentTokens, 0);
    const savingsPercent = rawTokens > 0
        ? Math.round((savings / rawTokens) * 100)
        : 0;

    let modeNote = '';
    if (details.mode === 'direct') {
        const agentNote = details.agentCount ? `${details.agentCount} meetings` : 'meetings';
        const historyNote = details.historyCount ? `${details.historyCount} recent messages` : 'no history';
        modeNote = `Direct uses ${agentNote} and ${historyNote}.`;
    } else if (details.mode === 'rlm') {
        const strategy = details.strategy ? `${details.strategy} strategy` : 'pipeline';
        const subQueryNote = details.subQueryCount ? `${details.subQueryCount} sub-queries` : 'sub-queries';
        const historyNote = details.historyCount ? `${details.historyCount} recent messages` : 'no history';
        modeNote = `RLM ${strategy} with ${subQueryNote} and ${historyNote}.`;
    } else if (details.mode === 'repl') {
        modeNote = `REPL code-gen prompt${details.subLmEstimated ? ' plus sub_lm estimate.' : '.'}`;
    }

    const savingsNote = rawTokens > 0
        ? (savings > 0
            ? `Full transcripts estimate ${formatTokenCount(rawTokens)} tokens (saves ${formatTokenCount(savings)}, ${savingsPercent}%).`
            : `Full transcripts estimate ${formatTokenCount(rawTokens)} tokens.`)
        : '';

    return `${modeNote} ${savingsNote}`.trim();
}

async function updateContextGauge() {
    if (!elements.contextGauge) return;

    const runId = ++contextGaugeRunId;
    const modelLimit = MODEL_CONTEXT_WINDOWS[state.settings.model] || 64000;
    const draftMessage = getDraftQuery();
    const { mode, label } = resolveContextGaugeMode(draftMessage);

    let usage;
    try {
        if (mode === 'rlm') {
            usage = await estimateRlmContextUsage(draftMessage);
        } else if (mode === 'repl') {
            usage = estimateReplContextUsage(draftMessage);
        } else {
            usage = estimateDirectContextUsage(draftMessage);
        }
    } catch (error) {
        console.warn('[ContextGauge] Failed to estimate usage:', error.message);
        usage = estimateDirectContextUsage(draftMessage);
    }

    if (runId !== contextGaugeRunId) {
        return;
    }

    const currentTokens = usage.currentTokens || 0;
    const rawTokens = usage.rawTokens || 0;

    const currentPercent = modelLimit > 0 ? Math.min((currentTokens / modelLimit) * 100, 100) : 0;
    const rawPercent = modelLimit > 0 ? Math.min((rawTokens / modelLimit) * 100, 100) : 0;

    if (elements.contextGaugeRomFill) {
        elements.contextGaugeRomFill.style.width = `${currentPercent}%`;
    }
    if (elements.contextGaugeRawFill) {
        elements.contextGaugeRawFill.style.width = `${rawPercent}%`;
    }
    if (elements.contextGaugeRomValue) {
        elements.contextGaugeRomValue.textContent = `${Math.round(currentPercent)}%`;
    }
    if (elements.contextGaugeRawValue) {
        elements.contextGaugeRawValue.textContent = `${Math.round(rawPercent)}%`;
    }

    if (elements.contextGaugeUsage) {
        elements.contextGaugeUsage.textContent = `${label} ${formatTokenCount(currentTokens)} / ${formatTokenCount(modelLimit)}`;
    }

    const statusEl = elements.contextGaugeStatus;
    if (statusEl) {
        statusEl.classList.remove('warn', 'critical');
        let statusLabel = 'Healthy';
        if (currentPercent >= 90) {
            statusLabel = 'Critical';
            statusEl.classList.add('critical');
        } else if (currentPercent >= 70) {
            statusLabel = 'Tight';
            statusEl.classList.add('warn');
        }
        statusEl.textContent = statusLabel;
    }

    if (elements.contextGaugeFootnote) {
        elements.contextGaugeFootnote.textContent = buildContextGaugeFootnote(
            usage.details || { mode },
            currentTokens,
            rawTokens
        );
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Cross-Meeting Insights Generation
// ============================================

async function generateCrossInsights() {
    console.log('[generateCrossInsights] Starting...');
    const activeAgents = state.agents.filter(a => a.enabled);
    console.log('[generateCrossInsights] Active agents:', activeAgents.length);
    
    if (activeAgents.length < 2 || !state.apiKey) {
        showError('Please enable at least 2 agents and enter your API key.');
        return;
    }
    
    state.isProcessing = true;
    showButtonLoader(elements.generateInsightsBtn);
    updateButtonStates();
    
    try {
        const combinedContext = buildCombinedContext();
        console.log('[generateCrossInsights] Combined context length:', combinedContext.length);
        
        const systemPrompt = `You are an expert business analyst specializing in meeting synthesis and strategic insights. 
You have been given data from multiple meetings and must identify cross-meeting patterns, themes, and actionable recommendations.

Analyze the meetings holistically and provide insights in the following categories:
1. COMMON THEMES: Recurring topics, concerns, or focus areas across meetings
2. TRENDS & PATTERNS: Evolution of discussions, emerging priorities, or shifting focus
3. RISKS & BLOCKERS: Common challenges, dependencies, or concerns that appear across meetings
4. RECOMMENDATIONS: Strategic suggestions based on the aggregate meeting data
5. CONSOLIDATED ACTIONS: All action items organized by priority or theme

Format your response as JSON with these keys: themes, trends, risks, recommendations, actions
Each should be an array of strings (bullet points).`;

        console.log('[generateCrossInsights] Calling GPT API...');
        const response = await callGPT(systemPrompt, combinedContext, 'Cross-Meeting Insights');
        console.log('[generateCrossInsights] Got response, length:', response?.length);
        
        // Parse JSON response
        let insights;
        try {
            // Try to extract JSON from response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                insights = JSON.parse(jsonMatch[0]);
                console.log('[generateCrossInsights] Parsed JSON successfully');
            } else {
                throw new Error('No JSON found in response');
            }
        } catch (parseError) {
            console.warn('[generateCrossInsights] JSON parse failed, using fallback:', parseError.message);
            // Fallback: treat response as plain text
            insights = {
                themes: [response],
                trends: [],
                risks: [],
                recommendations: [],
                actions: []
            };
        }
        
        console.log('[generateCrossInsights] Setting state.insights and displaying...');
        state.insights = insights;
        displayInsights(insights);
        resetChatHistory();
        updateUI();
        saveState(); // Save insights to sessionStorage
        console.log('[generateCrossInsights] Complete!');
        
    } catch (error) {
        console.error('[generateCrossInsights] Error:', error);
        showError(`Failed to generate insights: ${error.message}`);
    } finally {
        state.isProcessing = false;
        hideButtonLoader(elements.generateInsightsBtn);
        updateButtonStates();
    }
}

function buildCombinedContext() {
    const activeAgents = state.agents.filter(a => a.enabled);
    return activeAgents.map((agent, index) => `
=== MEETING ${index + 1}: ${agent.displayName || agent.title} ===
Date: ${agent.date || 'Unknown'}
Source: ${agent.sourceType}

SUMMARY:
${agent.summary}

KEY POINTS:
${agent.keyPoints}

ACTION ITEMS:
${agent.actionItems}

SENTIMENT:
${agent.sentiment}
${agent.transcript ? `
TRANSCRIPT:
${agent.transcript}
` : ''}
${agent.extendedContext ? `
EXTENDED CONTEXT:
${agent.extendedContext}
` : ''}
`).join('\n\n---\n\n');
}

function getActiveAgents() {
    return state.agents.filter(a => a.enabled);
}

function displayInsights(insights) {
    if (!insights) {
        console.error('displayInsights called with null/undefined insights');
        return;
    }
    
    // Ensure insights section is visible
    if (elements.insightsSection) {
        elements.insightsSection.classList.remove('hidden');
    }
    
    // Populate each insight card with null checks
    if (elements.insightThemes) {
        elements.insightThemes.innerHTML = formatInsightList(insights.themes);
    }
    if (elements.insightTrends) {
        elements.insightTrends.innerHTML = formatInsightList(insights.trends);
    }
    if (elements.insightRisks) {
        elements.insightRisks.innerHTML = formatInsightList(insights.risks);
    }
    if (elements.insightRecommendations) {
        elements.insightRecommendations.innerHTML = formatInsightList(insights.recommendations);
    }
    if (elements.insightActions) {
        elements.insightActions.innerHTML = formatInsightList(insights.actions);
    }
    
    // Scroll to insights section
    elements.insightsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatInsightList(items) {
    if (!items || items.length === 0) {
        return '<p class="no-data">No data available</p>';
    }
    return `<ul class="insight-list">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

// ============================================
// Chat Functionality
// ============================================

async function sendChatMessage() {
    const message = elements.chatInput.value.trim();
    if (!message || state.isProcessing || state.agents.length === 0) return;

    // Set defer flag to prevent SW updates during processing
    if (window.deferSWUpdate !== undefined) {
        window.deferSWUpdate = true;
        console.log('[Chat] Deferring SW updates during processing');
    }

    // Clear input and disable while processing
    elements.chatInput.value = '';
    elements.chatInput.disabled = true;
    elements.chatSendBtn.disabled = true;

    // Add user message to UI
    appendChatMessage('user', message);

    // IMPORTANT: Clear any old thinking indicators before showing new one
    clearAllThinkingIndicators();

    // Show thinking indicator with train of thought
    const thinkingId = showThinkingIndicator();
    const streamState = createStreamingMessage();

    try {
        // Check execution mode (respects RLM toggle setting)
        const rlmEnabled = state.settings.useRLM;
        const rlmAuto = state.settings.rlmAuto;
        const useREPL = rlmEnabled && rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(message, { auto: rlmAuto });
        const useRLM = rlmEnabled && !useREPL && rlmPipeline.shouldUseRLM(message, { auto: rlmAuto });
        const activeAgentCount = state.agents.filter(a => a.enabled).length;
        const modelNames = { 'gpt-5.2': 'GPT-5.2', 'gpt-5-mini': 'GPT-5-mini', 'gpt-5-nano': 'GPT-5-nano' };
        const modelName = modelNames[state.settings.model] || 'GPT-5.2';

        // Determine processing mode for metrics
        const processingMode = useREPL ? 'repl' : (useRLM ? 'rlm' : 'direct');
        
        // Start a prompt group to aggregate all API calls for this user query
        const queryPreview = message.substring(0, 50) + (message.length > 50 ? '...' : '');
        startPromptGroup(`Chat: ${queryPreview}`, useRLM || useREPL, processingMode);

        // Update title based on mode
        if (useREPL) {
            updateThinkingTitle(thinkingId, 'RLM: Code-Assisted Analysis');
        } else if (useRLM) {
            updateThinkingTitle(thinkingId, 'RLM: Recursive Processing');
        } else {
            updateThinkingTitle(thinkingId, `Direct Query (${modelName})`);
        }

        // Initial step: Query received
        addThinkingStep(thinkingId, `Query: "${message.substring(0, 60)}${message.length > 60 ? '...' : ''}"`, 'info');
        
        // Show initial mode selection
        if (useREPL) {
            addThinkingStep(thinkingId, `Mode: REPL with ${activeAgentCount} agents`, 'classify');
            updateThinkingStatus(thinkingId, 'Starting Python code execution pipeline...');
        } else if (useRLM) {
            addThinkingStep(thinkingId, `Mode: RLM with ${activeAgentCount} agents`, 'classify');
            updateThinkingStatus(thinkingId, 'Starting recursive decomposition...');
        } else {
            addThinkingStep(thinkingId, `Mode: Direct ${modelName}${!rlmEnabled ? ' (RLM off)' : ''}`, 'classify');
            updateThinkingStatus(thinkingId, 'Analyzing with LLM...');
            addThinkingStep(thinkingId, `Building context from ${state.agents.length} meetings`, 'info');
        }

        // Execute the actual chat processing (pass thinkingId for real-time updates from RLM)
        const response = await chatWithAgents(message, thinkingId, {
            onStart: () => {
                updateStreamingStatus(streamState, 'Streaming response...');
                removeThinkingIndicator(thinkingId);
            },
            onToken: (chunk) => {
                updateStreamingMessage(streamState, chunk);
            },
            onComplete: () => {
                updateStreamingStatus(streamState, 'Finalizing response...');
            }
        });
        
        // Store prompt preview and response in the active group
        if (activePromptGroup) {
            activePromptGroup.promptPreview = queryPreview;
            activePromptGroup.response = response;  // Store the full response
        }

        // Final step
        addThinkingStep(thinkingId, 'Response ready', 'success');
        updateThinkingStatus(thinkingId, 'Formatting...');

        if (document.getElementById(thinkingId)) {
            removeThinkingIndicator(thinkingId);
        }
        finalizeStreamingMessage(streamState, response);
    } catch (error) {
        // Store error response in active group if available
        if (activePromptGroup) {
            activePromptGroup.response = `Error: ${error.message}`;
        }
        if (document.getElementById(thinkingId)) {
            removeThinkingIndicator(thinkingId);
        }
        
        // Enhanced error messages with model-specific guidance
        let errorMessage = `Sorry, I encountered an error: ${error.message}`;
        const modelNames = { 'gpt-5.2': 'GPT-5.2', 'gpt-5-mini': 'GPT-5-mini', 'gpt-5-nano': 'GPT-5-nano' };
        const modelName = modelNames[state.settings.model] || state.settings.model;
        
        // Provide helpful guidance based on error type
        if (error.message.includes('content_filter')) {
            errorMessage = `The ${modelName} response was filtered by content policy. Please try rephrasing your query.`;
        } else if (error.message.includes('truncated') || error.message.includes('max tokens')) {
            errorMessage = `The ${modelName} response was truncated. Try a shorter query or switch to a model with higher token limits.`;
        } else if (error.message.includes('empty response')) {
            errorMessage = `The ${modelName} model returned an empty response after multiple attempts. This may indicate an issue with the model or query. Try switching to ${modelName === 'GPT-5-nano' ? 'GPT-5-mini' : 'GPT-5.2'} or rephrasing your query.`;
        } else if (error.message.includes('failed to produce')) {
            errorMessage = `The ${modelName} model failed to produce a valid response after multiple attempts. Consider trying a different model or simplifying your query.`;
        }
        finalizeStreamingMessage(streamState, errorMessage, { isError: true });
    } finally {
        // End prompt group and finalize metrics
        endPromptGroup();
        
        elements.chatInput.disabled = false;
        elements.chatSendBtn.disabled = false;
        elements.chatInput.focus();

        // Clear defer flag after processing complete
        if (window.deferSWUpdate !== undefined) {
            window.deferSWUpdate = false;
            console.log('[Chat] Processing complete, SW updates allowed');

            // If there's a pending SW update, apply it now
            if (window.swUpdatePending && window.applySWUpdate) {
                console.log('[Chat] Applying pending SW update after processing');
                setTimeout(() => window.applySWUpdate(), 1000); // Small delay for UX
            }
        }

        // Save state after chat completes
        saveState();
    }
}

async function chatWithAgents(userMessage, thinkingId = null, streamHandlers = null) {
    // Check if RLM is enabled in settings
    if (!state.settings.useRLM) {
        console.log('[Chat] RLM disabled via settings, using legacy processing');
        return await chatWithAgentsLegacy(userMessage, streamHandlers);
    }
    
    // Check if REPL should be used (code-assisted queries)
    const useREPL = rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(userMessage, { auto: state.settings.rlmAuto });

    if (useREPL) {
        console.log('[Chat] Using REPL-assisted processing for query');
        const response = await chatWithREPL(userMessage, thinkingId);
        if (streamHandlers) {
            await simulateStreamingResponse(response, streamHandlers);
        }
        return response;
    }

    // Check if RLM should be used for this query
    const useRLM = rlmPipeline.shouldUseRLM(userMessage, { auto: state.settings.rlmAuto });

    if (useRLM) {
        console.log('[Chat] Using RLM pipeline for query');
        const response = await chatWithRLM(userMessage, thinkingId);
        if (streamHandlers) {
            await simulateStreamingResponse(response, streamHandlers);
        }
        return response;
    } else {
        console.log('[Chat] Using legacy processing for query');
        return await chatWithAgentsLegacy(userMessage, streamHandlers);
    }
}

/**
 * Process chat using REPL-based code execution
 */
async function chatWithREPL(userMessage, thinkingId = null) {
    // Create a wrapper for the LLM call
    const llmCallWrapper = async (systemPrompt, userContent, context) => {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ];

        const recentHistory = getHistoryForPrompt(systemPrompt, userContent);
        if (recentHistory.length > 0) {
            messages.splice(1, 0, ...recentHistory);
        }

        return callGPTWithMessages(messages, `REPL: ${userMessage.substring(0, 20)}...`, {
            maxTokens: RLM_CONFIG.maxOutputTokens
        });
    };

    // Set up progress callback (captures focus telemetry even without thinking ID)
    // Phase 3.2: Now passes details for depth-based indentation
    // Phase 3.4: Also update status bar to sync with step log
    rlmPipeline.setProgressCallback((step, type, details) => {
        if (thinkingId) {
            addThinkingStep(thinkingId, step, type, details);
            // Update status bar for in-progress steps (not completion types)
            if (type !== 'success' && type !== 'warning' && type !== 'cache') {
                updateThinkingStatus(thinkingId, step);
            }
        }
        recordFocusTelemetry(details);
    });

    // Process through REPL pipeline
    const result = await rlmPipeline.processWithREPL(userMessage, llmCallWrapper, {
        apiKey: state.apiKey
    });

    // Clear progress callback
    rlmPipeline.setProgressCallback(null);

    if (activePromptGroup && result?.metadata) {
        if (result.metadata.cached) {
            activePromptGroup.cached = true;
        }
        if (result.metadata.replUsed) {
            activePromptGroup.mode = 'repl';
            activePromptGroup.usesRLM = true;
        } else if (result.metadata.rlmEnabled === false || result.metadata.legacy) {
            activePromptGroup.mode = 'direct';
            activePromptGroup.usesRLM = false;
        } else if (result.metadata.rlmEnabled) {
            activePromptGroup.mode = 'rlm';
            activePromptGroup.usesRLM = true;
        }
    }
    attachShadowPromptTelemetry(userMessage);
    attachRetrievalPromptTelemetry(userMessage);

    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: result.response });
    recordSignalMemory(userMessage, result.response);
    updateContextGauge();

    // Log REPL metadata for debugging
    if (result.metadata) {
        console.log('[REPL] Query processed:', {
            replUsed: result.metadata.replUsed,
            time: result.metadata.pipelineTime + 'ms'
        });
    }

    return result.response;
}

/**
 * Process chat using RLM pipeline (decompose → parallel → aggregate)
 */
async function chatWithRLM(userMessage, thinkingId = null) {
    // Create a wrapper for the LLM call that the RLM pipeline can use
    const llmCallWrapper = async (systemPrompt, userContent, context) => {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ];

        // Add recent chat history for context continuity
        const recentHistory = getHistoryForPrompt(systemPrompt, userContent);
        if (recentHistory.length > 0) {
            messages.splice(1, 0, ...recentHistory);
        }

        return callGPTWithMessages(messages, `RLM: ${userMessage.substring(0, 20)}...`, {
            maxTokens: RLM_CONFIG.maxOutputTokens
        });
    };

    // Set up progress callback (captures focus telemetry even without thinking ID)
    // Phase 3.2: Now passes details for depth-based indentation
    // Phase 3.4: Also update status bar to sync with step log
    rlmPipeline.setProgressCallback((step, type, details) => {
        if (thinkingId) {
            addThinkingStep(thinkingId, step, type, details);
            // Update status bar for in-progress steps (not completion types)
            if (type !== 'success' && type !== 'warning' && type !== 'cache') {
                updateThinkingStatus(thinkingId, step);
            }
        }
        recordFocusTelemetry(details);
    });

    // Process through RLM pipeline
    const result = await rlmPipeline.process(userMessage, llmCallWrapper, {
        apiKey: state.apiKey
    });

    // Clear progress callback
    rlmPipeline.setProgressCallback(null);

    if (activePromptGroup && result?.metadata) {
        if (result.metadata.cached) {
            activePromptGroup.cached = true;
        }
        if (result.metadata.rlmEnabled === false || result.metadata.legacy) {
            activePromptGroup.mode = 'direct';
            activePromptGroup.usesRLM = false;
        } else if (result.metadata.rlmEnabled) {
            activePromptGroup.mode = 'rlm';
            activePromptGroup.usesRLM = true;
        }
    }
    attachShadowPromptTelemetry(userMessage);
    attachRetrievalPromptTelemetry(userMessage);

    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: result.response });
    recordSignalMemory(userMessage, result.response);

    // Log RLM metadata for debugging
    if (result.metadata) {
        console.log('[RLM] Query processed:', {
            strategy: result.metadata.strategy,
            subQueries: result.metadata.totalSubQueries,
            time: result.metadata.pipelineTime + 'ms'
        });
    }

    return result.response;
}

/**
 * Legacy chat processing (non-RLM fallback)
 */
async function chatWithAgentsLegacy(userMessage, streamHandlers = null) {
    // Build context with smart agent selection
    const context = buildChatContext(userMessage);
    const systemPrompt = buildDirectSystemPrompt(context);

    // Build messages array with history
    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // Add chat history for continuity
    const recentHistory = getHistoryForPrompt(systemPrompt, userMessage);
    messages.push(...recentHistory);

    // Add current message
    messages.push({ role: 'user', content: userMessage });

    const response = streamHandlers
        ? await callGPTWithMessagesStream(messages, `Chat: ${userMessage.substring(0, 30)}...`, streamHandlers)
        : await callGPTWithMessages(messages, `Chat: ${userMessage.substring(0, 30)}...`);

    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: response });
    recordSignalMemory(userMessage, response);
    updateContextGauge();

    return response;
}

function extractKeywords(text) {
    // Simple keyword extraction - remove common words and extract significant ones
    const commonWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'to', 'for', 'of', 'as', 'by', 'from', 'what', 'where', 'when', 'why', 'how', 'who', 'about', 'can', 'could', 'should', 'would', 'will', 'are', 'was', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'me', 'my', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those']);

    const words = text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !commonWords.has(word));

    return [...new Set(words)];
}

function selectRelevantAgents(userQuery, allAgents, maxAgents = 5) {
    if (allAgents.length <= maxAgents) {
        return allAgents; // Return all if we have fewer than max
    }

    const queryKeywords = extractKeywords(userQuery);

    const scored = allAgents.map(agent => {
        let score = 0;

        // Keyword matching
        queryKeywords.forEach(keyword => {
            if (agent.title.toLowerCase().includes(keyword)) score += 5;
            if (agent.summary.toLowerCase().includes(keyword)) score += 3;
            if (agent.keyPoints.toLowerCase().includes(keyword)) score += 2;
            if (agent.actionItems.toLowerCase().includes(keyword)) score += 2;
        });

        // Recency boost (recent meetings are more likely to be relevant)
        if (agent.date) {
            try {
                const agentDate = new Date(agent.date);
                if (!isNaN(agentDate.getTime())) {
                    const age = Date.now() - agentDate.getTime();
                    const daysSince = age / (1000 * 60 * 60 * 24);
                    score += Math.max(0, 10 - (daysSince / 7)); // Decay over weeks
                }
            } catch (e) {
                // Invalid date, skip recency boost
            }
        }

        return { agent, score };
    });

    // Sort by score and return top N agents
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, maxAgents)
        .map(s => s.agent);
}

const DIRECT_SYSTEM_PROMPT_PREFIX = `You are a helpful meeting assistant with access to data from multiple meetings.
Use the following meeting data to answer questions accurately and comprehensively.
If information isn't available in the meeting data, say so clearly.
Be concise but thorough. Use bullet points when listing multiple items.`;

function buildDirectSystemPrompt(context) {
    return `${DIRECT_SYSTEM_PROMPT_PREFIX}\n\n${context}`;
}

function getRelevantAgentsForChat(userQuery, maxAgents = 5) {
    const activeAgents = state.agents.filter(a => a.enabled);
    return userQuery
        ? selectRelevantAgents(userQuery, activeAgents, maxAgents)
        : activeAgents.slice(0, maxAgents);
}

function buildChatContext(userQuery = '', options = {}) {
    const {
        maxAgents = 5,
        useFullTranscripts = false,
        transcriptLimitOverride = null
    } = options;

    const relevantAgents = getRelevantAgentsForChat(userQuery, maxAgents);

    // Dynamic transcript limit based on number of agents (more agents = less transcript per agent)
    // Total context budget ~50k chars, reserve ~30k for transcripts across all agents
    const transcriptLimit = useFullTranscripts
        ? null
        : (Number.isFinite(transcriptLimitOverride)
            ? transcriptLimitOverride
            : Math.floor(30000 / Math.max(relevantAgents.length, 1)));

    return relevantAgents.map((agent, index) => {
        const transcriptText = agent.transcript || '';
        const transcriptSection = transcriptText
            ? (transcriptLimit && transcriptText.length > transcriptLimit
                ? `Transcript: ${transcriptText.substring(0, transcriptLimit)}...[truncated]`
                : `Transcript: ${transcriptText}`)
            : '';
        const extendedSection = agent.extendedContext
            ? `Extended Context:\n${agent.extendedContext}`
            : '';

        return `
--- Meeting ${index + 1}: ${agent.displayName || agent.title} (${agent.date || 'No date'}) ---
Summary: ${agent.summary}
Key Points: ${agent.keyPoints}
Action Items: ${agent.actionItems}
Sentiment: ${agent.sentiment}
${transcriptSection}
${extendedSection}
`;
    }).join('\n\n');
}

function appendChatMessage(role, content, shouldSave = true) {
    // Remove welcome card on first message
    const welcomeCard = elements.chatMessages.querySelector('.chat-welcome-card');
    if (welcomeCard) {
        welcomeCard.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;

    const avatar = role === 'assistant' ? '🤖' : '👤';
    let messageContent = content;

    if (role === 'assistant' && typeof marked !== 'undefined') {
        messageContent = marked.parse(content);
    } else {
        messageContent = escapeHtml(content);
    }

    messageDiv.innerHTML = `
        <div class="chat-message-avatar">${avatar}</div>
        <div class="chat-message-content">${messageContent}</div>
    `;

    elements.chatMessages.appendChild(messageDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    // Save state after adding message (unless restoring from storage)
    if (shouldSave) {
        saveState();
    }

    updateContextGauge();
}

function createStreamingMessage() {
    const welcomeCard = elements.chatMessages.querySelector('.chat-welcome-card');
    if (welcomeCard) {
        welcomeCard.remove();
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message assistant streaming';
    messageDiv.innerHTML = `
        <div class="chat-message-avatar">🤖</div>
        <div class="chat-message-content">
            <div class="streaming-header">
                <span class="streaming-dot"></span>
                <span class="streaming-label">Awaiting response...</span>
            </div>
            <div class="streaming-body">
                <span class="streaming-text"></span>
                <span class="streaming-cursor">▍</span>
            </div>
        </div>
    `;

    elements.chatMessages.appendChild(messageDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    return {
        container: messageDiv,
        content: messageDiv.querySelector('.chat-message-content'),
        label: messageDiv.querySelector('.streaming-label'),
        text: messageDiv.querySelector('.streaming-text'),
        cursor: messageDiv.querySelector('.streaming-cursor')
    };
}

function updateStreamingStatus(streamState, statusText) {
    if (streamState?.label) {
        streamState.label.textContent = statusText;
    }
}

function updateStreamingMessage(streamState, chunk) {
    if (!streamState?.text || !chunk) return;
    streamState.text.textContent += chunk;
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function finalizeStreamingMessage(streamState, fullText, options = {}) {
    if (!streamState?.content) return;
    const { isError = false } = options;
    if (typeof marked !== 'undefined' && !isError) {
        streamState.content.innerHTML = marked.parse(fullText || '');
    } else {
        streamState.content.innerHTML = escapeHtml(fullText || '');
    }
    streamState.container?.classList.toggle('streaming-error', isError);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    saveState();
    updateContextGauge();
}

async function simulateStreamingResponse(fullText, streamHandlers) {
    if (!streamHandlers) return;
    const chunkSize = Math.max(6, Math.ceil(fullText.length / 120));
    streamHandlers.onStart?.();
    for (let i = 0; i < fullText.length; i += chunkSize) {
        const chunk = fullText.slice(i, i + chunkSize);
        streamHandlers.onToken?.(chunk);
        await sleep(18);
    }
    streamHandlers.onComplete?.(fullText);
}

/**
 * Clear all existing thinking indicators from chat
 */
function clearAllThinkingIndicators() {
    const thinkingIndicators = elements.chatMessages.querySelectorAll('.chat-thinking');
    thinkingIndicators.forEach(indicator => {
        indicator.remove();
    });
    console.log('[Chat] Cleared old thinking indicators');
}

/**
 * Enhanced Train of Thought System
 * Shows detailed RLM process steps in real-time
 */
function showThinkingIndicator() {
    const id = 'thinking-' + Date.now();
    const thinkingDiv = document.createElement('div');
    thinkingDiv.id = id;
    thinkingDiv.className = 'chat-thinking enhanced';
    thinkingDiv.innerHTML = `
        <div class="chat-message-avatar">🤖</div>
        <div class="chat-thinking-bubble">
            <div class="thinking-header">
                <div class="thinking-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
                <span class="thinking-title">Processing with RLM</span>
            </div>
            <div class="thinking-log"></div>
            <div class="thinking-current">
                <span class="thinking-spinner"></span>
                <span class="thinking-text">Initializing...</span>
            </div>
        </div>
    `;
    elements.chatMessages.appendChild(thinkingDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    return id;
}

/**
 * Add a step to the thinking log (persists in the log)
 * Phase 3.2: Enhanced to support depth-based indentation for sub_lm calls
 * 
 * @param {string} id - Thinking indicator ID
 * @param {string} step - Step text to display
 * @param {string} type - Step type ('info', 'classify', 'code', 'execute', 'recurse', 'success', 'warning')
 * @param {Object} details - Optional details object with depth, subLmId, etc.
 */
function addThinkingStep(id, step, type = 'info', details = {}) {
    const thinkingDiv = document.getElementById(id);
    if (thinkingDiv) {
        const logDiv = thinkingDiv.querySelector('.thinking-log');
        if (logDiv) {
            const stepEl = document.createElement('div');
            
            // Determine depth for indentation (sub_lm calls show depth)
            const depth = details.depth || 0;
            const depthClass = depth > 0 ? `depth-${Math.min(depth, 3)}` : '';
            
            stepEl.className = `thinking-step ${type} ${depthClass}`.trim();
            
            // Icon based on type
            const icons = {
                'classify': '🏷️',
                'decompose': '🔀',
                'code': '🐍',
                'execute': '⚡',
                'recurse': '🔄',
                'aggregate': '📊',
                'success': '✓',
                'info': '→',
                'warning': '⚠️',
                'cache': '💾'
            };
            
            // Add depth badge for recursive calls
            let depthBadge = '';
            if (type === 'recurse' && depth > 0) {
                depthBadge = `<span class="depth-badge">L${depth}</span>`;
            }
            
            // Add timing badge if duration is provided
            let timingBadge = '';
            if (details.duration) {
                timingBadge = `<span class="timing-badge">${details.duration}ms</span>`;
            }
            
            stepEl.innerHTML = `<span class="step-icon">${icons[type] || icons.info}</span>${depthBadge}<span class="step-text">${step}</span>${timingBadge}`;
            logDiv.appendChild(stepEl);
            
            // Auto-scroll
            elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
        }
    }
}

/**
 * Update the current thinking status (the active step)
 */
function updateThinkingStatus(id, status) {
    const thinkingDiv = document.getElementById(id);
    if (thinkingDiv) {
        const textSpan = thinkingDiv.querySelector('.thinking-text');
        if (textSpan) {
            textSpan.textContent = status;
        }
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }
}

/**
 * Update the thinking title
 */
function updateThinkingTitle(id, title) {
    const thinkingDiv = document.getElementById(id);
    if (thinkingDiv) {
        const titleSpan = thinkingDiv.querySelector('.thinking-title');
        if (titleSpan) {
            titleSpan.textContent = title;
        }
    }
}

function removeThinkingIndicator(id) {
    const thinkingDiv = document.getElementById(id);
    if (thinkingDiv) thinkingDiv.remove();
}

function resetChatHistory() {
    state.chatHistory = [];
    resetSignalMemory();
    elements.chatMessages.innerHTML = `
        <div class="chat-welcome">
            <div class="chat-welcome-icon">🤖</div>
            <div class="chat-welcome-text">
                <strong>Multi-Agent Assistant</strong>
                <p>I have access to all your uploaded meeting agents. Ask me about decisions, action items, patterns across meetings, or anything else from your meeting data.</p>
            </div>
        </div>
    `;
}

// ============================================
// Error Handling & Retry Logic
// ============================================

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAPIWithRetry(fn, maxRetries = 3, operation = 'API call') {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Don't retry on client errors (4xx except 429)
            if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw error;
            }

            // For rate limits (429) or server errors (5xx), retry with exponential backoff
            if (attempt < maxRetries - 1) {
                const delay = Math.min(2000 * Math.pow(2, attempt), 16000); // Max 16 seconds
                console.warn(`${operation} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error.message);
                await sleep(delay);
            }
        }
    }

    // All retries exhausted
    throw new Error(`${operation} failed after ${maxRetries} attempts: ${lastError.message}`);
}

// ============================================
// API Calls
// ============================================

/**
 * Build the API request body with model settings
 *
 * Per OpenAI API guidance (2026):
 * - reasoning_effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' (top-level param for Chat Completions)
 *   - Default is 'none' (favors speed)
 *   - 'xhigh' is new in GPT-5.2 for deeper reasoning
 * - IMPORTANT: temperature is NOT supported when reasoning_effort is enabled
 * - GPT-5-mini and GPT-5-nano do not support reasoning_effort or custom temperature
 */
function buildAPIRequestBody(messages, maxTokens = null) {
    const model = state.settings.model;
    // Use model-specific limit if maxTokens not provided, otherwise use provided value
    const tokenLimit = maxTokens !== null ? maxTokens : (MODEL_TOKEN_LIMITS[model] || 4000);
    
    const body = {
        model: model,
        messages: messages,
        max_completion_tokens: tokenLimit
    };

    // Only GPT-5.2 supports logprobs for confidence tracking
    // IMPORTANT: logprobs only work when effort is 'none' (not supported with reasoning_effort)
    // Other models (gpt-5-mini, gpt-5-nano) may not support this parameter
    if (model === 'gpt-5.2') {
        const effort = state.settings.effort || 'none';

        if (effort !== 'none') {
            // When using reasoning, temperature is NOT supported
            // Use top-level reasoning_effort parameter for Chat Completions API
            // NOTE: logprobs are NOT supported when using reasoning_effort
            body.reasoning_effort = effort;
        } else {
            // Only set temperature when NOT using reasoning effort
            body.temperature = 0.7;
            // Only request logprobs when effort is 'none' (they don't work with reasoning_effort)
            body.logprobs = true;
            body.top_logprobs = 1;  // Get top 1 logprob for each token
        }
    } else {
        // For gpt-5-mini and gpt-5-nano, don't set temperature
        // These models may not support temperature parameter or may have different defaults
        // Omitting temperature lets the model use its default behavior
    }

    return body;
}

function buildCallDataFromResponse({
    data,
    callName,
    requestedModel,
    actualModel,
    modelFallback,
    effort,
    responseTime,
    promptPreview,
    responseContent,
    finishReason,
    retryAttempt
}) {
    if (!data?.usage) {
        return null;
    }

    const inputTokens = data.usage.prompt_tokens || 0;
    const outputTokens = data.usage.completion_tokens || 0;

    const pricing = PRICING[actualModel] || PRICING[requestedModel] || PRICING['gpt-5.2'];
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const callCost = inputCost + outputCost;

    const normalizedResponse = responseContent && String(responseContent).trim().length > 0
        ? responseContent
        : '';

    return {
        timestamp: new Date().toISOString(),
        name: callName,
        model: actualModel,
        requestedModel,
        actualModel,
        modelFallback,
        effort: actualModel === 'gpt-5.2' ? effort : 'N/A',
        tokens: {
            input: inputTokens,
            output: outputTokens,
            total: inputTokens + outputTokens
        },
        cost: {
            input: inputCost,
            output: outputCost,
            total: callCost
        },
        responseTime,
        confidence: extractConfidenceMetrics(data, finishReason),
        promptPreview,
        response: normalizedResponse,
        emptyResponse: normalizedResponse.length === 0,
        finishReason,
        retryAttempt: retryAttempt || 0
    };
}

async function callGPT(systemPrompt, userContent, callName = 'API Call') {
    const model = state.settings.model;
    const effort = state.settings.effort;
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
    ];
    
    let lastError = null;
    let retryAttempt = 0;
    const maxRetries = 3; // Total attempts including initial call
    
    while (retryAttempt < maxRetries) {
        try {
            // Track request start time
            const startTime = performance.now();
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.apiKey}`
                },
                body: JSON.stringify(buildAPIRequestBody(messages))
            });

            // Calculate response time
            const responseTime = Math.round(performance.now() - startTime);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const err = new Error(error.error?.message || `API error: ${response.status}`);
                err.status = response.status;
                throw err;
            }

            const data = await response.json();
            const actualModel = data.model || model;
            const modelFallback = actualModel !== model;

            if (modelFallback) {
                recordModelFallback(model, actualModel, callName);
            }
            
            // Validate and extract response using helper
            const validationResult = validateAndExtractResponse(data, actualModel);
            const promptPreview = userContent.substring(0, 100) + (userContent.length > 100 ? '...' : '');

            const callData = buildCallDataFromResponse({
                data,
                callName,
                requestedModel: model,
                actualModel,
                modelFallback,
                effort,
                responseTime,
                promptPreview,
                responseContent: validationResult.content,
                finishReason: validationResult.finishReason,
                retryAttempt
            });

            if (callData) {
                addAPICallToMetrics(callData);
            }
            
            // Check if we have valid content first
            if (validationResult.content && typeof validationResult.content === 'string' && validationResult.content.trim().length > 0) {
                return validationResult.content;
            }
            
            // Handle empty response
            if (!validationResult.shouldRetry) {
                // Don't retry for content_filter, length, stop_sequence
                const errorMsg = validationResult.error || `${model} returned empty response`;
                console.warn(`[API] ${errorMsg} (finish_reason: ${validationResult.finishReason})`);
                throw new Error(errorMsg);
            }
            
            // Should retry - log and continue
            lastError = new Error(validationResult.error || `${model} returned empty response`);
            console.warn(`[API] ${lastError.message} (attempt ${retryAttempt + 1}/${maxRetries}), retrying...`);
            
            // Exponential backoff for retries
            if (retryAttempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, retryAttempt), 5000); // Max 5 seconds
                await sleep(delay);
            }
            
        } catch (error) {
            // Don't retry on client errors (4xx except 429)
            if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw error;
            }
            
            lastError = error;
            
            // For rate limits (429) or server errors (5xx), retry with exponential backoff
            if (retryAttempt < maxRetries - 1) {
                const delay = Math.min(2000 * Math.pow(2, retryAttempt), 16000); // Max 16 seconds
                console.warn(`[API] ${callName} failed (attempt ${retryAttempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error.message);
                await sleep(delay);
            }
        }
        
        retryAttempt++;
    }
    
    // All retries exhausted
    const finalError = lastError || new Error(`${model} failed to produce a valid response after ${maxRetries} attempts`);
    throw finalError;
}

async function callGPTWithMessages(messages, callName = 'Chat Query', options = {}) {
    const model = state.settings.model;
    const effort = state.settings.effort;
    const { maxTokens = null } = options;
    
    let lastError = null;
    let retryAttempt = 0;
    const maxRetries = 3; // Total attempts including initial call
    
    while (retryAttempt < maxRetries) {
        try {
            // Track request start time
            const startTime = performance.now();
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.apiKey}`
                },
                body: JSON.stringify(buildAPIRequestBody(messages, maxTokens))
            });

            // Calculate response time
            const responseTime = Math.round(performance.now() - startTime);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const err = new Error(error.error?.message || `API error: ${response.status}`);
                err.status = response.status;
                throw err;
            }

            const data = await response.json();
            const actualModel = data.model || model;
            const modelFallback = actualModel !== model;

            if (modelFallback) {
                recordModelFallback(model, actualModel, callName);
            }
            
            // Validate and extract response using helper
            const validationResult = validateAndExtractResponse(data, actualModel);

            // Extract user message for preview (last user message)
            const userMessage = messages.filter(m => m.role === 'user').pop();
            const promptPreview = userMessage ? 
                userMessage.content.substring(0, 100) + (userMessage.content.length > 100 ? '...' : '') :
                '(No user message)';

            const callData = buildCallDataFromResponse({
                data,
                callName,
                requestedModel: model,
                actualModel,
                modelFallback,
                effort,
                responseTime,
                promptPreview,
                responseContent: validationResult.content,
                finishReason: validationResult.finishReason,
                retryAttempt
            });

            if (callData) {
                addAPICallToMetrics(callData);
            }
            
            // Check if we have valid content first
            if (validationResult.content && typeof validationResult.content === 'string' && validationResult.content.trim().length > 0) {
                return validationResult.content;
            }
            
            // Handle empty response
            if (!validationResult.shouldRetry) {
                // Don't retry for content_filter, length, stop_sequence
                const errorMsg = validationResult.error || `${model} returned empty response`;
                console.warn(`[API] ${errorMsg} (finish_reason: ${validationResult.finishReason})`);
                throw new Error(errorMsg);
            }
            
            // Should retry - log and continue
            lastError = new Error(validationResult.error || `${model} returned empty response`);
            console.warn(`[API] ${lastError.message} (attempt ${retryAttempt + 1}/${maxRetries}), retrying...`);
            
            // Exponential backoff for retries
            if (retryAttempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, retryAttempt), 5000); // Max 5 seconds
                await sleep(delay);
            }
            
        } catch (error) {
            // Don't retry on client errors (4xx except 429)
            if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw error;
            }
            
            lastError = error;
            
            // For rate limits (429) or server errors (5xx), retry with exponential backoff
            if (retryAttempt < maxRetries - 1) {
                const delay = Math.min(2000 * Math.pow(2, retryAttempt), 16000); // Max 16 seconds
                console.warn(`[API] ${callName} failed (attempt ${retryAttempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error.message);
                await sleep(delay);
            }
        }
        
        retryAttempt++;
    }
    
    // All retries exhausted
    const finalError = lastError || new Error(`${model} failed to produce a valid response after ${maxRetries} attempts`);
    throw finalError;
}

async function callGPTWithMessagesStream(messages, callName = 'Chat Query', streamHandlers = {}, options = {}) {
    const model = state.settings.model;
    const effort = state.settings.effort;
    const { onStart, onToken, onComplete } = streamHandlers || {};
    const { maxTokens = null } = options;
    let lastError = null;
    let retryAttempt = 0;
    const maxRetries = 3;

    while (retryAttempt < maxRetries) {
        try {
            const startTime = performance.now();
            const requestBody = buildAPIRequestBody(messages, maxTokens);
            requestBody.stream = true;
            requestBody.stream_options = { include_usage: true };

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const err = new Error(error.error?.message || `API error: ${response.status}`);
                err.status = response.status;
                throw err;
            }

            onStart?.();

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let fullText = '';
            let streamUsage = null;
            let finishReason = null;
            let actualModel = model;
            const streamLogprobs = [];

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const payload = trimmed.replace(/^data:\s*/, '');
                    if (payload === '[DONE]') {
                        break;
                    }

                    const data = JSON.parse(payload);
                    if (data?.model) {
                        actualModel = data.model;
                    }
                    if (data?.usage) {
                        streamUsage = data.usage;
                    }

                    const choice = data?.choices?.[0];
                    if (choice?.delta?.content) {
                        const chunk = choice.delta.content;
                        fullText += chunk;
                        onToken?.(chunk, fullText);
                    }
                    if (choice?.logprobs?.content && Array.isArray(choice.logprobs.content)) {
                        streamLogprobs.push(...choice.logprobs.content);
                    }
                    if (choice?.finish_reason) {
                        finishReason = choice.finish_reason;
                    }
                }
            }

            const responseTime = Math.round(performance.now() - startTime);
            onComplete?.(fullText);

            const userMessage = messages.filter(m => m.role === 'user').pop();
            const promptPreview = userMessage
                ? userMessage.content.substring(0, 100) + (userMessage.content.length > 100 ? '...' : '')
                : '(No user message)';

            const callData = buildCallDataFromResponse({
                data: (streamUsage || streamLogprobs.length > 0)
                    ? { usage: streamUsage, choices: [{ logprobs: { content: streamLogprobs } }] }
                    : null,
                callName,
                requestedModel: model,
                actualModel,
                modelFallback: actualModel !== model,
                effort,
                responseTime,
                promptPreview,
                responseContent: fullText,
                finishReason,
                retryAttempt
            });

            if (callData) {
                addAPICallToMetrics(callData);
            }

            if (fullText && fullText.trim().length > 0) {
                return fullText;
            }

            lastError = new Error(`${model} returned empty response`);
            if (retryAttempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, retryAttempt), 5000);
                await sleep(delay);
            }
        } catch (error) {
            if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw error;
            }

            lastError = error;
            if (retryAttempt < maxRetries - 1) {
                const delay = Math.min(2000 * Math.pow(2, retryAttempt), 16000);
                console.warn(`[API] ${callName} failed (attempt ${retryAttempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error.message);
                await sleep(delay);
            }
        }

        retryAttempt++;
    }

    const finalError = lastError || new Error(`${model} failed to produce a valid response after ${maxRetries} attempts`);
    throw finalError;
}

/**
 * Extract confidence/fidelity metrics from API response
 * OpenAI API may include logprobs or other confidence indicators
 * @param {Object} data - API response data
 * @param {string} finishReason - Optional finish reason from validation (takes precedence)
 * @returns {Object} Confidence metrics
 */
function extractConfidenceMetrics(data, finishReason = null) {
    try {
        const choice = data?.choices?.[0];
        if (!choice) return { available: false };
        
        // Use provided finishReason from validation if available, otherwise extract from choice
        const finalFinishReason = finishReason || choice.finish_reason || 'unknown';
        
        const metrics = {
            available: false,
            // Note: finishReason is stored at log level, not in confidence object
            // Model's own assessment (if using reasoning effort)
            reasoningTokens: null,
            // Logprobs if available (requires logprobs=true in request, GPT-5.2 only)
            avgLogprob: null,
            // Token confidence scores if available
            tokenConfidences: null,
            truncated: false
        };
        
        // Check for logprobs (if requested in API call - GPT-5.2 only)
        if (choice.logprobs?.content && Array.isArray(choice.logprobs.content)) {
            const logprobs = choice.logprobs.content;
            if (logprobs.length > 0) {
                // Calculate average log probability (higher = more confident)
                const validLogprobs = logprobs.filter(t => t && typeof t.logprob === 'number');
                if (validLogprobs.length > 0) {
                    const avgLogprob = validLogprobs.reduce((sum, t) => sum + t.logprob, 0) / validLogprobs.length;
                    // Convert to probability (0-1 scale), clamp to valid range
                    metrics.avgLogprob = Math.min(1, Math.max(0, Math.exp(avgLogprob)));
                    metrics.available = true;
                }
            }
        }
        
        // Check for reasoning tokens (GPT-5.2 with reasoning effort)
        if (data.usage?.completion_tokens_details?.reasoning_tokens) {
            metrics.reasoningTokens = data.usage.completion_tokens_details.reasoning_tokens;
            metrics.available = true;
        }
        
        // Finish reason can indicate confidence issues
        if (finalFinishReason === 'length') {
            // Response was truncated - lower confidence in completeness
            metrics.truncated = true;
        }
        
        return metrics;
    } catch (error) {
        console.warn('[Metrics] Error extracting confidence metrics:', error);
        return { available: false };
    }
}

/**
 * Validate API response structure and extract content safely
 * Handles empty responses and provides meaningful error information
 * @param {Object} data - API response data
 * @param {string} model - Model name for error messages
 * @returns {Object} { content, finishReason, error, shouldRetry }
 */
function validateAndExtractResponse(data, model) {
    try {
        // Validate response structure
        if (!data) {
            return {
                content: null,
                finishReason: 'unknown',
                error: 'No response data received',
                shouldRetry: true
            };
        }

        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
            return {
                content: null,
                finishReason: 'unknown',
                error: 'No choices in API response',
                shouldRetry: true
            };
        }

        const choice = data.choices[0];
        if (!choice) {
            return {
                content: null,
                finishReason: 'unknown',
                error: 'Empty choice in API response',
                shouldRetry: true
            };
        }

        if (!choice.message) {
            return {
                content: null,
                finishReason: choice.finish_reason || 'unknown',
                error: 'No message object in choice',
                shouldRetry: true
            };
        }

        const finishReason = choice.finish_reason || 'stop';
        let content = choice.message.content;

        if (Array.isArray(content)) {
            content = content
                .map((item) => {
                    if (typeof item === 'string') {
                        return item;
                    }
                    if (item && typeof item === 'object') {
                        return item.text || item.content || '';
                    }
                    return '';
                })
                .join('');
        } else if (content && typeof content === 'object') {
            content = content.text || content.content || content.value || content;
        }
        if (content !== null && content !== undefined && typeof content !== 'string') {
            content = String(content);
        }

        // Check for null/undefined content
        if (content === null || content === undefined) {
            let errorMsg = `${model} returned null/undefined content`;
            let shouldRetry = true;

            if (finishReason === 'content_filter') {
                errorMsg = `${model} response was filtered by content policy`;
                shouldRetry = false; // Don't retry content filter issues
            } else if (finishReason === 'length') {
                errorMsg = `${model} response was truncated (max tokens reached)`;
                shouldRetry = false; // Don't retry length issues - need to increase limit
            } else if (finishReason === 'stop_sequence') {
                errorMsg = `${model} response stopped at stop sequence`;
                shouldRetry = false;
            }

            return {
                content: null,
                finishReason: finishReason,
                error: errorMsg,
                shouldRetry: shouldRetry
            };
        }

        // Check for empty string content
        if (typeof content === 'string' && content.trim().length === 0) {
            // Log detailed response for debugging GPT-5-nano issues
            console.warn(`[API] ${model} returned empty string. Response details:`, {
                finish_reason: finishReason,
                usage: data.usage,
                has_choices: !!data.choices,
                choice_count: data.choices?.length
            });
            
            // For GPT-5-nano, don't retry empty responses - they're likely a model limitation
            // Retrying doesn't help if the model consistently returns empty strings
            const shouldRetry = model !== 'gpt-5-nano';
            
            return {
                content: '',
                finishReason: finishReason,
                error: `${model} returned empty string content (finish_reason: ${finishReason})${model === 'gpt-5-nano' ? '. GPT-5-nano may not support this query type - try GPT-5-mini or GPT-5.2.' : ''}`,
                shouldRetry: shouldRetry
            };
        }

        // Valid content
        return {
            content: content,
            finishReason: finishReason,
            error: null,
            shouldRetry: false
        };

    } catch (error) {
        console.error('[API] Error validating response:', error);
        return {
            content: null,
            finishReason: 'error',
            error: `Error validating response: ${error.message}`,
            shouldRetry: true
        };
    }
}

// ============================================
// Metrics Display & Management
// ============================================

function calculateMetrics() {
    // Calculate totals from prompt logs
    let inputCost = 0;
    let outputCost = 0;
    let totalResponseTime = 0;
    let apiCallCount = 0;
    let cacheHits = 0;

    const modeTotals = {
        direct: { tokens: 0, cost: 0, prompts: 0, calls: 0 },
        rlm: { tokens: 0, cost: 0, prompts: 0, calls: 0 },
        repl: { tokens: 0, cost: 0, prompts: 0, calls: 0 },
        unknown: { tokens: 0, cost: 0, prompts: 0, calls: 0 }
    };
    
    currentMetrics.promptLogs.forEach(log => {
        inputCost += log.cost.input;
        outputCost += log.cost.output;
        totalResponseTime += log.responseTime;

        const mode = log.mode || 'unknown';
        const modeBucket = modeTotals[mode] || modeTotals.unknown;
        const subCallCount = log.subCalls ? log.subCalls.length : 0;
        const logTokens = log.tokens?.total || 0;
        const logCost = log.cost?.total || 0;

        modeBucket.tokens += logTokens;
        modeBucket.cost += logCost;
        modeBucket.prompts += 1;
        modeBucket.calls += subCallCount;

        apiCallCount += subCallCount;

        if (log.cached) {
            cacheHits += 1;
        }
    });
    
    const totalCost = inputCost + outputCost;
    const avgResponseTime = currentMetrics.promptLogs.length > 0 
        ? Math.round(totalResponseTime / currentMetrics.promptLogs.length) 
        : 0;
    const cacheHitRate = currentMetrics.promptLogs.length > 0
        ? Math.round((cacheHits / currentMetrics.promptLogs.length) * 100)
        : 0;

    return {
        gptInputTokens: currentMetrics.gptInputTokens,
        gptOutputTokens: currentMetrics.gptOutputTokens,
        totalTokens: currentMetrics.gptInputTokens + currentMetrics.gptOutputTokens,
        inputCost,
        outputCost,
        totalCost,
        totalResponseTime,
        avgResponseTime,
        promptCount: currentMetrics.promptLogs.length,
        apiCallCount,
        cacheHits,
        cacheHitRate,
        modeTotals,
        promptLogs: currentMetrics.promptLogs
    };
}

function formatTokens(tokens) {
    if (tokens == null || typeof tokens !== 'number') return '0';
    return tokens.toLocaleString();
}

function formatCost(cost) {
    if (cost == null || typeof cost !== 'number') return '$0.00';
    return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(4)}`;
}

function truncateText(text, maxLength = 140) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

function buildMemoryDebugHtml() {
    if (!rlmPipeline?.getStats) {
        return '';
    }

    const stats = rlmPipeline.getStats();
    const memoryStore = rlmPipeline.memoryStore;
    const stateBlock = memoryStore?.getStateBlock?.();
    const workingWindow = memoryStore?.getWorkingWindow?.();
    const shadowPrompt = stats.shadowPrompt;
    const focus = stats.memoryStore?.focus || {};
    const guardrails = stats.guardrails || {};
    const liveRetrievalStats = guardrails.lastRetrievalStats || null;
    const liveRetrievalReduction = liveRetrievalStats?.reduction || null;
    const formatTypeCounts = (counts = {}) => {
        const entries = Object.entries(counts);
        if (entries.length === 0) return 'None';
        return entries.map(([type, count]) => `${type}: ${count}`).join(', ');
    };

    const stateItems = [
        { label: 'Decisions', items: stateBlock?.decisions || [] },
        { label: 'Actions', items: stateBlock?.actions || [] },
        { label: 'Risks', items: stateBlock?.risks || [] },
        { label: 'Entities', items: stateBlock?.entities || [] },
        { label: 'Constraints', items: stateBlock?.constraints || [] },
        { label: 'Open Questions', items: stateBlock?.openQuestions || [] }
    ];

    const stateSummary = stateItems.map(({ label, items }) => (
        `<div class="debug-row"><span>${label}</span><span>${items.length}</span></div>`
    )).join('');

    const stateSamples = stateItems.map(({ label, items }) => {
        const sample = items.slice(0, 3).map(item => `<li>${escapeHtml(truncateText(item.text || ''))}</li>`).join('');
        return `
            <div class="debug-subsection">
                <div class="debug-subtitle">${label}</div>
                <ul class="debug-list">${sample || '<li class="muted">No entries</li>'}</ul>
            </div>
        `;
    }).join('');

    const workingTurns = (workingWindow?.lastUserTurns || []).map(turn => `<li>${escapeHtml(truncateText(turn, 120))}</li>`).join('');
    const workingSummary = workingWindow?.lastAssistantSummary
        ? `<p>${escapeHtml(truncateText(workingWindow.lastAssistantSummary, 220))}</p>`
        : '<p class="muted">No assistant summary.</p>';

    const retrievedSlices = (shadowPrompt?.retrievalSlices || []).map(slice => `
        <li>
            <span class="debug-pill">${escapeHtml(slice.type)}</span>
            <span class="muted">${slice._score != null ? slice._score.toFixed(2) : 'n/a'}</span>
            <div class="debug-text">${escapeHtml(truncateText(slice.text, 180))}</div>
        </li>
    `).join('');

    const tokenBreakdown = (shadowPrompt?.tokenBreakdown || []).map(section => `
        <div class="debug-row">
            <span>${escapeHtml(section.label)}</span>
            <span>${section.tokens}</span>
        </div>
    `).join('');

    const reduction = shadowPrompt?.retrievalStats?.reduction;
    const reductionHtml = reduction
        ? `<div class="debug-row"><span>Retrieval Trim</span><span>${reduction.dropped} dropped → ${reduction.finalCount} slices</span></div>`
        : '<div class="debug-row"><span>Retrieval Trim</span><span>None</span></div>';
    const retrievalDiff = shadowPrompt?.retrievalStats?.diff;
    const diffHtml = retrievalDiff
        ? `
            <div class="debug-row"><span>Retrieval Diff</span><span>+${retrievalDiff.addedCount} / -${retrievalDiff.removedCount}</span></div>
            <div class="debug-row"><span>Types (current)</span><span>${escapeHtml(formatTypeCounts(retrievalDiff.typeCounts))}</span></div>
            <div class="debug-row"><span>Types (previous)</span><span>${escapeHtml(formatTypeCounts(retrievalDiff.previousTypeCounts))}</span></div>
        `
        : '<div class="debug-row"><span>Retrieval Diff</span><span>None</span></div>';

    return `
        <div class="metrics-debug-panel">
            <div class="metrics-summary-header">🧠 Memory Debug Panel</div>
            <div class="debug-grid">
                <div class="debug-card">
                    <div class="debug-title">State Block Summary</div>
                    ${stateSummary || '<div class="muted">No state block data.</div>'}
                </div>
                <div class="debug-card">
                    <div class="debug-title">Focus Episodes</div>
                    <div class="debug-row"><span>Active</span><span>${focus.active ? 'Yes' : 'No'}</span></div>
                    <div class="debug-row"><span>Total</span><span>${focus.totalEpisodes ?? 0}</span></div>
                    <div class="debug-row"><span>Last Completed</span><span>${focus.lastCompletedAt || 'N/A'}</span></div>
                    <div class="debug-row"><span>Last Summary</span><span>${escapeHtml(truncateText(focus.lastSummary || 'N/A', 120))}</span></div>
                </div>
            <div class="debug-card">
                <div class="debug-title">Prompt Guardrails</div>
                <div class="debug-row"><span>Budget</span><span>${guardrails.lastBudget || 'N/A'}</span></div>
                <div class="debug-row"><span>Estimate</span><span>${guardrails.lastPromptEstimate || 'N/A'}</span></div>
                <div class="debug-row"><span>Trimmed</span><span>${guardrails.lastTrimmed ? `Yes (-${guardrails.lastTrimmedTokens})` : 'No'}</span></div>
                <div class="debug-row"><span>Mode</span><span>${guardrails.lastMode || 'N/A'}</span></div>
            </div>
            <div class="debug-card">
                <div class="debug-title">Live Retrieval</div>
                <div class="debug-row"><span>Enabled</span><span>${stats?.config?.enableRetrievalPrompt ? 'Yes' : 'No'}</span></div>
                <div class="debug-row"><span>Retrieved</span><span>${liveRetrievalStats ? `${liveRetrievalStats.selectedCount ?? 0} / ${liveRetrievalStats.requestedK ?? 0}` : 'N/A'}</span></div>
                <div class="debug-row"><span>Trim</span><span>${liveRetrievalReduction ? `${liveRetrievalReduction.dropped} dropped` : 'None'}</span></div>
            </div>
        </div>

            <div class="debug-section">
                <div class="debug-title">Working Window</div>
                <div class="debug-subsection">
                    <div class="debug-subtitle">Recent User Turns</div>
                    <ul class="debug-list">${workingTurns || '<li class="muted">No recent turns.</li>'}</ul>
                </div>
                <div class="debug-subsection">
                    <div class="debug-subtitle">Last Assistant Summary</div>
                    ${workingSummary}
                </div>
            </div>

            <div class="debug-section">
                <div class="debug-title">State Block Samples</div>
                <div class="debug-grid two-col">
                    ${stateSamples}
                </div>
            </div>

            <div class="debug-section">
                <div class="debug-title">Shadow Retrieval</div>
                <div class="debug-row"><span>Token Estimate</span><span>${shadowPrompt?.tokenEstimate ?? 'N/A'}</span></div>
                <div class="debug-row"><span>Retrieved</span><span>${shadowPrompt?.retrievalStats?.selectedCount ?? 0} / ${shadowPrompt?.retrievalStats?.requestedK ?? 0}</span></div>
                ${reductionHtml}
                ${diffHtml}
                <ul class="debug-list">${retrievedSlices || '<li class="muted">No slices retrieved.</li>'}</ul>
            </div>

            <div class="debug-section">
                <div class="debug-title">Token Breakdown (Shadow)</div>
                ${tokenBreakdown || '<div class="muted">No token breakdown available.</div>'}
            </div>
        </div>
    `;
}

function updateMemoryDebugPanel() {
    if (!elements.memoryDebugContent) {
        return;
    }

    if (!state.settings.showMemoryDebug) {
        elements.memoryDebugContent.innerHTML = '<p class="muted">Enable memory debug in settings to view state, retrieval, and token breakdowns.</p>';
        return;
    }

    const memoryDebugHtml = buildMemoryDebugHtml();
    elements.memoryDebugContent.innerHTML = memoryDebugHtml || '<p class="muted">Memory debug data is not available yet.</p>';
}

function updateMetricsDisplay() {
    console.log('[Metrics] updateMetricsDisplay called');
    
    if (!elements.metricsContent) {
        console.warn('[Metrics] metricsContent element not found');
        return;
    }

    const metrics = calculateMetrics();
    console.log('[Metrics] Calculated metrics:', { 
        totalTokens: metrics.totalTokens, 
        promptCount: metrics.promptCount,
        totalCost: metrics.totalCost 
    });

    // Build detailed per-prompt logs (most recent first)
    const promptLogsHtml = buildPromptLogsHtml(metrics.promptLogs);
    const modeTotals = metrics.modeTotals || {};
    const modeItems = [
        { key: 'direct', label: 'Direct' },
        { key: 'rlm', label: 'RLM' },
        { key: 'repl', label: 'REPL' }
    ];

    const modeBreakdownHtml = modeItems.map(({ key, label }) => {
        const data = modeTotals[key] || { tokens: 0, cost: 0, prompts: 0, calls: 0 };
        return `
                <div class="metric-breakdown-item">
                    <span>${label}</span>
                    <span>${formatTokens(data.tokens)} tokens (${formatCost(data.cost)}), ${data.prompts} prompts, ${data.calls} calls</span>
                </div>`;
    }).join('');

    elements.metricsContent.innerHTML = `
        <!-- Summary Totals Section -->
        <div class="metrics-summary">
            <div class="metrics-summary-header">📊 Session Summary</div>
            <div class="metrics-grid">
                <div class="metric-item">
                    <span class="metric-value">${formatTokens(metrics.totalTokens)}</span>
                    <span class="metric-label">Total Tokens</span>
                </div>
                <div class="metric-item">
                    <span class="metric-value">${formatCost(metrics.totalCost)}</span>
                    <span class="metric-label">Est. Cost</span>
                </div>
                <div class="metric-item">
                    <span class="metric-value">${metrics.promptCount}</span>
                    <span class="metric-label">Prompts</span>
                </div>
                <div class="metric-item">
                    <span class="metric-value">${metrics.apiCallCount}</span>
                    <span class="metric-label">API Calls</span>
                </div>
            </div>
            <div class="metric-breakdown">
                <div class="metric-breakdown-item">
                    <span>📥 Input Tokens</span>
                    <span>${formatTokens(metrics.gptInputTokens)} (${formatCost(metrics.inputCost)})</span>
                </div>
                <div class="metric-breakdown-item">
                    <span>📤 Output Tokens</span>
                    <span>${formatTokens(metrics.gptOutputTokens)} (${formatCost(metrics.outputCost)})</span>
                </div>
                <div class="metric-breakdown-item">
                    <span>⏱️ Total Time</span>
                    <span>${formatTime(metrics.totalResponseTime)}</span>
                </div>
            </div>
        </div>
        <div class="metric-breakdown metric-breakdown-extra">
            <div class="metric-breakdown-header">Stats</div>
            <div class="metric-breakdown-item">
                <span>Avg Response</span>
                <span>${formatTime(metrics.avgResponseTime)}</span>
            </div>
            <div class="metric-breakdown-item">
                <span>Cache Hits</span>
                <span>${metrics.cacheHits} (${metrics.cacheHitRate}%)</span>
            </div>
        </div>
        <div class="metric-breakdown metric-breakdown-modes">
            <div class="metric-breakdown-header">Mode Breakdown</div>
            ${modeBreakdownHtml}
        </div>
        
        <!-- Detailed Per-Prompt Logs Section -->
        ${metrics.promptLogs.length > 0 ? `
        <div class="metrics-prompt-logs">
            <div class="prompt-logs-header">
                <span>📝 Prompt-by-Prompt Breakdown</span>
                <span class="prompt-logs-count">${metrics.promptCount} prompts</span>
            </div>
            <div class="prompt-logs-list">
                ${promptLogsHtml}
            </div>
        </div>` : ''}
    `;

    // Show metrics card if hidden, default content to collapsed
    if (elements.metricsCard && metrics.promptLogs.length > 0) {
        console.log('[Metrics] Showing metrics card (promptLogs > 0)');
        elements.metricsCard.classList.remove('hidden');

        // Default content to collapsed unless already expanded
        if (!elements.metricsContent.dataset.initialized) {
            elements.metricsContent.classList.add('hidden');
            elements.metricsContent.dataset.initialized = 'true';
        }

        // Auto-collapse after 10 seconds if not pinned
        scheduleAutoCollapse();
    } else {
        console.log('[Metrics] NOT showing metrics card:', { 
            hasElement: !!elements.metricsCard, 
            totalTokens: metrics.totalTokens 
        });
    }

    updateMemoryDebugPanel();
}

/**
 * Build HTML for detailed prompt logs
 * Shows each API call with model, settings, tokens, cost, time, and confidence
 */
function buildPromptLogsHtml(promptLogs) {
    if (!promptLogs || promptLogs.length === 0) return '';
    
    // Show most recent first
    const reversedLogs = [...promptLogs].reverse();
    
    return reversedLogs.map((log, index) => {
        // Safety checks for required properties
        if (!log) return '';
        
        const logNumber = promptLogs.length - index;
        const timestamp = log.timestamp ? formatTimestamp(log.timestamp) : 'N/A';
        // Prefer log-level finishReason over confidence-level (validation result is more accurate)
        const confidenceHtml = buildConfidenceHtml(log.confidence || { available: false }, log.finishReason);
        
        // Ensure cost and tokens objects exist with defaults
        const cost = log.cost || { input: 0, output: 0, total: 0 };
        const tokens = log.tokens || { input: 0, output: 0, total: 0 };
        
        // Mode indicator with icon
        const modeIcons = { 'direct': '⚡', 'rlm': '🔄', 'repl': '🐍' };
        const modeLabels = { 'direct': 'Direct', 'rlm': 'RLM', 'repl': 'REPL' };
        const modeIcon = modeIcons[log.mode] || '⚡';
        const modeLabel = modeLabels[log.mode] || 'Direct';
        
        // Effort level display (only for GPT-5.2)
        const effortDisplay = log.model === 'gpt-5.2' && log.effort && log.effort !== 'none' && log.effort !== 'N/A'
            ? `<span class="effort-badge effort-${log.effort}">${log.effort}</span>`
            : '';
        
        // Sub-calls count (for RLM/REPL grouped calls)
        const subCallsCount = log.subCalls ? log.subCalls.length : 1;
        const subCallsDisplay = subCallsCount > 1 
            ? `<span class="subcalls-badge">${subCallsCount} calls</span>` 
            : '';
        const cacheDisplay = log.cached
            ? `<span class="cache-badge">Cached</span>`
            : '';
        const shadowPrompt = log.shadowPrompt || null;
        const shadowPromptStats = shadowPrompt?.retrievalStats
            ? escapeHtml(JSON.stringify(shadowPrompt.retrievalStats, null, 2))
            : '';
        const shadowPromptTokens = shadowPrompt?.tokenBreakdown
            ? escapeHtml(JSON.stringify(shadowPrompt.tokenBreakdown, null, 2))
            : '';
        const retrievalPromptStats = log.retrievalPrompt
            ? escapeHtml(JSON.stringify(log.retrievalPrompt, null, 2))
            : '';
        const focusEpisodes = Array.isArray(log.focusEpisodes) ? log.focusEpisodes : [];
        const focusHtml = focusEpisodes.map((episode, focusIndex) => {
            const focusLabel = focusEpisodes.length > 1 ? `#${focusIndex + 1}` : '';
            const focusReason = escapeHtml(episode.reason || 'unknown');
            const focusSummary = escapeHtml(episode.summary || '');
            const focusMode = episode.shadowOnly ? '<span class="muted">(shadow)</span>' : '';
            return `
                <div class="prompt-log-row">
                    <span class="log-label">🧠 Focus ${focusLabel}:</span>
                    <span class="log-value">${focusReason} ${focusMode}</span>
                </div>
                <div class="prompt-log-row prompt-preview">
                    <span class="log-label">🧠 Summary:</span>
                    <span class="log-value prompt-text">${focusSummary || '(No summary)'}</span>
                </div>`;
        }).join('');
        
        return `
        <details class="prompt-log-entry ${log.usesRLM ? 'uses-rlm' : ''}" id="${log.id || 'unknown'}">
            <summary class="prompt-log-header">
                <span class="prompt-log-number">#${logNumber}</span>
                <span class="prompt-log-mode" title="${modeLabel} mode">${modeIcon}</span>
                <span class="prompt-log-name">${escapeHtml(log.name || 'Unknown')}</span>
                <span class="prompt-log-cost">${formatCost(cost.total)}</span>
                <span class="prompt-log-time">${formatTime(log.responseTime || 0)}</span>
            </summary>
            <div class="prompt-log-details">
                <div class="prompt-log-row">
                    <span class="log-label">🤖 Model:</span>
                    <span class="log-value">
                        <span class="model-tag">${log.model || 'unknown'}</span>
                        ${effortDisplay}
                        ${subCallsDisplay}
                        ${cacheDisplay}
                    </span>
                </div>
                ${log.actualModels && log.actualModels.length > 1 ? `
                <div class="prompt-log-row">
                    <span class="log-label">🧭 Actual:</span>
                    <span class="log-value">${log.actualModels.map(formatModelName).join(', ')}</span>
                </div>` : ''}
                ${log.modelFallbacks && log.modelFallbacks.length > 0 ? `
                <div class="prompt-log-row">
                    <span class="log-label">⚠️ Fallback:</span>
                    <span class="log-value warning-text">${formatModelFallbacks(log.modelFallbacks)}</span>
                </div>` : ''}
                <div class="prompt-log-row">
                    <span class="log-label">🔀 Mode:</span>
                    <span class="log-value">
                        <span class="mode-tag mode-${log.mode || 'direct'}">${modeIcon} ${modeLabel}</span>
                        ${log.usesRLM ? '<span class="rlm-indicator">RLM Active</span>' : ''}
                    </span>
                </div>
                ${log.cached ? `
                <div class="prompt-log-row">
                    <span class="log-label">Cache:</span>
                    <span class="log-value">Hit (no API calls)</span>
                </div>` : ''}
                ${log.model === 'gpt-5.2' ? `
                <div class="prompt-log-row">
                    <span class="log-label">🧠 Effort:</span>
                    <span class="log-value effort-display ${log.effort && log.effort !== 'none' ? 'effort-' + log.effort : 'effort-none'}">
                        ${log.effort === 'none' || log.effort === 'N/A' || !log.effort ? 'None (Fast)' : log.effort.charAt(0).toUpperCase() + log.effort.slice(1)}
                    </span>
                </div>` : ''}
                <div class="prompt-log-row">
                    <span class="log-label">⏰ Time:</span>
                    <span class="log-value">${timestamp}</span>
                </div>
                <div class="prompt-log-row">
                    <span class="log-label">📥 Input:</span>
                    <span class="log-value">${formatTokens(tokens.input)} tokens (${formatCost(cost.input)})</span>
                </div>
                <div class="prompt-log-row">
                    <span class="log-label">📤 Output:</span>
                    <span class="log-value">${formatTokens(tokens.output)} tokens (${formatCost(cost.output)})</span>
                </div>
                <div class="prompt-log-row">
                    <span class="log-label">⏱️ Response:</span>
                    <span class="log-value">${formatTime(log.responseTime || 0)}</span>
                </div>
                <div class="prompt-log-row">
                    <span class="log-label">💰 Cost:</span>
                    <span class="log-value cost-highlight">${formatCost(cost.total)}</span>
                </div>
                ${subCallsCount > 1 ? `
                <div class="prompt-log-row">
                    <span class="log-label">🔢 API Calls:</span>
                    <span class="log-value">${subCallsCount} sub-calls aggregated</span>
                </div>` : ''}
                ${(log.emptyResponse || (log.retryAttempt > 0) || (log.maxRetryAttempt > 0)) ? `
                <div class="prompt-log-row">
                    <span class="log-label">⚠️ Status:</span>
                    <span class="log-value">
                        ${log.emptyResponse ? '<span class="warning-text">Empty Response</span>' : ''}
                        ${(log.retryAttempt > 0 || log.maxRetryAttempt > 0) ? `<span class="info-text">Retried ${log.maxRetryAttempt || log.retryAttempt || 0} time(s)</span>` : ''}
                    </span>
                </div>` : ''}
                ${log.finishReason && log.finishReason !== 'stop' && log.finishReason !== 'unknown' ? `
                <div class="prompt-log-row">
                    <span class="log-label">🏁 Finish Reason:</span>
                    <span class="log-value">
                        ${log.finishReason === 'content_filter' ? '⚠️ Content Filtered' : ''}
                        ${log.finishReason === 'length' ? '⚠️ Truncated (Length)' : ''}
                        ${log.finishReason === 'stop_sequence' ? '⏹️ Stop Sequence' : ''}
                        ${!['content_filter', 'length', 'stop_sequence'].includes(log.finishReason) ? log.finishReason : ''}
                    </span>
                </div>` : ''}
                ${confidenceHtml}
                ${focusHtml}
                ${shadowPrompt ? `
                <div class="prompt-log-row">
                    <span class="log-label">🕶️ Shadow-only tokens:</span>
                    <span class="log-value">${shadowPrompt.tokenEstimate ?? 'N/A'}</span>
                </div>
                <div class="prompt-log-row">
                    <span class="log-label">🕶️ Token breakdown:</span>
                    <span class="log-value"><pre class="prompt-json">${shadowPromptTokens || 'N/A'}</pre></span>
                </div>
                <div class="prompt-log-row">
                    <span class="log-label">🕶️ Shadow-only retrieval:</span>
                    <span class="log-value"><pre class="prompt-json">${shadowPromptStats || 'N/A'}</pre></span>
                </div>
                <div class="prompt-log-row prompt-preview">
                    <span class="log-label">🕶️ Shadow-only prompt:</span>
                    <span class="log-value prompt-text">${escapeHtml(shadowPrompt.promptPreview || '(No shadow prompt preview)')}</span>
                </div>` : ''}
                ${log.retrievalPrompt ? `
                <div class="prompt-log-row">
                    <span class="log-label">📚 Live retrieval:</span>
                    <span class="log-value"><pre class="prompt-json">${retrievalPromptStats || 'N/A'}</pre></span>
                </div>` : ''}
                <div class="prompt-log-row prompt-preview">
                    <span class="log-label">💬 Prompt:</span>
                    <span class="log-value prompt-text">${escapeHtml(log.promptPreview || '(No preview)')}</span>
                </div>
            </div>
        </details>`;
    }).join('');
}

/**
 * Build confidence/fidelity display HTML
 * Note: finishReason is displayed separately in log details, not here
 * @param {Object} confidence - Confidence metrics object
 * @param {string} logFinishReason - Optional finish reason (unused, kept for API compatibility)
 */
function buildConfidenceHtml(confidence, logFinishReason = null) {
    if (!confidence || !confidence.available) {
        return `
        <div class="prompt-log-row">
            <span class="log-label">🎯 Confidence:</span>
            <span class="log-value confidence-na">N/A (request logprobs for confidence data)</span>
        </div>`;
    }
    
    let confidenceItems = [];
    
    // Note: finishReason is displayed separately in the log details, not here
    // This function only shows confidence-specific metrics (logprobs, reasoning tokens, truncation)
    
    if (confidence.reasoningTokens != null && confidence.reasoningTokens > 0) {
        confidenceItems.push(`
            <div class="prompt-log-row">
                <span class="log-label">🧠 Reasoning:</span>
                <span class="log-value">${formatTokens(confidence.reasoningTokens)} tokens</span>
            </div>`);
    }
    
    if (confidence.avgLogprob != null && typeof confidence.avgLogprob === 'number') {
        const confidencePercent = Math.round(confidence.avgLogprob * 100);
        const confidenceClass = confidencePercent >= 80 ? 'high' : 
                               confidencePercent >= 50 ? 'medium' : 'low';
        confidenceItems.push(`
            <div class="prompt-log-row">
                <span class="log-label">🎯 Confidence:</span>
                <span class="log-value confidence-${confidenceClass}">${confidencePercent}%</span>
            </div>`);
    }
    
    if (confidence.truncated) {
        confidenceItems.push(`
            <div class="prompt-log-row">
                <span class="log-label">⚠️ Warning:</span>
                <span class="log-value warning-text">Response was truncated</span>
            </div>`);
    }
    
    return confidenceItems.length > 0 ? confidenceItems.join('') : `
        <div class="prompt-log-row">
            <span class="log-label">🎯 Confidence:</span>
            <span class="log-value">Completed</span>
        </div>`;
}

/**
 * Format time in milliseconds to human readable string
 */
function formatTime(ms) {
    if (ms == null || typeof ms !== 'number') return '0ms';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });
}

function formatModelFallbacks(modelFallbacks) {
    if (!Array.isArray(modelFallbacks) || modelFallbacks.length === 0) {
        return '';
    }

    const seen = new Set();
    const formatted = [];

    modelFallbacks.forEach(({ requestedModel, actualModel }) => {
        if (!requestedModel || !actualModel) return;
        const key = `${requestedModel}->${actualModel}`;
        if (seen.has(key)) return;
        seen.add(key);
        formatted.push(`${formatModelName(requestedModel)} → ${formatModelName(actualModel)}`);
    });

    return formatted.join(', ');
}

function scheduleAutoCollapse() {
    // Clear any existing timeout
    if (metricsState.autoCollapseTimeout) {
        clearTimeout(metricsState.autoCollapseTimeout);
    }

    // Don't auto-collapse if pinned or already collapsed
    if (metricsState.isPinned || elements.metricsContent.classList.contains('hidden')) {
        return;
    }

    // Schedule auto-collapse in 10 seconds
    metricsState.autoCollapseTimeout = setTimeout(() => {
        if (!metricsState.isPinned && !elements.metricsContent.classList.contains('hidden')) {
            elements.metricsContent.classList.add('hidden');
            updateToggleIcon();
        }
    }, 10000);
}

function resetMetrics() {
    currentMetrics = {
        gptInputTokens: 0,
        gptOutputTokens: 0,
        totalCost: 0,
        totalResponseTime: 0,
        promptLogs: []
    };
    promptLogIdCounter = 0;
    activePromptGroup = null;
    updateMetricsDisplay();
    if (elements.metricsCard) {
        elements.metricsCard.classList.add('hidden');
    }
}

function toggleMetricsCard() {
    if (elements.metricsContent) {
        elements.metricsContent.classList.toggle('hidden');
        updateToggleIcon();

        // If expanding, schedule auto-collapse (unless pinned)
        if (!elements.metricsContent.classList.contains('hidden')) {
            scheduleAutoCollapse();
        }
    }
}

function updateToggleIcon() {
    if (!elements.metricsToggle) return;

    const isCollapsed = elements.metricsContent.classList.contains('hidden');
    elements.metricsToggle.textContent = isCollapsed ? '▶' : '▼';
}

function toggleMetricsPin() {
    metricsState.isPinned = !metricsState.isPinned;

    const pinBtn = document.getElementById('metrics-pin-btn');
    if (pinBtn) {
        pinBtn.textContent = metricsState.isPinned ? '📌' : '📍';
        pinBtn.title = metricsState.isPinned ? 'Unpin metrics' : 'Pin metrics open';
        pinBtn.style.opacity = metricsState.isPinned ? '1' : '0.6';
    }

    // If pinning, cancel auto-collapse
    if (metricsState.isPinned && metricsState.autoCollapseTimeout) {
        clearTimeout(metricsState.autoCollapseTimeout);
    }

    // If unpinning and expanded, schedule auto-collapse
    if (!metricsState.isPinned && !elements.metricsContent.classList.contains('hidden')) {
        scheduleAutoCollapse();
    }
}

/**
 * Download metrics as CSV file
 */
function downloadMetricsCSV() {
    const metrics = calculateMetrics();
    
    if (metrics.promptLogs.length === 0) {
        showError('No metrics data to download');
        return;
    }

    // CSV header
    const headers = [
        'Timestamp',
        'Name',
        'Model',
        'Effort',
        'Mode',
        'Uses RLM',
        'Cached',
        'Input Tokens',
        'Output Tokens',
        'Total Tokens',
        'Input Cost ($)',
        'Output Cost ($)',
        'Total Cost ($)',
        'Response Time (ms)',
        'Confidence Available',
        'Avg Logprob',
        'Reasoning Tokens',
        'Finish Reason',
        'Truncated',
        'Empty Response',
        'Retry Attempts',
        'Sub-Calls Count',
        'Prompt Preview',
        'Response'
    ];

    // Helper function to escape CSV values
    function escapeCSV(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        // If contains comma, quote, or newline, wrap in quotes and escape quotes
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    // Build CSV rows
    const rows = [headers.map(escapeCSV).join(',')];

    metrics.promptLogs.forEach((log, index) => {
        // For grouped calls, use the group-level data
        const row = [
            escapeCSV(log.timestamp || ''),
            escapeCSV(log.name || ''),
            escapeCSV(log.model || ''),
            escapeCSV(log.effort || 'N/A'),
            escapeCSV(log.mode || 'direct'),
            escapeCSV(log.usesRLM ? 'Yes' : 'No'),
            escapeCSV(log.cached ? 'Yes' : 'No'),
            escapeCSV(log.tokens?.input || 0),
            escapeCSV(log.tokens?.output || 0),
            escapeCSV(log.tokens?.total || 0),
            escapeCSV((log.cost?.input || 0).toFixed(6)),
            escapeCSV((log.cost?.output || 0).toFixed(6)),
            escapeCSV((log.cost?.total || 0).toFixed(6)),
            escapeCSV(log.responseTime || 0),
            escapeCSV(log.confidence?.available ? 'Yes' : 'No'),
            escapeCSV(log.confidence?.avgLogprob != null ? (log.confidence.avgLogprob * 100).toFixed(2) + '%' : ''),
            escapeCSV(log.confidence?.reasoningTokens || ''),
            escapeCSV(log.confidence?.finishReason || log.finishReason || ''),
            escapeCSV(log.confidence?.truncated ? 'Yes' : 'No'),
            escapeCSV(log.emptyResponse ? 'Yes' : 'No'),
            escapeCSV(log.maxRetryAttempt || log.retryAttempt || 0),
            escapeCSV(log.subCalls?.length || 1),
            escapeCSV(log.promptPreview || ''),
            escapeCSV(log.response || '')  // Include the full response
        ];
        rows.push(row.join(','));
    });

    // Create CSV content
    const csvContent = rows.join('\n');
    
    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    link.setAttribute('href', url);
    link.setAttribute('download', `northstar-metrics-${timestamp}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up URL
    setTimeout(() => URL.revokeObjectURL(url), 100);
    
    console.log('[Metrics] CSV downloaded:', metrics.promptLogs.length, 'entries');
}

// ============================================
// Error Handling
// ============================================

function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorSection.classList.remove('hidden');
}

function hideError() {
    elements.errorSection.classList.add('hidden');
}

// ============================================
// Help Modal
// ============================================

function showHelpModal() {
    if (elements.helpModal) {
        elements.helpModal.classList.remove('hidden');
    }
}

function hideHelpModal() {
    if (elements.helpModal) {
        elements.helpModal.classList.add('hidden');
    }
}

// ============================================
// Button Loader Helpers
// ============================================

function showButtonLoader(button) {
    button.querySelector('.btn-text')?.classList.add('hidden');
    button.querySelector('.btn-loader')?.classList.remove('hidden');
}

function hideButtonLoader(button) {
    button.querySelector('.btn-text')?.classList.remove('hidden');
    button.querySelector('.btn-loader')?.classList.add('hidden');
}

// ============================================
// Initialize on DOM Ready
// ============================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    setTimeout(init, 0);
}
