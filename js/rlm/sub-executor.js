/**
 * RLM Sub-Executor
 *
 * Executes sub-queries in parallel or sequentially based on strategy.
 * Manages concurrency, rate limiting, and depth tracking.
 *
 * Future RLM expansion: This will support recursive sub-LM calls where
 * a sub-query can spawn its own sub-queries up to maxDepth.
 */

import { getContextStore } from './context-store.js';

export class SubExecutor {
    constructor(options = {}) {
        this.options = {
            maxConcurrent: options.maxConcurrent || 3,
            maxDepth: options.maxDepth || 2,
            tokensPerSubQuery: options.tokensPerSubQuery || 800,
            timeout: options.timeout || 30000,
            retryAttempts: options.retryAttempts || 2,
            enforcePromptBudget: options.enforcePromptBudget || false,
            promptTokenBudget: options.promptTokenBudget || 0,
            promptTokenReserve: options.promptTokenReserve || 0,
            promptTokensForSubQuery: options.promptTokensForSubQuery || null,
            ...options
        };

        this.currentDepth = 0;
        this.executionLog = [];
    }

    /**
     * Update executor options at runtime.
     * @param {Object} nextOptions
     */
    updateOptions(nextOptions = {}) {
        this.options = {
            ...this.options,
            ...nextOptions
        };
    }

    /**
     * Execute sub-queries based on decomposition result
     * @param {Object} decomposition - Result from QueryDecomposer
     * @param {Function} llmCall - Function to call LLM (injected from orchestrator)
     * @param {Object} context - Additional context (apiKey, etc.)
     * @returns {Promise<Object>} Execution results
     */
    async execute(decomposition, llmCall, context = {}) {
        const { subQueries, strategy } = decomposition;
        const startTime = Date.now();

        this.executionLog = [];
        this.currentDepth = context.depth || 0;

        // Check depth limit
        if (this.currentDepth >= this.options.maxDepth) {
            return {
                success: false,
                error: `Maximum recursion depth (${this.options.maxDepth}) reached`,
                results: [],
                executionLog: this.executionLog
            };
        }

        let results;

        try {
            switch (strategy.type) {
                case 'direct':
                    results = await this._executeDirect(subQueries, llmCall, context);
                    break;

                case 'parallel':
                    results = await this._executeParallel(subQueries, llmCall, context);
                    break;

                case 'map-reduce':
                    results = await this._executeMapReduce(subQueries, llmCall, context);
                    break;

                case 'iterative':
                    results = await this._executeIterative(subQueries, llmCall, context);
                    break;

                default:
                    results = await this._executeParallel(subQueries, llmCall, context);
            }

            return {
                success: true,
                results,
                strategy: strategy.type,
                executionTime: Date.now() - startTime,
                executionLog: this.executionLog,
                depth: this.currentDepth
            };

        } catch (error) {
            return {
                success: false,
                error: error.message,
                results: [],
                executionTime: Date.now() - startTime,
                executionLog: this.executionLog,
                depth: this.currentDepth
            };
        }
    }

    /**
     * Execute single direct query
     * @private
     */
    async _executeDirect(subQueries, llmCall, context) {
        const query = subQueries[0];
        if (!query) return [];

        const store = getContextStore();
        const { agentContext, budgetInfo } = this._resolveContext(store, query);

        this._log('direct', query.id, 'started');
        if (budgetInfo) {
            this._log('direct', query.id, budgetInfo);
        }

        const result = await this._executeWithRetry(
            () => llmCall(query.query, agentContext, context),
            query.id
        );

        this._log('direct', query.id, 'completed');

        return [{
            queryId: query.id,
            type: query.type,
            response: result,
            targetAgents: query.targetAgents
        }];
    }

