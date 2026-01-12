/**
 * RLM Context Store
 *
 * Manages agent data as queryable variables instead of raw prompt content.
 * This is the foundation for RLM - context is stored externally and queried
 * programmatically rather than stuffed into prompts.
 *
 * Future RLM expansion: This will interface with a REPL environment where
 * context can be manipulated via generated code.
 */

export class ContextStore {
    constructor() {
        this.agents = new Map();
        this.metadata = {
            totalAgents: 0,
            activeAgents: 0,
            lastUpdated: null
        };
    }

    /**
     * Load agents into the store
     * @param {Array} agents - Array of agent objects from orchestrator state
     */
    loadAgents(agents) {
        this.agents.clear();

        agents.forEach((agent, index) => {
            const id = agent.id || `agent-${index}`;
            this.agents.set(id, {
                ...agent,
                _index: index,
                _searchIndex: this._buildSearchIndex(agent)
            });
        });

        this.metadata.totalAgents = agents.length;
        this.metadata.activeAgents = agents.filter(a => a.enabled).length;
        this.metadata.lastUpdated = new Date();
    }

    /**
     * Build a search index for fast keyword matching
     * @private
     */
    _buildSearchIndex(agent) {
        const text = [
            agent.displayName || agent.title || '',
            agent.summary || '',
            agent.keyPoints || '',
            agent.actionItems || '',
            agent.sentiment || ''
        ].join(' ').toLowerCase();

        return {
            text,
            keywords: this._extractKeywords(text)
        };
    }

    /**
     * Extract significant keywords from text
     * @private
     */
    _extractKeywords(text) {
        const stopWords = new Set([
            'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
            'in', 'with', 'to', 'for', 'of', 'as', 'by', 'from', 'what',
            'where', 'when', 'why', 'how', 'who', 'about', 'can', 'could',
            'should', 'would', 'will', 'are', 'was', 'were', 'been', 'be',
            'have', 'has', 'had', 'do', 'does', 'did', 'this', 'that',
            'these', 'those', 'there', 'here', 'all', 'each', 'every',
            'both', 'few', 'more', 'most', 'other', 'some', 'such', 'than',
            'too', 'very', 'just', 'also', 'now', 'only', 'then', 'so'
        ]);

        return [...new Set(
            text.replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length > 2 && !stopWords.has(word))
        )];
    }

    /**
     * Get all active agents
     * @returns {Array} Active agent objects
     */
    getActiveAgents() {
        return Array.from(this.agents.values()).filter(a => a.enabled);
    }

    /**
     * Get agent by ID
     * @param {string} id - Agent ID
     * @returns {Object|null} Agent object or null
     */
    getAgent(id) {
        return this.agents.get(id) || null;
    }

    /**
     * Query agents by relevance to a search query
     * @param {string} query - User's search query
     * @param {Object} options - Query options
     * @returns {Array} Ranked array of relevant agents
     */
    queryAgents(query, options = {}) {
        const {
            maxResults = 5,
            activeOnly = true,
            minScore = 0
        } = options;

        const queryKeywords = this._extractKeywords(query.toLowerCase());
        const candidates = activeOnly ? this.getActiveAgents() : Array.from(this.agents.values());

        const scored = candidates.map(agent => {
            const score = this._calculateRelevanceScore(agent, queryKeywords, query.toLowerCase());
            return { agent, score };
        });

        return scored
            .filter(s => s.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
            .map(s => ({ ...s.agent, _relevanceScore: s.score }));
    }

    /**
     * Calculate relevance score for an agent
     * @private
     */
    _calculateRelevanceScore(agent, queryKeywords, queryText) {
        let score = 0;
        const searchIndex = agent._searchIndex;

        // Keyword matching with field weights
        queryKeywords.forEach(keyword => {
            // Title/name match (highest weight)
            if ((agent.displayName || agent.title || '').toLowerCase().includes(keyword)) {
                score += 10;
            }
            // Summary match
            if ((agent.summary || '').toLowerCase().includes(keyword)) {
                score += 5;
            }
            // Key points match
            if ((agent.keyPoints || '').toLowerCase().includes(keyword)) {
                score += 3;
            }
            // Action items match
            if ((agent.actionItems || '').toLowerCase().includes(keyword)) {
                score += 3;
            }
            // General text match
            if (searchIndex.text.includes(keyword)) {
                score += 1;
            }
        });

        // Recency boost (agents from recent dates score higher)
        if (agent.date) {
            try {
                const agentDate = new Date(agent.date);
                if (!isNaN(agentDate.getTime())) {
                    const daysSince = (Date.now() - agentDate.getTime()) / (1000 * 60 * 60 * 24);
                    score += Math.max(0, 5 - (daysSince / 14)); // Decay over 2 weeks
                }
            } catch (e) {
                // Invalid date, skip boost
            }
        }

        return score;
    }

    /**
     * Get context slice for an agent (different detail levels)
     * @param {string} agentId - Agent ID
     * @param {string} level - Detail level: 'summary', 'standard', 'full'
     * @returns {string} Formatted context string
     */
    getContextSlice(agentId, level = 'standard') {
        const agent = this.agents.get(agentId);
        if (!agent) return '';

        const header = `Meeting: ${agent.displayName || agent.title} (${agent.date || 'No date'})`;

        switch (level) {
            case 'summary':
                return `${header}\nSummary: ${agent.summary || 'N/A'}`;

            case 'standard':
                return `${header}
Summary: ${agent.summary || 'N/A'}
Key Points: ${agent.keyPoints || 'N/A'}
Action Items: ${agent.actionItems || 'N/A'}`;

            case 'full':
                return `${header}
Summary: ${agent.summary || 'N/A'}
Key Points: ${agent.keyPoints || 'N/A'}
Action Items: ${agent.actionItems || 'N/A'}
Sentiment: ${agent.sentiment || 'N/A'}
${agent.transcript ? `Transcript: ${agent.transcript}` : ''}`;

            default:
                return this.getContextSlice(agentId, 'standard');
        }
    }

    /**
     * Get combined context for multiple agents
     * @param {Array} agentIds - Array of agent IDs
     * @param {string} level - Detail level
     * @returns {string} Combined context string
     */
    getCombinedContext(agentIds, level = 'standard') {
        return agentIds
            .map(id => this.getContextSlice(id, level))
            .filter(ctx => ctx.length > 0)
            .join('\n\n---\n\n');
    }

    /**
     * Get store statistics
     * @returns {Object} Store metadata and stats
     */
    getStats() {
        return {
            ...this.metadata,
            agentIds: Array.from(this.agents.keys())
        };
    }

    /**
     * Future RLM hook: Execute a query in REPL context
     * This is a placeholder for full RLM implementation
     * @param {string} code - Code to execute against context
     * @returns {Promise<any>} Execution result
     */
    async executeInContext(code) {
        // Placeholder for future REPL integration
        // In full RLM, this would execute generated Python/JS code
        // against the context store
        console.warn('executeInContext: REPL execution not yet implemented');
        return {
            success: false,
            error: 'REPL execution not implemented in RLM-Lite',
            _futureFeature: true
        };
    }
}

// Singleton instance for global access
let storeInstance = null;

export function getContextStore() {
    if (!storeInstance) {
        storeInstance = new ContextStore();
    }
    return storeInstance;
}

export function resetContextStore() {
    storeInstance = new ContextStore();
    return storeInstance;
}
