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
    isProcessing: false,
    settings: {
        model: 'gpt-5.2',      // 'gpt-5.2', 'gpt-5-mini', or 'gpt-5-nano'
        effort: 'none',        // 'none', 'low', 'medium', 'high' (only for gpt-5.2) - default 'none' for compatibility
        useRLM: true,          // Enable/disable RLM processing
        rlmAuto: true          // Auto-route RLM only for ambiguous prompts
    }
};

// Model pricing (per 1M tokens) - from OpenAI docs
const PRICING = {
    'gpt-5.2': { input: 2.50, output: 10.00 },      // Full reasoning model
    'gpt-5-mini': { input: 0.25, output: 2.00 },    // Fast, cost-efficient
    'gpt-5-nano': { input: 0.05, output: 0.40 }     // Fastest, cheapest
};

const MODEL_DISPLAY_NAMES = {
    'gpt-5.2': 'GPT-5.2',
    'gpt-5-mini': 'GPT-5-mini',
    'gpt-5-nano': 'GPT-5-nano'
};

const fallbackNoticeKeys = new Set();

// Model-specific max completion token limits
// Smaller models may have stricter limits to prevent truncation issues
const MODEL_TOKEN_LIMITS = {
    'gpt-5.2': 4000,      // Full model, higher limit
    'gpt-5-mini': 2000,   // Medium limit
    'gpt-5-nano': 2000    // Increased from 1000 - may have been too restrictive
};

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
        modelFallbackNotified: false
    };
    return activePromptGroup.id;
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
    
    // Aggregate finish reasons from sub-calls (priority: content_filter > length > stop_sequence > stop > unknown)
    if (activePromptGroup.subCalls && activePromptGroup.subCalls.length > 0) {
        const finishReasonPriority = {
            'content_filter': 4,
            'length': 3,
            'stop_sequence': 2,
            'stop': 1,
            'unknown': 0
        };
        
        let highestPriorityReason = 'stop';
        let highestPriority = 1;
        
        activePromptGroup.subCalls.forEach(subCall => {
            const reason = subCall.finishReason || 'unknown';
            const priority = finishReasonPriority[reason] !== undefined ? finishReasonPriority[reason] : 0;
            if (priority > highestPriority) {
                highestPriority = priority;
                highestPriorityReason = reason;
            }
        });
        
        activePromptGroup.finishReason = highestPriorityReason;
    }
    
    // Aggregate confidence from sub-calls (with safe null checks)
    if (activePromptGroup.confidence && activePromptGroup.confidence.samples && activePromptGroup.confidence.samples.length > 0) {
        // Average the confidence scores (only from valid samples)
        const validSamples = activePromptGroup.confidence.samples.filter(s => s && s.avgLogprob !== null && s.avgLogprob !== undefined);
        if (validSamples.length > 0) {
            activePromptGroup.confidence.available = true;
            activePromptGroup.confidence.avgLogprob = 
                validSamples.reduce((sum, s) => sum + s.avgLogprob, 0) / validSamples.length;
        }
        // Check for any truncations
        activePromptGroup.confidence.truncated = 
            activePromptGroup.confidence.samples.some(s => s && s.truncated);
        // Get reasoning tokens total
        const reasoningSamples = activePromptGroup.confidence.samples.filter(s => s && s.reasoningTokens !== null && s.reasoningTokens !== undefined);
        if (reasoningSamples.length > 0) {
            const reasoningTotal = reasoningSamples.reduce((sum, s) => sum + s.reasoningTokens, 0);
            if (reasoningTotal > 0) {
                activePromptGroup.confidence.reasoningTokens = reasoningTotal;
                activePromptGroup.confidence.available = true;
            }
        }
    }

    if (activePromptGroup.actualModels && activePromptGroup.actualModels.length > 0) {
        if (activePromptGroup.actualModels.length === 1) {
            activePromptGroup.model = activePromptGroup.actualModels[0];
            if (activePromptGroup.model !== 'gpt-5.2') {
                activePromptGroup.effort = 'N/A';
            }
        } else {
            activePromptGroup.model = 'mixed';
            activePromptGroup.effort = 'N/A';
        }
    }
    
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
        // Add to current group
        activePromptGroup.subCalls.push(callData);
        activePromptGroup.tokens.input += callData.tokens.input;
        activePromptGroup.tokens.output += callData.tokens.output;
        activePromptGroup.tokens.total += callData.tokens.total;
        activePromptGroup.cost.input += callData.cost.input;
        activePromptGroup.cost.output += callData.cost.output;
        activePromptGroup.cost.total += callData.cost.total;

        if (callData.actualModel) {
            if (!activePromptGroup.actualModels.includes(callData.actualModel)) {
                activePromptGroup.actualModels.push(callData.actualModel);
            }
        }
        if (callData.modelFallback) {
            activePromptGroup.modelFallbacks.push({
                requestedModel: callData.requestedModel,
                actualModel: callData.actualModel,
                callName: callData.name
            });
        }
        
        // Track empty responses and retry attempts
        if (callData.emptyResponse) {
            activePromptGroup.emptyResponse = true;
        }
        if (callData.retryAttempt && callData.retryAttempt > activePromptGroup.maxRetryAttempt) {
            activePromptGroup.maxRetryAttempt = callData.retryAttempt;
        }
        
        // Collect confidence samples
        if (callData.confidence) {
            activePromptGroup.confidence.samples.push(callData.confidence);
        }
    } else {
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
        rlmToggle: document.getElementById('rlm-toggle'),
        rlmAutoToggle: document.getElementById('rlm-auto-toggle')
    };
}