    /**
     * Execute queries in parallel with concurrency limit
     * @private
     */
    async _executeParallel(subQueries, llmCall, context) {
        const store = getContextStore();
        const results = [];

        // Filter out reduce/followup queries (handled separately)
        const parallelQueries = subQueries.filter(sq =>
            sq.type !== 'reduce' && sq.type !== 'followup' && !sq.dynamic
        );

        // Process in batches based on maxConcurrent
        for (let i = 0; i < parallelQueries.length; i += this.options.maxConcurrent) {
            const batch = parallelQueries.slice(i, i + this.options.maxConcurrent);

            this._log('parallel', `batch-${i}`, `started (${batch.length} queries)`);

            const batchResults = await Promise.all(
                batch.map(async (query) => {
                    try {
                        const { agentContext, budgetInfo } = this._resolveContext(store, query);

                        this._log('parallel', query.id, 'executing');
                        if (budgetInfo) {
                            this._log('parallel', query.id, budgetInfo);
                        }

                        const response = await this._executeWithRetry(
                            () => llmCall(query.query, agentContext, context),
                            query.id
                        );

                        return {
                            queryId: query.id,
                            type: query.type,
                            response,
                            targetAgents: query.targetAgents,
                            agentName: query.agentName,
                            success: true
                        };
                    } catch (error) {
                        this._log('parallel', query.id, `failed: ${error.message}`);
                        return {
                            queryId: query.id,
                            type: query.type,
                            response: null,
                            error: error.message,
                            targetAgents: query.targetAgents,
                            agentName: query.agentName,
                            success: false
                        };
                    }
                })
            );

            results.push(...batchResults);
            this._log('parallel', `batch-${i}`, 'completed');
        }

        return results;
    }

    /**
     * Execute map-reduce strategy
     * @private
     */
    async _executeMapReduce(subQueries, llmCall, context) {
        // Separate map and reduce queries
        const mapQueries = subQueries.filter(sq => sq.type === 'map');
        const reduceQuery = subQueries.find(sq => sq.type === 'reduce');

        // Execute map phase in parallel
        this._log('map-reduce', 'map-phase', 'started');
        const mapResults = await this._executeParallel(mapQueries, llmCall, context);
        this._log('map-reduce', 'map-phase', 'completed');

        // Build reduce context from map results
        if (reduceQuery) {
            this._log('map-reduce', 'reduce-phase', 'started');

            const mapContext = mapResults
                .filter(r => r.success && r.response)
                .map(r => `[From ${r.agentName || 'Meeting'}]:\n${r.response}`)
                .join('\n\n---\n\n');

            if (this._shouldEnforcePromptBudget()) {
                const contextTokens = this._estimatePromptTokens(mapContext);
                const maxInputTokens = Math.max(0, this.options.promptTokenBudget - this.options.promptTokenReserve);
                const budgetLog = this._buildBudgetLog('reduce', maxInputTokens, contextTokens, contextTokens > maxInputTokens);
                if (budgetLog) {
                    this._log('map-reduce', reduceQuery.id, budgetLog);
                }
            }

            const reduceResult = await this._executeWithRetry(
                () => llmCall(reduceQuery.query, mapContext, context),
                reduceQuery.id
            );

            this._log('map-reduce', 'reduce-phase', 'completed');

            return [
                ...mapResults,
                {
                    queryId: reduceQuery.id,
                    type: 'reduce',
                    response: reduceResult,
                    success: true,
                    isAggregation: true
                }
            ];
        }

        return mapResults;
    }

    /**
     * Execute iterative strategy (initial + followup)
     * @private
     */
    async _executeIterative(subQueries, llmCall, context) {
        const store = getContextStore();
        const results = [];

        // Execute initial query
        const initialQuery = subQueries.find(sq => sq.type === 'exploratory');
        if (!initialQuery) return results;

        this._log('iterative', 'initial', 'started');

        const { agentContext: initialContext, budgetInfo: initialBudget } = this._resolveContext(store, initialQuery);
        if (initialBudget) {
            this._log('iterative', initialQuery.id, initialBudget);
        }

        const initialResult = await this._executeWithRetry(
            () => llmCall(initialQuery.query, initialContext, context),
            initialQuery.id
        );

        results.push({
            queryId: initialQuery.id,
            type: 'exploratory',
            response: initialResult,
            success: true
        });

        this._log('iterative', 'initial', 'completed');

        // Check if followup is needed (simplified heuristic)
        const followupQuery = subQueries.find(sq => sq.type === 'followup');
        if (followupQuery && this._needsFollowup(initialResult)) {
            this._log('iterative', 'followup', 'started');

            // Expand context for followup
            const allActiveAgents = store.getActiveAgents();
            const followupQueryContext = {
                query: followupQuery.query,
                targetAgents: allActiveAgents.map(agent => agent.id),
                contextLevel: 'full'
            };
            const { agentContext: followupContext, budgetInfo: followupBudget } = this._resolveContext(store, followupQueryContext);
            if (followupBudget) {
                this._log('iterative', followupQuery.id, followupBudget);
            }

            // Generate followup query based on initial result
            const dynamicFollowupQuery = `Based on the initial finding: "${initialResult.substring(0, 200)}..."

Please provide more details and check all codes for related information.`;

            const followupResult = await this._executeWithRetry(
                () => llmCall(dynamicFollowupQuery, followupContext, context),
                followupQuery.id
            );

            results.push({
                queryId: followupQuery.id,
                type: 'followup',
                response: followupResult,
                success: true
            });

            this._log('iterative', 'followup', 'completed');
        }

        return results;
    }

