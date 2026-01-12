/**
 * RLM (Recursive Language Model) - Main Module
 *
 * This is the main entry point for the RLM-Lite implementation.
 * It provides a clean API for the orchestrator to use decomposition,
 * parallel execution, and aggregation.
 *
 * Architecture based on: "Recursive Language Models" by Zhang, Kraska & Khattab
 * Paper: https://arxiv.org/abs/2512.24601
 *
 * RLM-Lite implements:
 * - Query decomposition into targeted sub-queries
 * - Parallel execution with concurrency control
 * - Response aggregation and synthesis
 *
 * Future full RLM will add:
 * - REPL environment for code execution
 * - Recursive sub-LM calls (depth > 1)
 * - Generated code for context manipulation
 */

import { ContextStore, getContextStore, resetContextStore } from './context-store.js';
import { QueryDecomposer, createDecomposer, QueryComplexity, QueryIntent } from './query-decomposer.js';
import { SubExecutor, createExecutor } from './sub-executor.js';
import { ResponseAggregator, createAggregator } from './aggregator.js';

/**
 * RLM Configuration
 */
export const RLM_CONFIG = {
    // Decomposition settings
    maxSubQueries: 5,
    minRelevanceScore: 2,

    // Execution settings
    maxConcurrent: 3,
    maxDepth: 2,          // For future recursive implementation
    tokensPerSubQuery: 800,
    timeout: 30000,

    // Aggregation settings
    maxFinalLength: 4000,
    enableLLMSynthesis: true,
    deduplicationThreshold: 0.7,

    // Feature flags
    enableRLM: true,       // Master switch for RLM processing
    fallbackToLegacy: true // Fall back to legacy if RLM fails
};

/**
 * RLM Pipeline - Main orchestration class
 */
export class RLMPipeline {
    constructor(config = {}) {
        this.config = { ...RLM_CONFIG, ...config };

        this.contextStore = getContextStore();
        this.decomposer = createDecomposer({
            maxSubQueries: this.config.maxSubQueries,
            minRelevanceScore: this.config.minRelevanceScore
        });
        this.executor = createExecutor({
            maxConcurrent: this.config.maxConcurrent,
            maxDepth: this.config.maxDepth,
            tokensPerSubQuery: this.config.tokensPerSubQuery,
            timeout: this.config.timeout
        });
        this.aggregator = createAggregator({
            maxFinalLength: this.config.maxFinalLength,
            enableLLMSynthesis: this.config.enableLLMSynthesis,
            deduplicationThreshold: this.config.deduplicationThreshold
        });

        this.stats = {
            queriesProcessed: 0,
            totalSubQueries: 0,
            avgExecutionTime: 0,
            strategies: {}
        };
    }

    /**
     * Load agents into the context store
     * @param {Array} agents - Agent array from orchestrator state
     */
    loadAgents(agents) {
        this.contextStore.loadAgents(agents);
        console.log(`[RLM] Loaded ${agents.length} agents into context store`);
    }

    /**
     * Process a user query through the RLM pipeline
     * @param {string} query - User's natural language query
     * @param {Function} llmCall - Function to call LLM
     * @param {Object} context - Additional context (apiKey, etc.)
     * @returns {Promise<Object>} Processed result
     */
    async process(query, llmCall, context = {}) {
        const startTime = Date.now();

        if (!this.config.enableRLM) {
            console.log('[RLM] RLM disabled, using legacy processing');
            return this._legacyProcess(query, llmCall, context);
        }

        try {
            console.log('[RLM] Starting pipeline for query:', query.substring(0, 50) + '...');

            // Step 1: Decompose the query
            console.log('[RLM] Step 1: Decomposing query...');
            const decomposition = await this.decomposer.decompose(query, context);
            console.log(`[RLM] Decomposed into ${decomposition.subQueries.length} sub-queries using ${decomposition.strategy.type} strategy`);

            // Step 2: Execute sub-queries
            console.log('[RLM] Step 2: Executing sub-queries...');
            const executionResult = await this.executor.execute(
                decomposition,
                this._wrapLLMCall(llmCall),
                context
            );

            if (!executionResult.success) {
                throw new Error(executionResult.error || 'Execution failed');
            }

            console.log(`[RLM] Executed ${executionResult.results.length} sub-queries in ${executionResult.executionTime}ms`);

            // Step 3: Aggregate results
            console.log('[RLM] Step 3: Aggregating results...');
            const aggregation = await this.aggregator.aggregate(
                executionResult,
                decomposition,
                this._wrapLLMCall(llmCall),
                context
            );

            // Update stats
            this._updateStats(decomposition, executionResult, Date.now() - startTime);

            // Format final response
            const finalResponse = this.aggregator.formatForDisplay(aggregation);

            console.log(`[RLM] Pipeline complete in ${Date.now() - startTime}ms`);

            return {
                success: true,
                response: finalResponse,
                metadata: {
                    ...aggregation.metadata,
                    rlmEnabled: true,
                    pipelineTime: Date.now() - startTime
                }
            };

        } catch (error) {
            console.error('[RLM] Pipeline error:', error);

            if (this.config.fallbackToLegacy) {
                console.log('[RLM] Falling back to legacy processing');
                return this._legacyProcess(query, llmCall, context);
            }

            return {
                success: false,
                response: `Error processing query: ${error.message}`,
                metadata: {
                    rlmEnabled: true,
                    error: error.message,
                    pipelineTime: Date.now() - startTime
                }
            };
        }
    }

