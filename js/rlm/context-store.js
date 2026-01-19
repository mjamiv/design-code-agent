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
        const requirementsText = (agent.requirements || [])
            .map(req => `${req.id || ''} ${req.text || ''}`)
            .join(' ');
        const parametersText = (agent.designParameters || [])
            .map(param => `${param.name || ''} ${param.value || ''}`)
            .join(' ');
        const crossRefsText = (agent.crossReferences || [])
            .map(ref => `${ref.source || ''} ${ref.target || ''}`)
            .join(' ');
        const complianceText = (agent.complianceNotes || []).join(' ');

        const text = [
            agent.displayName || agent.title || '',
            agent.codeOverview || '',
            requirementsText,
            parametersText,
            crossRefsText,
            complianceText,
            agent.sourceText || '',
            agent.extendedContext || ''
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

        queryKeywords.forEach(keyword => {
            if ((agent.displayName || agent.title || '').toLowerCase().includes(keyword)) score += 15;
            if ((agent.codeOverview || '').toLowerCase().includes(keyword)) score += 6;

            const reqText = (agent.requirements || []).map(r => `${r.text || ''} ${r.id || ''}`).join(' ');
            if (reqText.toLowerCase().includes(keyword)) score += 8;

            const paramText = (agent.designParameters || []).map(p => `${p.name || ''} ${p.value || ''}`).join(' ');
            if (paramText.toLowerCase().includes(keyword)) score += 7;

            const xrefText = (agent.crossReferences || []).map(x => x.target || '').join(' ');
            if (xrefText.toLowerCase().includes(keyword)) score += 4;

            if ((agent.sourceText || '').toLowerCase().includes(keyword)) score += 2;
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

        const header = `Code: ${agent.displayName || agent.title} (${agent.date || 'No date'})`;

        switch (level) {
            case 'summary':
                return `${header}\nCode Overview: ${agent.codeOverview || 'N/A'}`;

            case 'standard':
                return `${header}
Code Overview: ${agent.codeOverview || 'N/A'}
Requirements: ${JSON.stringify(agent.requirements || [], null, 2)}
Design Parameters: ${JSON.stringify(agent.designParameters || [], null, 2)}
Cross References: ${JSON.stringify(agent.crossReferences || [], null, 2)}
Compliance Notes: ${(agent.complianceNotes || []).join(' | ') || 'N/A'}`;

            case 'full':
                return `${header}
Code Overview: ${agent.codeOverview || 'N/A'}
Requirements: ${JSON.stringify(agent.requirements || [], null, 2)}
Design Parameters: ${JSON.stringify(agent.designParameters || [], null, 2)}
Cross References: ${JSON.stringify(agent.crossReferences || [], null, 2)}
Compliance Notes: ${(agent.complianceNotes || []).join(' | ') || 'N/A'}
${agent.sourceText ? `Source Text: ${agent.sourceText}` : ''}${agent.extendedContext ? `\nExtended Context:\n${agent.extendedContext}` : ''}`;

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
     * Get combined context with a token budget by falling back to smaller slices.
     * @param {Array} agentIds - Array of agent IDs
     * @param {number} tokenBudget - Maximum tokens to use
     * @param {Object} options - Options
     * @returns {Object} Context bundle with budget stats
     */
    getCombinedContextWithBudget(agentIds, tokenBudget, options = {}) {
        const {
            preferredLevel = 'standard',
            separator = '\n\n---\n\n',
            minRemainingTokens = 0
        } = options;

        const ids = agentIds?.length
            ? agentIds
            : this.getActiveAgents().map(agent => agent.id);

        if (!ids.length || !tokenBudget || tokenBudget <= 0) {
            return {
                context: '',
                tokenEstimate: 0,
                levelsUsed: [],
                skippedAgents: ids || [],
                remainingBudget: Math.max(0, tokenBudget || 0)
            };
        }

        const levelFallbacks = {
            full: ['full', 'standard', 'summary'],
            standard: ['standard', 'summary'],
            summary: ['summary']
        };
        const levelOrder = levelFallbacks[preferredLevel] || levelFallbacks.standard;

        const sections = [];
        const levelsUsed = [];
        const skippedAgents = [];
        let remainingBudget = tokenBudget;
        let tokenEstimate = 0;

        ids.forEach(agentId => {
            let accepted = false;
            for (const level of levelOrder) {
                const slice = this.getContextSlice(agentId, level);
                const sliceTokens = this.estimateTokens(slice);
                if (sliceTokens <= remainingBudget) {
                    sections.push(slice);
                    levelsUsed.push({ agentId, level, tokens: sliceTokens });
                    remainingBudget -= sliceTokens;
                    tokenEstimate += sliceTokens;
                    accepted = true;
                    break;
                }
            }
            if (!accepted) {
                skippedAgents.push(agentId);
            }
        });

        if (remainingBudget <= minRemainingTokens) {
            remainingBudget = Math.max(0, remainingBudget);
        }

        return {
            context: sections.filter(Boolean).join(separator),
            tokenEstimate,
            levelsUsed,
            skippedAgents,
            remainingBudget
        };
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

    // ==========================================
    // Phase 3.3: Token Optimization Methods
    // ==========================================

    /**
     * Get compact context for token-efficient initial queries
     * Returns summary-only format to reduce token usage
     * 
     * @param {Object} options - Options for compact context
     * @returns {Object} Compact context object
     */
    getCompactContext(options = {}) {
        const {
            activeOnly = true,
            maxSummaryLength = 500,
            includeSentiment = false,
            includeComplianceNotes = undefined
        } = options;

        const shouldIncludeCompliance = includeComplianceNotes ?? includeSentiment ?? false;
        const agents = activeOnly ? this.getActiveAgents() : Array.from(this.agents.values());

        return {
            agents: agents.map(agent => ({
                id: agent.id,
                name: agent.displayName || agent.title || 'Untitled',
                date: agent.date || null,
                codeOverview: this._truncateText(agent.codeOverview || '', maxSummaryLength),
                requirementsCount: (agent.requirements || []).length,
                parametersCount: (agent.designParameters || []).length,
                crossRefsCount: (agent.crossReferences || []).length,
                complianceNotes: shouldIncludeCompliance ? (agent.complianceNotes || []) : undefined,
                hasSourceText: !!agent.sourceText && agent.sourceText.length > 100
            })),
            stats: {
                total: agents.length,
                withSourceText: agents.filter(a => a.sourceText && a.sourceText.length > 100).length
            }
        };
    }

    /**
     * Get relevance-filtered compact context based on query
     * Only includes agents that match the query, reducing token usage
     * 
     * @param {string} query - User query for relevance filtering
     * @param {Object} options - Options for filtered context
     * @returns {Object} Filtered compact context
     */
    getRelevantCompactContext(query, options = {}) {
        const {
            maxAgents = 3,
            minScore = 2,
            maxSummaryLength = 800
        } = options;

        // Get relevance-scored agents
        const relevantAgents = this.queryAgents(query, {
            maxResults: maxAgents,
            activeOnly: true,
            minScore
        });

        return {
            agents: relevantAgents.map(agent => ({
                id: agent.id,
                name: agent.displayName || agent.title || 'Untitled',
                date: agent.date || null,
                relevanceScore: agent._relevanceScore,
                codeOverview: this._truncateText(agent.codeOverview || '', maxSummaryLength),
                requirements: this._truncateText(
                    (agent.requirements || []).map(req => `${req.id || ''} ${req.text || ''}`.trim()).join('\n'),
                    900
                ),
                designParameters: this._truncateText(
                    (agent.designParameters || []).map(param => `${param.name || ''} ${param.value || ''}`.trim()).join('\n'),
                    700
                ),
                crossReferences: this._truncateText(
                    (agent.crossReferences || []).map(ref => `${ref.source || ''} ${ref.target || ''}`.trim()).join('\n'),
                    500
                ),
                complianceNotes: this._truncateText((agent.complianceNotes || []).join('\n'), 400)
            })),
            stats: {
                returned: relevantAgents.length,
                totalActive: this.metadata.activeAgents,
                query: query.substring(0, 50)
            }
        };
    }

    /**
     * Get token-optimized REPL context
     * Limits source text size and removes empty fields
     * 
     * @param {Object} options - Options for optimized context
     * @returns {Object} Token-optimized context for REPL
     */
    getOptimizedREPLContext(options = {}) {
        const {
            maxTranscriptLength = 3000,  // Backward-compatible option name
            maxSourceTextLength = undefined,
            includeEmptyFields = false,
            activeOnly = true
        } = options;

        const sourceTextLimit = maxSourceTextLength ?? maxTranscriptLength;
        const agents = activeOnly ? this.getActiveAgents() : Array.from(this.agents.values());

        return {
            agents: agents.map(agent => {
                const optimized = {
                    id: agent.id,
                    displayName: agent.displayName || agent.title || 'Untitled',
                    date: agent.date || null
                };

                // Only include non-empty fields
                if (agent.codeOverview || includeEmptyFields) {
                    optimized.codeOverview = agent.codeOverview || '';
                }
                if ((agent.requirements && agent.requirements.length) || includeEmptyFields) {
                    optimized.requirements = agent.requirements || [];
                }
                if ((agent.designParameters && agent.designParameters.length) || includeEmptyFields) {
                    optimized.designParameters = agent.designParameters || [];
                }
                if ((agent.crossReferences && agent.crossReferences.length) || includeEmptyFields) {
                    optimized.crossReferences = agent.crossReferences || [];
                }
                if ((agent.complianceNotes && agent.complianceNotes.length) || includeEmptyFields) {
                    optimized.complianceNotes = agent.complianceNotes || [];
                }

                // Truncated source text
                if (agent.sourceText && agent.sourceText.length > 0) {
                    optimized.sourceText = agent.sourceText.length > sourceTextLimit
                        ? agent.sourceText.substring(0, sourceTextLimit) + '...[truncated]'
                        : agent.sourceText;
                    optimized.sourceTextTruncated = agent.sourceText.length > sourceTextLimit;
                    optimized.originalSourceTextLength = agent.sourceText.length;
                }

                if (agent.extendedContext || includeEmptyFields) {
                    optimized.extendedContext = agent.extendedContext || '';
                }
                if (agent.payload) {
                    optimized.payload = agent.payload;
                }

                return optimized;
            }),
            metadata: {
                totalAgents: this.metadata.totalAgents,
                activeAgents: this.metadata.activeAgents,
                optimizedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Truncate text to a maximum length, respecting word boundaries
     * @private
     */
    _truncateText(text, maxLength) {
        if (!text || text.length <= maxLength) {
            return text;
        }

        // Find a good breaking point (sentence or word boundary)
        let truncated = text.substring(0, maxLength);
        const lastSentence = truncated.lastIndexOf('. ');
        const lastSpace = truncated.lastIndexOf(' ');

        if (lastSentence > maxLength * 0.7) {
            truncated = truncated.substring(0, lastSentence + 1);
        } else if (lastSpace > maxLength * 0.8) {
            truncated = truncated.substring(0, lastSpace);
        }

        return truncated + '...';
    }

    /**
     * Count bullet points in text (for metadata)
     * @private
     */
    _countBulletPoints(text) {
        if (!text) return 0;
        // Count lines starting with -, *, •, or numbered patterns like "1."
        const bulletPattern = /^[\s]*[-*•]|\d+\./gm;
        const matches = text.match(bulletPattern);
        return matches ? matches.length : 0;
    }

    /**
     * Estimate token count for context (rough approximation)
     * Useful for deciding which context method to use
     * @param {string} text - Text to estimate
     * @returns {number} Estimated token count
     */
    estimateTokens(text) {
        if (!text) return 0;
        // Rough estimate: ~4 characters per token for English text
        return Math.ceil(text.length / 4);
    }

    /**
     * Get context with automatic token budget management
     * Chooses the appropriate detail level based on token budget
     * 
     * @param {number} tokenBudget - Maximum tokens to use
     * @param {Object} options - Options
     * @returns {Object} Context optimized for token budget
     */
    getContextWithBudget(tokenBudget = 4000, options = {}) {
        const { query = '', prioritizeRecent = true } = options;
        
        const agents = this.getActiveAgents();
        if (agents.length === 0) {
            return { agents: [], tokenEstimate: 0 };
        }

        // Sort by relevance or recency
        let sortedAgents = query 
            ? this.queryAgents(query, { activeOnly: true, maxResults: agents.length })
            : agents;

        if (prioritizeRecent && !query) {
            sortedAgents = [...sortedAgents].sort((a, b) => {
                const dateA = a.date ? new Date(a.date) : new Date(0);
                const dateB = b.date ? new Date(b.date) : new Date(0);
                return dateB - dateA;
            });
        }

        const result = { agents: [], tokenEstimate: 0 };
        let remainingBudget = tokenBudget;

        for (const agent of sortedAgents) {
            // Try full context first
            const fullContext = this.getContextSlice(agent.id, 'full');
            const fullTokens = this.estimateTokens(fullContext);

            if (fullTokens <= remainingBudget) {
                result.agents.push({ ...agent, _contextLevel: 'full', _tokens: fullTokens });
                remainingBudget -= fullTokens;
                result.tokenEstimate += fullTokens;
                continue;
            }

            // Try standard context
            const standardContext = this.getContextSlice(agent.id, 'standard');
            const standardTokens = this.estimateTokens(standardContext);

            if (standardTokens <= remainingBudget) {
                result.agents.push({ ...agent, _contextLevel: 'standard', _tokens: standardTokens });
                remainingBudget -= standardTokens;
                result.tokenEstimate += standardTokens;
                continue;
            }

            // Try summary only
            const summaryContext = this.getContextSlice(agent.id, 'summary');
            const summaryTokens = this.estimateTokens(summaryContext);

            if (summaryTokens <= remainingBudget) {
                result.agents.push({ ...agent, _contextLevel: 'summary', _tokens: summaryTokens });
                remainingBudget -= summaryTokens;
                result.tokenEstimate += summaryTokens;
            }

            // If we can't fit even the summary, stop
            if (remainingBudget < 100) break;
        }

        return result;
    }

    /**
     * Export context in Python-friendly dictionary format
     * Used by the REPL environment to set up the Python context variable
     * @param {Object} options - Export options
     * @returns {Object} Python-compatible context object
     */
    toPythonDict(options = {}) {
        const {
            activeOnly = true,
            includeTranscript = true,
            includeSourceText = undefined,
            maxTranscriptLength = 10000,
            maxSourceTextLength = undefined
        } = options;

        const allowSourceText = includeSourceText ?? includeTranscript ?? true;
        const sourceTextLimit = maxSourceTextLength ?? maxTranscriptLength;
        const agents = activeOnly ? this.getActiveAgents() : Array.from(this.agents.values());

        return {
            agents: agents.map(agent => {
                const pythonAgent = {
                    id: agent.id,
                    displayName: agent.displayName || agent.title || 'Untitled',
                    title: agent.title || '',
                    date: agent.date || null,
                    sourceType: agent.sourceType || 'unknown',
                    enabled: agent.enabled !== false,
                    codeOverview: agent.codeOverview || '',
                    requirements: agent.requirements || [],
                    designParameters: agent.designParameters || [],
                    crossReferences: agent.crossReferences || [],
                    complianceNotes: agent.complianceNotes || []
                };

                // Include source text with optional truncation
                if (allowSourceText && agent.sourceText) {
                    pythonAgent.sourceText = agent.sourceText.length > sourceTextLimit
                        ? agent.sourceText.substring(0, sourceTextLimit) + '...[truncated]'
                        : agent.sourceText;
                } else {
                    pythonAgent.sourceText = '';
                }

                if (agent.extendedContext) {
                    pythonAgent.extendedContext = agent.extendedContext;
                }
                if (agent.payload) {
                    pythonAgent.payload = agent.payload;
                }

                return pythonAgent;
            }),
            metadata: {
                totalAgents: this.metadata.totalAgents,
                activeAgents: this.metadata.activeAgents,
                exportedAt: new Date().toISOString(),
                agentNames: agents.map(a => a.displayName || a.title || 'Untitled')
            }
        };
    }

    /**
     * Get agent names for REPL context summary
     * @returns {Array} Array of agent display names
     */
    getAgentNames() {
        return this.getActiveAgents().map(a => a.displayName || a.title || 'Untitled');
    }

    /**
     * Execute a query in REPL context
     * Now integrated with the REPL environment
     * @param {string} code - Code to execute against context
     * @param {Object} replEnvironment - REPL environment instance
     * @returns {Promise<Object>} Execution result
     */
    async executeInContext(code, replEnvironment = null) {
        if (!replEnvironment) {
            console.warn('executeInContext: No REPL environment provided');
            return {
                success: false,
                error: 'No REPL environment provided',
                _futureFeature: false
            };
        }

        try {
            // Ensure context is set in REPL
            const contextData = this.toPythonDict();
            await replEnvironment.setContext(contextData.agents);

            // Execute the code
            const result = await replEnvironment.execute(code);

            return {
                success: result.success,
                result: result.result,
                stdout: result.stdout,
                stderr: result.stderr,
                error: result.error,
                finalAnswer: result.finalAnswer,
                subLmCalls: result.subLmCalls
            };

        } catch (error) {
            return {
                success: false,
                error: error.message || String(error)
            };
        }
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