    _resolveContext(store, query) {
        if (!this._shouldEnforcePromptBudget()) {
            return {
                agentContext: store.getCombinedContext(query.targetAgents, query.contextLevel),
                budgetInfo: null
            };
        }

        const baseTokens = this.options.promptTokensForSubQuery
            ? this.options.promptTokensForSubQuery(query.query)
            : 0;
        const maxInputTokens = Math.max(0, this.options.promptTokenBudget - this.options.promptTokenReserve);
        const availableForContext = Math.max(0, maxInputTokens - baseTokens);

        if (!availableForContext) {
            return {
                agentContext: '',
                budgetInfo: this._buildBudgetLog('context', maxInputTokens, 0, true)
            };
        }

        const budgeted = store.getCombinedContextWithBudget(query.targetAgents, availableForContext, {
            preferredLevel: query.contextLevel
        });

        return {
            agentContext: budgeted.context,
            budgetInfo: this._buildBudgetLog(
                'context',
                maxInputTokens,
                budgeted.tokenEstimate,
                budgeted.skippedAgents?.length > 0
            )
        };
    }

    _shouldEnforcePromptBudget() {
        return Boolean(this.options.enforcePromptBudget && this.options.promptTokenBudget);
    }

    _estimatePromptTokens(text) {
        const store = getContextStore();
        return store.estimateTokens(text);
    }

    _buildBudgetLog(scope, maxInputTokens, contextTokens, truncated = false) {
        if (!maxInputTokens) {
            return null;
        }
        const status = truncated ? 'trimmed' : 'ok';
        return `Prompt budget (${scope}): ${contextTokens}/${maxInputTokens} tokens (${status}).`;
    }

    /**
     * Check if followup query is needed
     * @private
     */
    _needsFollowup(initialResult) {
        // Simple heuristics for now
        const uncertaintyMarkers = [
            'not sure',
            'unclear',
            'might be',
            'could be',
            'no information',
            'not found',
            'limited data'
        ];

        const lowerResult = initialResult.toLowerCase();
        return uncertaintyMarkers.some(marker => lowerResult.includes(marker));
    }

    /**
     * Execute with retry logic
     * @private
     */
    async _executeWithRetry(fn, queryId) {
        let lastError;

        for (let attempt = 0; attempt <= this.options.retryAttempts; attempt++) {
            try {
                return await Promise.race([
                    fn(),
                    this._timeout(this.options.timeout, queryId)
                ]);
            } catch (error) {
                lastError = error;
                this._log('retry', queryId, `attempt ${attempt + 1} failed: ${error.message}`);

                if (attempt < this.options.retryAttempts) {
                    await this._sleep(1000 * Math.pow(2, attempt)); // Exponential backoff
                }
            }
        }

        throw lastError;
    }

    /**
     * Create timeout promise
     * @private
     */
    _timeout(ms, queryId) {
        return new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Query ${queryId} timed out after ${ms}ms`)), ms);
        });
    }

    /**
     * Sleep utility
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Log execution event
     * @private
     */
    _log(phase, queryId, message) {
        const entry = {
            timestamp: new Date().toISOString(),
            phase,
            queryId,
            message,
            depth: this.currentDepth
        };
        this.executionLog.push(entry);
        console.log(`[RLM:${phase}] ${queryId}: ${message}`);
    }

    /**
     * Future RLM hook: Execute with recursive sub-calls
     * @param {Object} decomposition - Query decomposition
     * @param {Function} llmCall - LLM call function
     * @param {Object} context - Context including depth
     * @returns {Promise<Object>} Results with potential sub-results
     */
    async executeRecursive(decomposition, llmCall, context = {}) {
        // Placeholder for full RLM recursive execution
        // In full RLM, sub-queries could spawn their own decompositions
        console.warn('executeRecursive: Recursive execution not fully implemented');

        return this.execute(decomposition, llmCall, {
            ...context,
            depth: (context.depth || 0) + 1
        });
    }

    /**
     * Get execution statistics
     */
    getStats() {
        return {
            totalExecutions: this.executionLog.length,
            currentDepth: this.currentDepth,
            log: this.executionLog
        };
    }
}

// Factory function
export function createExecutor(options = {}) {
    return new SubExecutor(options);
}
