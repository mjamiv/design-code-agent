/**
 * RLM Query Decomposer
 *
 * Analyzes user queries and decomposes them into targeted sub-queries.
 * Each sub-query is designed to be answered by a specific agent or subset.
 *
 * Future RLM expansion: This will generate executable code that the REPL
 * can run to programmatically query the context store.
 */

import { getContextStore } from './context-store.js';

/**
 * Query complexity classification
 */
export const QueryComplexity = {
    SIMPLE: 'simple',           // Single agent, direct answer
    COMPARATIVE: 'comparative', // 2-3 agents, compare/contrast
    AGGREGATE: 'aggregate',     // All agents, synthesize patterns
    EXPLORATORY: 'exploratory'  // Unknown scope, needs discovery
};

/**
 * Query intent classification
 */
export const QueryIntent = {
    FACTUAL: 'factual',           // "What was decided about X?"
    COMPARATIVE: 'comparative',   // "How does X differ from Y?"
    AGGREGATIVE: 'aggregative',   // "What are all the action items?"
    ANALYTICAL: 'analytical',     // "What patterns emerge across meetings?"
    TEMPORAL: 'temporal'          // "How has X evolved over time?"
};

export class QueryDecomposer {
    constructor(options = {}) {
        this.options = {
            maxSubQueries: options.maxSubQueries || 5,
            summaryMaxSubQueries: options.summaryMaxSubQueries || 4,
            minRelevanceScore: options.minRelevanceScore || 2,
            enableLLMDecomposition: options.enableLLMDecomposition !== false,
            ...options
        };
    }

