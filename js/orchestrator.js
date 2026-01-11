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

// ============================================
// DOM Elements
// ============================================

let elements = {};

function initElements() {
    elements = {
        // API Key
        apiKeyInput: document.getElementById('api-key'),
        toggleKeyBtn: document.getElementById('toggle-key'),
        saveKeyBtn: document.getElementById('save-key'),
        
        // Agent Upload
        agentFilesInput: document.getElementById('agent-files'),
        agentsDropZone: document.getElementById('agents-drop-zone'),
        agentsListSection: document.getElementById('agents-list-section'),
        agentsList: document.getElementById('agents-list'),
        agentsCount: document.getElementById('agents-count'),
        clearAllBtn: document.getElementById('clear-all-agents'),
        generateInsightsBtn: document.getElementById('generate-insights-btn'),
        
        // Insights
        insightsSection: document.getElementById('insights-section'),
        insightThemes: document.getElementById('insight-themes'),
        insightTrends: document.getElementById('insight-trends'),
        insightRisks: document.getElementById('insight-risks'),
        insightRecommendations: document.getElementById('insight-recommendations'),
        insightActions: document.getElementById('insight-actions'),
        
        // Chat
        chatSection: document.getElementById('chat-section'),
        chatMessages: document.getElementById('chat-messages'),
        chatInput: document.getElementById('chat-input'),
        chatSendBtn: document.getElementById('chat-send-btn'),
        
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
    }
}

function saveApiKey() {
    const key = elements.apiKeyInput.value.trim();
    if (key) {
        state.apiKey = key;
        localStorage.setItem('northstar.LM_api_key', key);
        showTemporaryMessage(elements.saveKeyBtn, 'Saved!', 'Save');
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
    
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.md'));
    if (files.length > 0) {
        processAgentFiles(files);
    }
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files).filter(f => f.name.endsWith('.md'));
    if (files.length > 0) {
        processAgentFiles(files);
    }
    e.target.value = ''; // Reset for re-upload
}

async function processAgentFiles(files) {
    for (const file of files) {
        try {
            const content = await readFileContent(file);
            const agentData = parseAgentFile(content);
            
            if (agentData) {
                // Check for duplicates by title
                const existingIndex = state.agents.findIndex(a => a.title === agentData.title);
                if (existingIndex >= 0) {
                    state.agents[existingIndex] = agentData; // Update existing
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
        
        const titleMatch = frontmatter.match(/title:\s*"?([^"\n]+)"?/);
        if (titleMatch) result.title = titleMatch[1].trim();
        
        const dateMatch = frontmatter.match(/date:\s*"?([^"\n]+)"?/);
        if (dateMatch) result.date = dateMatch[1].trim();
        
        const sourceMatch = frontmatter.match(/source_type:\s*(\w+)/);
        if (sourceMatch) result.sourceType = sourceMatch[1].trim();
    }
    
    // Parse sections
    const sectionPatterns = {
        summary: /## Summary\n([\s\S]*?)(?=\n## |$)/,
        keyPoints: /## Key Points\n([\s\S]*?)(?=\n## |$)/,
        actionItems: /## Action Items\n([\s\S]*?)(?=\n## |$)/,
        sentiment: /## Sentiment\n([\s\S]*?)(?=\n## |$)/,
        transcript: /## Transcript\n([\s\S]*?)(?=\n## |$)/
    };
    
    for (const [key, pattern] of Object.entries(sectionPatterns)) {
        const match = content.match(pattern);
        if (match) {
            result[key] = match[1].trim();
        }
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
    elements.agentsCount.textContent = state.agents.length;
    
    if (state.agents.length === 0) {
        elements.agentsListSection.classList.add('hidden');
        return;
    }
    
    elements.agentsListSection.classList.remove('hidden');
    
    elements.agentsList.innerHTML = state.agents.map((agent, index) => `
        <div class="agent-card">
            <div class="agent-info">
                <span class="agent-icon">📋</span>
                <div class="agent-details">
                    <strong class="agent-title">${escapeHtml(agent.title)}</strong>
                    <span class="agent-meta">${agent.date || 'No date'} • ${agent.sourceType}</span>
                </div>
            </div>
            <button class="remove-agent-btn" data-index="${index}" title="Remove agent">
                ✕
            </button>
        </div>
    `).join('');
    
    // Add remove handlers
    elements.agentsList.querySelectorAll('.remove-agent-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            removeAgent(parseInt(btn.dataset.index));
        });
    });
}

function updateButtonStates() {
    const hasAgents = state.agents.length >= 2;
    const hasApiKey = state.apiKey.trim().length > 0;
    
    elements.generateInsightsBtn.disabled = !hasAgents || !hasApiKey || state.isProcessing;
    
    if (state.agents.length === 1) {
        elements.generateInsightsBtn.title = 'Upload at least 2 agents for cross-meeting insights';
    } else if (!hasApiKey) {
        elements.generateInsightsBtn.title = 'Enter your API key first';
    } else {
        elements.generateInsightsBtn.title = '';
    }
}

function updateSectionsVisibility() {
    // Show insights if available
    if (state.insights) {
        elements.insightsSection.classList.remove('hidden');
        elements.chatSection.classList.remove('hidden');
    } else {
        elements.insightsSection.classList.add('hidden');
        elements.chatSection.classList.add('hidden');
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
    if (state.agents.length < 2 || !state.apiKey) {
        showError('Please upload at least 2 agent files and enter your API key.');
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

        const response = await callGPT(systemPrompt, combinedContext);
        
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
    return state.agents.map((agent, index) => `
=== MEETING ${index + 1}: ${agent.title} ===
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
    
    // Clear input
    elements.chatInput.value = '';
    
    // Add user message to UI
    appendChatMessage('user', message);
    
    // Show typing indicator
    showTypingIndicator();
    
    try {
        const response = await chatWithAgents(message);
        removeTypingIndicator();
        appendChatMessage('assistant', response);
    } catch (error) {
        removeTypingIndicator();
        appendChatMessage('assistant', `Sorry, I encountered an error: ${error.message}`);
    }
}

async function chatWithAgents(userMessage) {
    const context = buildChatContext();
    
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
    
    const response = await callGPTWithMessages(messages);
    
    // Store in history
    state.chatHistory.push({ role: 'user', content: userMessage });
    state.chatHistory.push({ role: 'assistant', content: response });
    
    return response;
}

function buildChatContext() {
    return state.agents.map((agent, index) => `
--- Meeting ${index + 1}: ${agent.title} (${agent.date || 'No date'}) ---
Summary: ${agent.summary}
Key Points: ${agent.keyPoints}
Action Items: ${agent.actionItems}
Sentiment: ${agent.sentiment}
${agent.transcript ? `Transcript excerpt: ${agent.transcript.substring(0, 2000)}...` : ''}
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

function showTypingIndicator() {
    const indicator = document.createElement('div');
    indicator.className = 'chat-message assistant-message typing-indicator';
    indicator.id = 'typing-indicator';
    indicator.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    elements.chatMessages.appendChild(indicator);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
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
// API Calls
// ============================================

async function callGPT(systemPrompt, userContent) {
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
        throw new Error(error.error?.message || `API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
}

async function callGPTWithMessages(messages) {
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
        throw new Error(error.error?.message || `API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
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