// ============================================
// State Persistence (sessionStorage)
// ============================================

const STORAGE_KEYS = {
    AGENTS: 'orch_agents',
    CHAT_HISTORY: 'orch_chat_history',
    INSIGHTS: 'orch_insights'
};

/**
 * Save state to sessionStorage
 */
function saveState() {
    try {
        sessionStorage.setItem(STORAGE_KEYS.AGENTS, JSON.stringify(state.agents));
        sessionStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(state.chatHistory));
        if (state.insights) {
            sessionStorage.setItem(STORAGE_KEYS.INSIGHTS, JSON.stringify(state.insights));
        }
        console.log('[State] Saved to sessionStorage:', {
            agents: state.agents.length,
            chatHistory: state.chatHistory.length
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
    if (elements.rlmToggle) {
        elements.rlmToggle.checked = state.settings.useRLM;
    }
    if (elements.rlmAutoToggle) {
        elements.rlmAutoToggle.checked = state.settings.rlmAuto;
        elements.rlmAutoToggle.disabled = !state.settings.useRLM;
    }
    // Show/hide effort dropdown based on model
    updateEffortVisibility();
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
    if (elements.rlmToggle) {
        elements.rlmToggle.addEventListener('change', handleRLMToggle);
    }
    if (elements.rlmAutoToggle) {
        elements.rlmAutoToggle.addEventListener('change', handleRLMAutoToggle);
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
 * Handle RLM toggle change
 */
function handleRLMToggle(e) {
    state.settings.useRLM = e.target.checked;
    saveSettings();
    console.log('[Settings] RLM toggled:', state.settings.useRLM ? 'enabled' : 'disabled');
    updateSettingsUI();
}

/**
 * Handle RLM auto-routing toggle change
 */
function handleRLMAutoToggle(e) {
    state.settings.rlmAuto = e.target.checked;
    saveSettings();
    console.log('[Settings] RLM auto-routing toggled:', state.settings.rlmAuto ? 'enabled' : 'disabled');
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

function parseAgentFile(content) {
    const result = {
        title: 'Untitled Meeting',
        date: null,
        sourceType: 'unknown',
        summary: '',
        keyPoints: '',
        actionItems: '',
        sentiment: '',
        transcript: ''
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
    
    // Clear chat session storage
    sessionStorage.removeItem(STORAGE_KEYS.CHAT_HISTORY);
    
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
        const response = await chatWithAgents(message, thinkingId);
        
        // Store prompt preview and response in the active group
        if (activePromptGroup) {
            activePromptGroup.promptPreview = queryPreview;
            activePromptGroup.response = response;  // Store the full response
        }

        // Final step
        addThinkingStep(thinkingId, 'Response ready', 'success');
        updateThinkingStatus(thinkingId, 'Formatting...');

        removeThinkingIndicator(thinkingId);
        appendChatMessage('assistant', response);
    } catch (error) {
        // Store error response in active group if available
        if (activePromptGroup) {
            activePromptGroup.response = `Error: ${error.message}`;
        }
        removeThinkingIndicator(thinkingId);
        
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
        
        appendChatMessage('assistant', errorMessage);
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

async function chatWithAgents(userMessage, thinkingId = null) {
    // Check if RLM is enabled in settings
    if (!state.settings.useRLM) {
        console.log('[Chat] RLM disabled via settings, using legacy processing');
        return await chatWithAgentsLegacy(userMessage);
    }
    
    // Check if REPL should be used (code-assisted queries)
    const useREPL = rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(userMessage, { auto: state.settings.rlmAuto });

    if (useREPL) {
        console.log('[Chat] Using REPL-assisted processing for query');
        return await chatWithREPL(userMessage, thinkingId);
    }

    // Check if RLM should be used for this query
    const useRLM = rlmPipeline.shouldUseRLM(userMessage, { auto: state.settings.rlmAuto });

    if (useRLM) {
        console.log('[Chat] Using RLM pipeline for query');
        return await chatWithRLM(userMessage, thinkingId);
    } else {
        console.log('[Chat] Using legacy processing for query');
        return await chatWithAgentsLegacy(userMessage);
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

        return callGPTWithMessages(messages, `REPL: ${userMessage.substring(0, 20)}...`);
    };

    // Set up progress callback if we have a thinking ID
    // Phase 3.2: Now passes details for depth-based indentation
    // Phase 3.4: Also update status bar to sync with step log
    if (thinkingId) {
        rlmPipeline.setProgressCallback((step, type, details) => {
            addThinkingStep(thinkingId, step, type, details);
            // Update status bar for in-progress steps (not completion types)
            if (type !== 'success' && type !== 'warning' && type !== 'cache') {
                updateThinkingStatus(thinkingId, step);
            }
        });
    }

    // Process through REPL pipeline
    const result = await rlmPipeline.processWithREPL(userMessage, llmCallWrapper, {
        apiKey: state.apiKey
    });

    // Clear progress callback
    rlmPipeline.setProgressCallback(null);

    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: result.response });

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
        const recentHistory = state.chatHistory.slice(-10);
        if (recentHistory.length > 0) {
            messages.splice(1, 0, ...recentHistory);
        }

        return callGPTWithMessages(messages, `RLM: ${userMessage.substring(0, 20)}...`);
    };

    // Set up progress callback if we have a thinking ID
    // Phase 3.2: Now passes details for depth-based indentation
    // Phase 3.4: Also update status bar to sync with step log
    if (thinkingId) {
        rlmPipeline.setProgressCallback((step, type, details) => {
            addThinkingStep(thinkingId, step, type, details);
            // Update status bar for in-progress steps (not completion types)
            if (type !== 'success' && type !== 'warning' && type !== 'cache') {
                updateThinkingStatus(thinkingId, step);
            }
        });
    }

    // Process through RLM pipeline
    const result = await rlmPipeline.process(userMessage, llmCallWrapper, {
        apiKey: state.apiKey
    });

    // Clear progress callback
    rlmPipeline.setProgressCallback(null);

    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: result.response });

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
async function chatWithAgentsLegacy(userMessage) {
    // Build context with smart agent selection
    const context = buildChatContext(userMessage);

    const systemPrompt = `You are a helpful meeting assistant with access to data from multiple meetings.
Use the following meeting data to answer questions accurately and comprehensively.
If information isn't available in the meeting data, say so clearly.
Be concise but thorough. Use bullet points when listing multiple items.

${context}`;

    // Build messages array with history
    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // Add recent chat history (last 10 exchanges)
    const recentHistory = state.chatHistory.slice(-20);
    messages.push(...recentHistory);

    // Add current message
    messages.push({ role: 'user', content: userMessage });

    const response = await callGPTWithMessages(messages, `Chat: ${userMessage.substring(0, 30)}...`);

    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: response });

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

function buildChatContext(userQuery = '') {
    // Only use active agents
    const activeAgents = state.agents.filter(a => a.enabled);

    // Select only relevant agents for this query
    const relevantAgents = userQuery ?
        selectRelevantAgents(userQuery, activeAgents, 5) :
        activeAgents.slice(0, 5); // Default to first 5 if no query

    // Dynamic transcript limit based on number of agents (more agents = less transcript per agent)
    // Total context budget ~50k chars, reserve ~30k for transcripts across all agents
    const transcriptLimit = Math.floor(30000 / Math.max(relevantAgents.length, 1));

    return relevantAgents.map((agent, index) => {
        const transcriptSection = agent.transcript
            ? (agent.transcript.length > transcriptLimit
                ? `Transcript: ${agent.transcript.substring(0, transcriptLimit)}...[truncated]`
                : `Transcript: ${agent.transcript}`)
            : '';

        return `
--- Meeting ${index + 1}: ${agent.displayName || agent.title} (${agent.date || 'No date'}) ---
Summary: ${agent.summary}
Key Points: ${agent.keyPoints}
Action Items: ${agent.actionItems}
Sentiment: ${agent.sentiment}
${transcriptSection}
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
            body.temperature = 1;
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
            
            // Check if we have valid content first
            if (validationResult.content && typeof validationResult.content === 'string' && validationResult.content.trim().length > 0) {
                // Only track metrics for successful calls to avoid inflating totals with retry attempts
                if (data.usage) {
                    const inputTokens = data.usage.prompt_tokens || 0;
                    const outputTokens = data.usage.completion_tokens || 0;
                    
                    // Calculate cost for this call
                    const pricing = PRICING[actualModel] || PRICING[model] || PRICING['gpt-5.2'];
                    const inputCost = (inputTokens / 1000000) * pricing.input;
                    const outputCost = (outputTokens / 1000000) * pricing.output;
                    const callCost = inputCost + outputCost;
                    
                    // Create API call data
                    const callData = {
                        timestamp: new Date().toISOString(),
                        name: callName,
                        model: actualModel,
                        requestedModel: model,
                        actualModel: actualModel,
                        modelFallback: modelFallback,
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
                        responseTime: responseTime,
                        confidence: extractConfidenceMetrics(data, validationResult.finishReason),
                        promptPreview: userContent.substring(0, 100) + (userContent.length > 100 ? '...' : ''),
                        response: validationResult.content,
                        emptyResponse: false,
                        finishReason: validationResult.finishReason,
                        retryAttempt: retryAttempt
                    };
                    
                    // Add to metrics (grouped or standalone)
                    addAPICallToMetrics(callData);
                }
                
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

async function callGPTWithMessages(messages, callName = 'Chat Query') {
    const model = state.settings.model;
    const effort = state.settings.effort;
    
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
            
            // Check if we have valid content first
            if (validationResult.content && typeof validationResult.content === 'string' && validationResult.content.trim().length > 0) {
                // Only track metrics for successful calls to avoid inflating totals with retry attempts
                if (data.usage) {
                    const inputTokens = data.usage.prompt_tokens || 0;
                    const outputTokens = data.usage.completion_tokens || 0;
                    
                    // Calculate cost for this call
                    const pricing = PRICING[actualModel] || PRICING[model] || PRICING['gpt-5.2'];
                    const inputCost = (inputTokens / 1000000) * pricing.input;
                    const outputCost = (outputTokens / 1000000) * pricing.output;
                    const callCost = inputCost + outputCost;
                    
                    // Extract user message for preview (last user message)
                    const userMessage = messages.filter(m => m.role === 'user').pop();
                    const promptPreview = userMessage ? 
                        userMessage.content.substring(0, 100) + (userMessage.content.length > 100 ? '...' : '') :
                        '(No user message)';
                    
                    // Create API call data
                    const callData = {
                        timestamp: new Date().toISOString(),
                        name: callName,
                        model: actualModel,
                        requestedModel: model,
                        actualModel: actualModel,
                        modelFallback: modelFallback,
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
                        responseTime: responseTime,
                        confidence: extractConfidenceMetrics(data, validationResult.finishReason),
                        promptPreview: promptPreview,
                        response: validationResult.content,
                        emptyResponse: false,
                        finishReason: validationResult.finishReason,
                        retryAttempt: retryAttempt
                    };
                    
                    // Add to metrics (grouped or standalone)
                    addAPICallToMetrics(callData);
                }
                
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
    
    currentMetrics.promptLogs.forEach(log => {
        inputCost += log.cost.input;
        outputCost += log.cost.output;
        totalResponseTime += log.responseTime;
    });
    
    const totalCost = inputCost + outputCost;
    const avgResponseTime = currentMetrics.promptLogs.length > 0 
        ? Math.round(totalResponseTime / currentMetrics.promptLogs.length) 
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
                    <span class="metric-label">API Calls</span>
                </div>
                <div class="metric-item">
                    <span class="metric-value">${formatTime(metrics.avgResponseTime)}</span>
                    <span class="metric-label">Avg Response</span>
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
        
        <!-- Detailed Per-Prompt Logs Section -->
        ${metrics.promptLogs.length > 0 ? `
        <div class="metrics-prompt-logs">
            <div class="prompt-logs-header">
                <span>📝 Prompt-by-Prompt Breakdown</span>
                <span class="prompt-logs-count">${metrics.promptCount} calls</span>
            </div>
            <div class="prompt-logs-list">
                ${promptLogsHtml}
            </div>
        </div>` : ''}
    `;

    // Show metrics card if hidden, default content to collapsed
    if (elements.metricsCard && metrics.totalTokens > 0) {
        console.log('[Metrics] Showing metrics card (totalTokens > 0)');
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
