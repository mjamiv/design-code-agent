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
        effort: 'medium',      // 'low', 'medium', 'high' (only for gpt-5.2)
        useRLM: true           // Enable/disable RLM processing
    }
};

// Model pricing (per 1M tokens)
// Model pricing (per 1M tokens) - from OpenAI docs
const PRICING = {
    'gpt-5.2': { input: 2.50, output: 10.00 },      // Full reasoning model
    'gpt-5-mini': { input: 0.25, output: 2.00 },    // Fast, cost-efficient
    'gpt-5-nano': { input: 0.05, output: 0.40 }     // Fastest, cheapest
};

// Metrics tracking for current session
let currentMetrics = {
    gptInputTokens: 0,
    gptOutputTokens: 0,
    apiCalls: []
};

// Metrics card state
let metricsState = {
    isPinned: false,
    autoCollapseTimeout: null
};

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
        rlmToggle: document.getElementById('rlm-toggle')
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
        elements.clearCacheBtn.addEventListener('click', clearQueryCache);
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
 * Clear the RLM query result cache
 * Phase 3.1: Cache management
 */
function clearQueryCache() {
    rlmPipeline.clearCache();
    
    // Show temporary feedback on button
    if (elements.clearCacheBtn) {
        const originalText = elements.clearCacheBtn.textContent;
        elements.clearCacheBtn.textContent = 'Cleared!';
        elements.clearCacheBtn.disabled = true;
        setTimeout(() => {
            elements.clearCacheBtn.textContent = originalText;
            elements.clearCacheBtn.disabled = false;
        }, 1500);
    }
    
    console.log('[Orchestrator] Query cache cleared');
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
        const useREPL = rlmEnabled && rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(message);
        const useRLM = rlmEnabled && !useREPL && rlmPipeline.shouldUseRLM(message);
        const activeAgentCount = state.agents.filter(a => a.enabled).length;
        const modelNames = { 'gpt-5.2': 'GPT-5.2', 'gpt-5-mini': 'GPT-5-mini', 'gpt-5-nano': 'GPT-5-nano' };
        const modelName = modelNames[state.settings.model] || 'GPT-5.2';

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

        // Final step
        addThinkingStep(thinkingId, 'Response ready', 'success');
        updateThinkingStatus(thinkingId, 'Formatting...');

        removeThinkingIndicator(thinkingId);
        appendChatMessage('assistant', response);
    } catch (error) {
        removeThinkingIndicator(thinkingId);
        appendChatMessage('assistant', `Sorry, I encountered an error: ${error.message}`);
    } finally {
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
    const useREPL = rlmPipeline.shouldUseREPL && rlmPipeline.shouldUseREPL(userMessage);

    if (useREPL) {
        console.log('[Chat] Using REPL-assisted processing for query');
        return await chatWithREPL(userMessage, thinkingId);
    }

    // Check if RLM should be used for this query
    const useRLM = rlmPipeline.shouldUseRLM(userMessage);

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

    return relevantAgents.map((agent, index) => `
--- Meeting ${index + 1}: ${agent.displayName || agent.title} (${agent.date || 'No date'}) ---
Summary: ${agent.summary}
Key Points: ${agent.keyPoints}
Action Items: ${agent.actionItems}
Sentiment: ${agent.sentiment}
${agent.transcript ? `Transcript excerpt: ${agent.transcript.substring(0, 1500)}...` : ''}
`).join('\n\n');
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
 * - reasoning.effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
 *   - Default is 'none' (favors speed)
 *   - 'xhigh' is new in GPT-5.2 for deeper reasoning
 * - Only GPT-5.2 supports reasoning effort (not mini)
 */
function buildAPIRequestBody(messages, maxTokens = 4000) {
    const model = state.settings.model;
    const body = {
        model: model,
        messages: messages,
        max_completion_tokens: maxTokens,
        temperature: 0.7
    };
    
    // Add reasoning.effort for GPT-5.2 (not supported on mini)
    // Format: { reasoning: { effort: "value" } }
    if (model === 'gpt-5.2' && state.settings.effort && state.settings.effort !== 'none') {
        body.reasoning = {
            effort: state.settings.effort
        };
    }
    
    return body;
}

async function callGPT(systemPrompt, userContent, callName = 'API Call') {
    return await callAPIWithRetry(async () => {
        const model = state.settings.model;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ];
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.apiKey}`
            },
            body: JSON.stringify(buildAPIRequestBody(messages, 4000))
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const err = new Error(error.error?.message || `API error: ${response.status}`);
            err.status = response.status;
            throw err;
        }

        const data = await response.json();

        // Track token usage
        if (data.usage) {
            currentMetrics.gptInputTokens += data.usage.prompt_tokens || 0;
            currentMetrics.gptOutputTokens += data.usage.completion_tokens || 0;
            currentMetrics.apiCalls.push({
                name: callName,
                model: model,
                inputTokens: data.usage.prompt_tokens || 0,
                outputTokens: data.usage.completion_tokens || 0
            });
            updateMetricsDisplay();
        }

        return data.choices[0].message.content;
    }, 3, callName);
}

async function callGPTWithMessages(messages, callName = 'Chat Query') {
    return await callAPIWithRetry(async () => {
        const model = state.settings.model;
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.apiKey}`
            },
            body: JSON.stringify(buildAPIRequestBody(messages, 2000))
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const err = new Error(error.error?.message || `API error: ${response.status}`);
            err.status = response.status;
            throw err;
        }

        const data = await response.json();

        // Track token usage
        if (data.usage) {
            currentMetrics.gptInputTokens += data.usage.prompt_tokens || 0;
            currentMetrics.gptOutputTokens += data.usage.completion_tokens || 0;
            currentMetrics.apiCalls.push({
                name: callName,
                model: model,
                inputTokens: data.usage.prompt_tokens || 0,
                outputTokens: data.usage.completion_tokens || 0
            });
            updateMetricsDisplay();
        }

        return data.choices[0].message.content;
    }, 3, callName);
}