    /**
     * Wrap LLM call function for sub-queries
     * @private
     */
    _wrapLLMCall(llmCall) {
        return async (subQuery, agentContext, context) => {
            // Build a focused prompt for sub-query
            const systemPrompt = `You are analyzing meeting data to answer a specific question.
Be concise and focus only on information relevant to the question.
If the information is not available in the provided context, say so briefly.`;

            const userPrompt = `Context from meetings:
${agentContext}

Question: ${subQuery}

Provide a focused answer based only on the context above.`;

            return llmCall(systemPrompt, userPrompt, context);
        };
    }

    /**
     * Legacy processing (non-RLM fallback)
     * @private
     */
    async _legacyProcess(query, llmCall, context) {
        const activeAgents = this.contextStore.getActiveAgents();
        const combinedContext = this.contextStore.getCombinedContext(
            activeAgents.map(a => a.id),
            'standard'
        );

        const systemPrompt = `You are a helpful meeting assistant with access to data from multiple meetings.
Use the following meeting data to answer questions accurately and comprehensively.`;

        const response = await llmCall(systemPrompt, `${combinedContext}\n\nQuestion: ${query}`, context);

        return {
            success: true,
            response,
            metadata: {
                rlmEnabled: false,
                legacy: true
            }
        };
    }

    /**
     * Update pipeline statistics
     * @private
     */
    _updateStats(decomposition, executionResult, totalTime) {
        this.stats.queriesProcessed++;
        this.stats.totalSubQueries += decomposition.subQueries.length;

        // Running average of execution time
        const n = this.stats.queriesProcessed;
        this.stats.avgExecutionTime =
            ((n - 1) * this.stats.avgExecutionTime + totalTime) / n;

        // Track strategy usage
        const strategy = decomposition.strategy.type;
        this.stats.strategies[strategy] = (this.stats.strategies[strategy] || 0) + 1;
    }

    /**
     * Get pipeline statistics
     */
    getStats() {
        return {
            ...this.stats,
            contextStore: this.contextStore.getStats(),
            config: this.config
        };
    }

    /**
     * Check if RLM should be used for a query
     * @param {string} query - User query
     * @returns {boolean} Whether to use RLM
     */
    shouldUseRLM(query) {
        if (!this.config.enableRLM) return false;

        const stats = this.contextStore.getStats();

        // Use RLM if we have 3+ agents (decomposition beneficial)
        if (stats.activeAgents >= 3) return true;

        // Use RLM for complex queries even with fewer agents
        const complexityIndicators = [
            /compare|contrast|differ/i,
            /all|every|across/i,
            /pattern|trend|theme/i,
            /\?.*\?/  // Multiple questions
        ];

        return complexityIndicators.some(pattern => pattern.test(query));
    }

    /**
     * Reset pipeline state
     */
    reset() {
        resetContextStore();
        this.contextStore = getContextStore();
        this.stats = {
            queriesProcessed: 0,
            totalSubQueries: 0,
            avgExecutionTime: 0,
            strategies: {}
        };
    }
}

// Singleton pipeline instance
let pipelineInstance = null;

/**
 * Get or create the RLM pipeline instance
 * @param {Object} config - Optional configuration override
 * @returns {RLMPipeline} Pipeline instance
 */
export function getRLMPipeline(config = {}) {
    if (!pipelineInstance) {
        pipelineInstance = new RLMPipeline(config);
    }
    return pipelineInstance;
}

/**
 * Reset the RLM pipeline
 * @param {Object} config - Optional new configuration
 * @returns {RLMPipeline} New pipeline instance
 */
export function resetRLMPipeline(config = {}) {
    if (pipelineInstance) {
        pipelineInstance.reset();
    }
    pipelineInstance = new RLMPipeline(config);
    return pipelineInstance;
}

// Export components for advanced usage
export {
    ContextStore,
    getContextStore,
    resetContextStore,
    QueryDecomposer,
    createDecomposer,
    QueryComplexity,
    QueryIntent,
    SubExecutor,
    createExecutor,
    ResponseAggregator,
    createAggregator
};
