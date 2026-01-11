/**
 * northstar.LM - Agent Orchestrator
 * Combines multiple meeting agents for cross-meeting insights
 */

// ============================================
// State Management
// ============================================

const state = {
    apiKey: '',
    agents: [],  // In-memory storage (session-only)
    insights: null,
    chatHistory: [],
    isProcessing: false
};

// Model pricing (per 1M tokens)
const PRICING = {
    'gpt-5.2': { input: 2.50, output: 10.00 }
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
        dismissErrorBtn: document.getElementById('dismiss-error')
    };
}

// ============================================
// Initialization
// ============================================

function init() {
    initElements();
    loadApiKey();
    setupEventListeners();
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
    updateUI();
}

// ============================================
// UI Updates
// ============================================

function updateUI() {
    updateAgentsList();
    updateButtonStates();
    updateSectionsVisibility();
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
                    ${agent.enabled ? '✓ On' : '○ Off'}
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
    
    if (activeCount === 0) {
        brainStatusEl.textContent = 'Waiting for agents...';
        brainStatusEl.classList.remove('ready');
    } else if (activeCount === 1) {
        brainStatusEl.textContent = 'Ready with 1 agent';
        brainStatusEl.classList.add('ready');
    } else {
        brainStatusEl.textContent = `Ready with ${activeCount} agents`;
        brainStatusEl.classList.add('ready');
    }
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
    const activeAgents = state.agents.filter(a => a.enabled);
    if (activeAgents.length < 2 || !state.apiKey) {
        showError('Please enable at least 2 agents and enter your API key.');
        return;
    }
    
    state.isProcessing = true;
    showButtonLoader(elements.generateInsightsBtn);
    updateButtonStates();
    
    try {
        const combinedContext = buildCombinedContext();
        
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

        const response = await callGPT(systemPrompt, combinedContext, 'Cross-Meeting Insights');
        
        // Parse JSON response
        let insights;
        try {
            // Try to extract JSON from response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                insights = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON found in response');
            }
        } catch (parseError) {
            // Fallback: treat response as plain text
            insights = {
                themes: [response],
                trends: [],
                risks: [],
                recommendations: [],
                actions: []
            };
        }
        
        state.insights = insights;
        displayInsights(insights);
        resetChatHistory();
        updateUI();
        
    } catch (error) {
        console.error('Insights generation error:', error);
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
    elements.insightThemes.innerHTML = formatInsightList(insights.themes);
    elements.insightTrends.innerHTML = formatInsightList(insights.trends);
    elements.insightRisks.innerHTML = formatInsightList(insights.risks);
    elements.insightRecommendations.innerHTML = formatInsightList(insights.recommendations);
    elements.insightActions.innerHTML = formatInsightList(insights.actions);
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
    
    // Clear input and disable while processing
    elements.chatInput.value = '';
    elements.chatInput.disabled = true;
    elements.chatSendBtn.disabled = true;
    
    // Add user message to UI
    appendChatMessage('user', message);
    
    // Show thinking indicator with train of thought
    const thinkingId = showThinkingIndicator();
    
    try {
        // Step 1: Understanding
        updateThinkingStatus(thinkingId, 'Understanding your question...');
        await sleep(300);
        
        // Step 2: Selecting relevant agents
        updateThinkingStatus(thinkingId, `Searching ${state.agents.length} meetings...`);
        const context = buildChatContext(message);
        await sleep(200);
        
        // Step 3: Analyzing
        updateThinkingStatus(thinkingId, 'Analyzing with AI...');
        const response = await chatWithAgents(message);
        
        // Step 4: Preparing response
        updateThinkingStatus(thinkingId, 'Preparing response...');
        await sleep(150);
        
        removeThinkingIndicator(thinkingId);
        appendChatMessage('assistant', response);
    } catch (error) {
        removeThinkingIndicator(thinkingId);
        appendChatMessage('assistant', `Sorry, I encountered an error: ${error.message}`);
    } finally {
        elements.chatInput.disabled = false;
        elements.chatSendBtn.disabled = false;
        elements.chatInput.focus();
    }
}

async function chatWithAgents(userMessage) {
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

function appendChatMessage(role, content) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}-message`;
    
    if (role === 'assistant' && typeof marked !== 'undefined') {
        messageDiv.innerHTML = marked.parse(content);
    } else {
        messageDiv.textContent = content;
    }
    
    elements.chatMessages.appendChild(messageDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function showThinkingIndicator() {
    const id = 'thinking-' + Date.now();
    const thinkingDiv = document.createElement('div');
    thinkingDiv.id = id;
    thinkingDiv.className = 'chat-message assistant-message';
    thinkingDiv.innerHTML = `
        <div class="chat-message-avatar">🤖</div>
        <div class="chat-thinking">
            <div class="thinking-spinner"></div>
            <span class="thinking-text">Thinking...</span>
        </div>
    `;
    elements.chatMessages.appendChild(thinkingDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    return id;
}

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

async function callGPT(systemPrompt, userContent, callName = 'API Call') {
    return await callAPIWithRetry(async () => {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5.2',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                max_completion_tokens: 4000,
                temperature: 0.7
            })
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
                model: 'gpt-5.2',
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
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5.2',
                messages: messages,
                max_completion_tokens: 2000,
                temperature: 0.7
            })
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
                model: 'gpt-5.2',
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
    const inputCost = (currentMetrics.gptInputTokens / 1000000) * PRICING['gpt-5.2'].input;
    const outputCost = (currentMetrics.gptOutputTokens / 1000000) * PRICING['gpt-5.2'].output;
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