// ============================================
// Metrics Display & Management
// ============================================

function calculateMetrics() {
    // Calculate costs based on actual models used in each call
    let inputCost = 0;
    let outputCost = 0;
    
    currentMetrics.apiCalls.forEach(call => {
        const pricing = PRICING[call.model] || PRICING['gpt-5.2'];
        inputCost += (call.inputTokens / 1000000) * pricing.input;
        outputCost += (call.outputTokens / 1000000) * pricing.output;
    });
    
    const totalCost = inputCost + outputCost;

    return {
        gptInputTokens: currentMetrics.gptInputTokens,
        gptOutputTokens: currentMetrics.gptOutputTokens,
        totalTokens: currentMetrics.gptInputTokens + currentMetrics.gptOutputTokens,
        inputCost,
        outputCost,
        totalCost,
        apiCalls: currentMetrics.apiCalls
    };
}

function formatTokens(tokens) {
    return tokens.toLocaleString();
}

function formatCost(cost) {
    return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(4)}`;
}

function updateMetricsDisplay() {
    if (!elements.metricsContent) return;

    const metrics = calculateMetrics();

    // Build API calls breakdown
    let breakdownHtml = '';
    metrics.apiCalls.forEach((call, idx) => {
        const totalTokens = call.inputTokens + call.outputTokens;
        breakdownHtml += `
            <div class="metric-breakdown-item">
                <span>${call.name}</span>
                <span>${formatTokens(totalTokens)} tokens</span>
            </div>`;
    });

    elements.metricsContent.innerHTML = `
        <div class="metrics-grid">
            <div class="metric-item">
                <span class="metric-value">${formatTokens(metrics.totalTokens)}</span>
                <span class="metric-label">Total Tokens</span>
            </div>
            <div class="metric-item">
                <span class="metric-value">${formatCost(metrics.totalCost)}</span>
                <span class="metric-label">Est. Cost</span>
            </div>
        </div>
        <div class="metric-breakdown">
            <div class="metric-breakdown-item">
                <span>GPT-5.2 Input</span>
                <span>${formatTokens(metrics.gptInputTokens)} tokens (${formatCost(metrics.inputCost)})</span>
            </div>
            <div class="metric-breakdown-item">
                <span>GPT-5.2 Output</span>
                <span>${formatTokens(metrics.gptOutputTokens)} tokens (${formatCost(metrics.outputCost)})</span>
            </div>
        </div>
        ${metrics.apiCalls.length > 0 ? `
        <div class="metric-breakdown" style="margin-top: var(--space-sm);">
            <strong style="color: var(--text-secondary);">API Calls (${metrics.apiCalls.length}):</strong>
            ${breakdownHtml}
        </div>` : ''}
    `;

    // Show metrics card if hidden, default content to collapsed
    if (elements.metricsCard && metrics.totalTokens > 0) {
        elements.metricsCard.classList.remove('hidden');

        // Default content to collapsed unless already expanded
        if (!elements.metricsContent.dataset.initialized) {
            elements.metricsContent.classList.add('hidden');
            elements.metricsContent.dataset.initialized = 'true';
        }

        // Auto-collapse after 10 seconds if not pinned
        scheduleAutoCollapse();
    }
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
        apiCalls: []
    };
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