    /**
     * Analyze and decompose a user query
     * @param {string} query - User's natural language query
     * @param {Object} context - Additional context (apiKey, etc.)
     * @returns {Promise<Object>} Decomposition result
     */
    async decompose(query, context = {}) {
        const store = getContextStore();
        const stats = store.getStats();

        // Classify the query
        const classification = this._classifyQuery(query);

        // Get relevant agents - dynamic limit based on active agent count
        const maxResults = this._resolveMaxResults(classification, stats.activeAgents);
        const relevantAgents = store.queryAgents(query, {
            maxResults,
            minScore: this.options.minRelevanceScore
        });

        // Determine decomposition strategy
        const strategy = this._determineStrategy(classification, relevantAgents, stats);

        // Generate sub-queries based on strategy
        const subQueries = await this._generateSubQueries(
            query,
            classification,
            strategy,
            relevantAgents,
            context
        );

        return {
            originalQuery: query,
            classification,
            strategy,
            relevantAgents,
            subQueries,
            metadata: {
                totalAgents: stats.totalAgents,
                activeAgents: stats.activeAgents,
                selectedAgents: relevantAgents.length,
                decomposedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Classify query complexity and intent
     * @private
     */
    _classifyQuery(query) {
        const lowerQuery = query.toLowerCase();
        const summaryRequest = /\b(summary|summarize|overview|highlights?)\b/i.test(query);
        const summaryFullScope = summaryRequest && /\b(all|across|overall|entire|conversation|meetings?)\b/i.test(query);

        // Detect intent
        let intent = QueryIntent.FACTUAL;

        if (/compare|differ|versus|vs\.?|between/i.test(query)) {
            intent = QueryIntent.COMPARATIVE;
        } else if (/all|every|total|combined|across|overall/i.test(query)) {
            intent = QueryIntent.AGGREGATIVE;
        } else if (/pattern|trend|theme|common|recurring|emerge/i.test(query)) {
            intent = QueryIntent.ANALYTICAL;
        } else if (/over time|evolution|change|progress|history/i.test(query)) {
            intent = QueryIntent.TEMPORAL;
        }
        if (summaryRequest && intent === QueryIntent.FACTUAL) {
            intent = QueryIntent.AGGREGATIVE;
        }

        // Detect complexity
        let complexity = QueryComplexity.SIMPLE;

        if (intent === QueryIntent.COMPARATIVE) {
            complexity = QueryComplexity.COMPARATIVE;
        } else if (intent === QueryIntent.AGGREGATIVE || intent === QueryIntent.ANALYTICAL) {
            complexity = QueryComplexity.AGGREGATE;
        } else if (/\?.*\?|and also|additionally|furthermore/i.test(query)) {
            complexity = QueryComplexity.EXPLORATORY;
        }
        if (summaryRequest && complexity === QueryComplexity.SIMPLE) {
            complexity = QueryComplexity.AGGREGATE;
        }

        // Detect if query targets specific meetings
        const mentionsMeeting = /meeting|session|call|discussion|sync/i.test(query);
        const mentionsTimeframe = /last|recent|this week|yesterday|today/i.test(query);
        const formatConstraints = this._detectFormatConstraints(query);
        const dataPreference = this._inferDataPreference(query);
        const intentTags = this._inferIntentTags(query);
        const summaryScope = summaryRequest
            ? (summaryFullScope || !mentionsMeeting ? 'full' : 'scoped')
            : null;

        return {
            intent,
            complexity,
            mentionsMeeting,
            mentionsTimeframe,
            dataPreference,
            formatConstraints,
            intentTags,
            estimatedScope: this._estimateScope(complexity),
            summaryRequest,
            summaryScope
        };
    }

    /**
     * Estimate query scope (how many agents likely needed)
     * @private
     */
    _estimateScope(complexity) {
        switch (complexity) {
            case QueryComplexity.SIMPLE:
                return { min: 1, max: 2 };
            case QueryComplexity.COMPARATIVE:
                return { min: 2, max: 3 };
            case QueryComplexity.AGGREGATE:
                return { min: 3, max: 10 };
            case QueryComplexity.EXPLORATORY:
                return { min: 1, max: 5 };
            default:
                return { min: 1, max: 3 };
        }
    }

    _resolveMaxResults(classification, activeAgentCount = 5) {
        // Dynamic sub-query limit: scale with agent count (max 25 agents allowed)
        const dynamicMax = Math.min(activeAgentCount, 25);

        if (classification?.summaryScope === 'full') {
            // For full summaries, use slightly fewer to reduce latency
            return Math.min(this.options.summaryMaxSubQueries, dynamicMax);
        }

        // Use dynamic limit instead of fixed maxSubQueries
        return dynamicMax;
    }

    _detectFormatConstraints(query) {
        const constraints = {};
        const bulletMatch = query.match(/(\d+)\s+bullets?\s+(?:per|each)\s+(topic|section|meeting)/i);
        if (bulletMatch) {
            constraints.bulletsPerSection = Number.parseInt(bulletMatch[1], 10);
            constraints.sectionType = bulletMatch[2].toLowerCase();
        }
        if (/\btable|matrix|spreadsheet\b/i.test(query)) {
            constraints.preferredFormat = 'table';
        }
        if (/\bcsv\b/i.test(query)) {
            constraints.preferredFormat = 'csv';
        }
        if (/\bexactly\b/i.test(query) || /\bstrict\b/i.test(query)) {
            constraints.strict = true;
        }
        return constraints;
    }

    _inferDataPreference(query) {
        if (/\b(metrics?|kpis?|numbers?|percent|percentage|budget|revenue|cost|forecast|quota|pipeline)\b/i.test(query)) {
            return 'structured';
        }
        if (/\b(transcript|verbatim|exact wording|who said|quote)\b/i.test(query)) {
            return 'transcript';
        }
        if (/\b(summary|overview|highlights)\b/i.test(query)) {
            return 'hybrid';
        }
        return 'hybrid';
    }

    _inferIntentTags(query) {
        const tags = [];
        if (/\bdecision(s)?\b/i.test(query)) tags.push('decision');
        if (/\baction(s| items?)\b/i.test(query)) tags.push('action');
        if (/\brisk(s)?\b|\bblocker(s)?\b/i.test(query)) tags.push('risk');
        if (/\bconstraint(s)?\b|\blimit(s)?\b/i.test(query)) tags.push('constraint');
        if (/\bentity|stakeholder|partner|customer|vendor\b/i.test(query)) tags.push('entity');
        if (/\bopen question(s)?\b|\bunknowns?\b/i.test(query)) tags.push('open_question');
        if (/\bsummary|overview\b/i.test(query)) tags.push('episode');
        return [...new Set(tags)];
    }

    /**
     * Determine decomposition strategy
     * @private
     */
    _determineStrategy(classification, relevantAgents, stats) {
        const { complexity, intent } = classification;
        const agentCount = relevantAgents.length;

        // No decomposition needed for simple queries with few agents
        if (complexity === QueryComplexity.SIMPLE && agentCount <= 2) {
            return {
                type: 'direct',
                reason: 'Simple query with limited scope',
                parallelization: false,
                estimatedCalls: 1
            };
        }

        // Parallel decomposition for comparative queries
        if (complexity === QueryComplexity.COMPARATIVE) {
            return {
                type: 'parallel',
                reason: 'Comparative query benefits from parallel agent analysis',
                parallelization: true,
                estimatedCalls: Math.min(agentCount, 3)
            };
        }

        // Map-reduce for aggregate queries
        if (complexity === QueryComplexity.AGGREGATE) {
            return {
                type: 'map-reduce',
                reason: 'Aggregate query requires gathering from all agents then synthesizing',
                parallelization: true,
                estimatedCalls: agentCount + 1 // +1 for aggregation
            };
        }

        // Iterative for exploratory queries
        if (complexity === QueryComplexity.EXPLORATORY) {
            return {
                type: 'iterative',
                reason: 'Exploratory query may need multiple rounds',
                parallelization: false,
                estimatedCalls: 2 // Initial + refinement
            };
        }

        // Default to parallel for efficiency
        return {
            type: 'parallel',
            reason: 'Default parallel strategy for efficiency',
            parallelization: true,
            estimatedCalls: agentCount // Already limited by _resolveMaxResults
        };
    }

    /**
     * Generate sub-queries based on strategy
     * @private
     */
    async _generateSubQueries(query, classification, strategy, relevantAgents, context) {
        const subQueries = [];

        switch (strategy.type) {
            case 'direct':
                // Single query to all relevant agents combined
                subQueries.push({
                    id: 'sq-0',
                    type: 'direct',
                    query: query,
                    targetAgents: relevantAgents.map(a => a.id),
                    contextLevel: 'standard',
                    priority: 1
                });
                break;

            case 'parallel':
                // One sub-query per relevant agent
                relevantAgents.forEach((agent, index) => {
                    subQueries.push({
                        id: `sq-${index}`,
                        type: 'agent-specific',
                        query: this._createAgentSpecificQuery(query, agent),
                        targetAgents: [agent.id],
                        contextLevel: 'standard',
                        priority: 1,
                        agentName: agent.displayName || agent.title
                    });
                });
                break;

            case 'map-reduce':
                // Map phase: query each agent
                relevantAgents.forEach((agent, index) => {
                    subQueries.push({
                        id: `sq-map-${index}`,
                        type: 'map',
                        query: this._createMapQuery(query, classification.intent),
                        targetAgents: [agent.id],
                        contextLevel: 'summary', // Lighter context for map phase
                        priority: 1,
                        agentName: agent.displayName || agent.title
                    });
                });

                // Reduce phase marker (executed after map results)
                subQueries.push({
                    id: 'sq-reduce',
                    type: 'reduce',
                    query: this._createReduceQuery(query, classification.intent),
                    targetAgents: [], // Uses map results, not agent context
                    contextLevel: 'none',
                    priority: 2,
                    dependsOn: subQueries.filter(sq => sq.type === 'map').map(sq => sq.id)
                });
                break;

            case 'iterative':
                // Initial broad query
                subQueries.push({
                    id: 'sq-initial',
                    type: 'exploratory',
                    query: query,
                    targetAgents: relevantAgents.slice(0, 3).map(a => a.id),
                    contextLevel: 'summary',
                    priority: 1
                });

                // Placeholder for follow-up (determined at runtime)
                subQueries.push({
                    id: 'sq-followup',
                    type: 'followup',
                    query: null, // Generated based on initial response
                    targetAgents: [], // Determined at runtime
                    contextLevel: 'full',
                    priority: 2,
                    dependsOn: ['sq-initial'],
                    dynamic: true
                });
                break;
        }

        return subQueries;
    }

    /**
     * Create agent-specific sub-query
     * @private
     */
    _createAgentSpecificQuery(originalQuery, agent) {
        // Maintain the original query but scope it to the agent
        return `Regarding the "${agent.displayName || agent.title}" meeting: ${originalQuery}`;
    }

    /**
     * Create map-phase query (extracts relevant info from single agent)
     * @private
     */
    _createMapQuery(originalQuery, intent) {
        const extractionPrompts = {
            [QueryIntent.FACTUAL]: `Extract any relevant facts or decisions related to: ${originalQuery}`,
            [QueryIntent.AGGREGATIVE]: `List all items related to: ${originalQuery}`,
            [QueryIntent.ANALYTICAL]: `Identify patterns or themes related to: ${originalQuery}`,
            [QueryIntent.TEMPORAL]: `Note any timeline or progression related to: ${originalQuery}`,
            [QueryIntent.COMPARATIVE]: `Summarize the key points about: ${originalQuery}`
        };

        return extractionPrompts[intent] || `Find information about: ${originalQuery}`;
    }

    /**
     * Create reduce-phase query (synthesizes map results)
     * @private
     */
    _createReduceQuery(originalQuery, intent) {
        const synthesisPrompts = {
            [QueryIntent.FACTUAL]: `Based on the gathered information, answer: ${originalQuery}`,
            [QueryIntent.AGGREGATIVE]: `Combine and organize all the gathered items for: ${originalQuery}`,
            [QueryIntent.ANALYTICAL]: `Synthesize the patterns found across meetings for: ${originalQuery}`,
            [QueryIntent.TEMPORAL]: `Create a timeline or progression summary for: ${originalQuery}`,
            [QueryIntent.COMPARATIVE]: `Compare and contrast the findings for: ${originalQuery}`
        };

        return synthesisPrompts[intent] || `Synthesize the findings to answer: ${originalQuery}`;
    }

    /**
     * Future RLM hook: Generate executable code for REPL
     * @param {string} query - User query
     * @returns {string} Generated code
     */
    generateREPLCode(query) {
        // Placeholder for full RLM implementation
        // In full RLM, this would generate Python code like:
        // ```
        // results = []
        // for agent in context.agents:
        //     if relevant(agent, query):
        //         results.append(sub_llm(agent, query))
        // return aggregate(results)
        // ```
        console.warn('generateREPLCode: Code generation not yet implemented');
        return `# RLM-Lite: Code generation placeholder
# Query: ${query}
# This would generate executable analysis code in full RLM`;
    }
}

// Factory function
export function createDecomposer(options = {}) {
    return new QueryDecomposer(options);
}
