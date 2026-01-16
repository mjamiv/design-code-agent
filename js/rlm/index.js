/**
 * RLM (Recursive Language Model) - Main Module
 *
 * This is the main entry point for the RLM implementation.
 * It provides a clean API for the orchestrator to use decomposition,
 * parallel execution, aggregation, and REPL-based code execution.
 *
 * Architecture based on: "Recursive Language Models" by Zhang, Kraska & Khattab
 * Paper: https://arxiv.org/abs/2512.24601
 *
 * RLM implements:
 * - Query decomposition into targeted sub-queries
 * - Parallel execution with concurrency control
 * - Response aggregation and synthesis
 * - REPL environment for code execution (Phase 1)
 * - LLM-generated Python code for context manipulation
 * 
 * Phase 2.2: True Recursion
 * - Synchronous sub_lm() calls from Python via SharedArrayBuffer
 * - LLM callback integration for recursive calls
 * - Depth tracking and limits (max 3 levels)
 * - Async fallback for browsers without SharedArrayBuffer
 */

import { ContextStore, getContextStore, resetContextStore } from './context-store.js';
import { QueryDecomposer, createDecomposer, QueryComplexity, QueryIntent } from './query-decomposer.js';
import { SubExecutor, createExecutor } from './sub-executor.js';
import { ResponseAggregator, createAggregator } from './aggregator.js';
import { REPLEnvironment, getREPLEnvironment, resetREPLEnvironment, isREPLSupported, isSharedArrayBufferSupported } from './repl-environment.js';
import { CodeGenerator, createCodeGenerator, generateCodePrompt, parseCodeOutput, parseFinalAnswer, validateCode, classifyQuery, QueryType } from './code-generator.js';
import { QueryCache, getQueryCache, resetQueryCache, CACHE_CONFIG } from './query-cache.js';
import { MemoryStore, getMemoryStore, resetMemoryStore } from './memory-store.js';
import { buildShadowPrompt, buildRetrievalPromptSections } from './prompt-builder.js';

/**
 * RLM Configuration
 */
export const RLM_CONFIG = {
    // Decomposition settings
    maxSubQueries: 5,
    minRelevanceScore: 2,

    // Execution settings
    maxConcurrent: 3,
    maxDepth: 2,              // Max recursion depth for sub_lm calls
    maxSubLmCalls: 2,         // Max internal sub_lm expansions per prompt
    maxOutputTokens: 2000,    // Max output tokens per LLM call
    tokensPerSubQuery: 800,
    timeout: 30000,

    // Aggregation settings
    maxFinalLength: 4000,
    enableLLMSynthesis: true,
    deduplicationThreshold: 0.7,

    // REPL settings
    enableREPL: true,          // Enable REPL-based code execution
    replTimeout: 30000,        // REPL execution timeout
    autoInitREPL: false,       // Auto-initialize REPL on first use
    preferREPL: false,         // Prefer REPL over decomposition when both applicable
    subLmTimeout: 60000,       // Timeout for individual sub_lm calls

    // Feature flags
    enableRLM: true,           // Master switch for RLM processing
    fallbackToLegacy: true,    // Fall back to legacy if RLM fails
    enableSyncSubLm: true,     // Enable synchronous sub_lm (requires SharedArrayBuffer)

    // Cache settings (Phase 3.1)
    enableCache: true,         // Enable query result caching
    cacheMaxEntries: 50,       // Maximum cache entries
    cacheTTL: 5 * 60 * 1000,   // Cache TTL (5 minutes)
    enableFuzzyCache: false,   // Enable fuzzy matching for similar queries

    // Milestone 2: Shadow prompt builder (no behavior change)
    enableShadowPrompt: true,
    shadowPromptMaxSlices: 6,
    shadowPromptMaxPerTag: 2,
    shadowPromptMaxPerAgent: 2,
    shadowPromptRecencyWindowDays: 30,

    // Milestone 2.5: Retrieval prompt builder (feature-flagged)
    enableRetrievalPrompt: false,

    // Milestone 4: Guardrails + token budgeting
    enablePromptBudgeting: true,
    promptTokenBudget: 12000,
    promptTokenReserve: 2000,

    // Milestone 3: Focus episodes (shadow mode, gated)
    enableFocusShadow: true,
    enableFocusEpisodes: false,
    focusTokenBudget: 8000,
    focusBudgetThreshold: 0.8,
    focusTriggerToolCalls: 3,
    focusTriggerSubLmCalls: 2
};

/**
 * RLM Pipeline - Main orchestration class
 */
export class RLMPipeline {
    constructor(config = {}) {
        this.config = { ...RLM_CONFIG, ...config };

        this.contextStore = getContextStore();
        this.memoryStore = getMemoryStore();
        this.decomposer = createDecomposer({
            maxSubQueries: this.config.maxSubQueries,
            minRelevanceScore: this.config.minRelevanceScore
        });
        this.executor = createExecutor({
            maxConcurrent: this.config.maxConcurrent,
            maxDepth: this.config.maxDepth,
            tokensPerSubQuery: this.config.tokensPerSubQuery,
            timeout: this.config.timeout,
            enforcePromptBudget: this.config.enablePromptBudgeting,
            promptTokenBudget: this.config.promptTokenBudget,
            promptTokenReserve: this.config.promptTokenReserve,
            promptTokensForSubQuery: (subQuery) => this._estimateSubQueryBaseTokens(subQuery)
        });
        this.aggregator = createAggregator({
            maxFinalLength: this.config.maxFinalLength,
            enableLLMSynthesis: this.config.enableLLMSynthesis,
            deduplicationThreshold: this.config.deduplicationThreshold
        });

        // REPL components (initialized lazily)
        this.repl = null;
        this.replInitializing = false;
        this.codeGenerator = createCodeGenerator({
            validateCode: true,
            maxRetries: 2
        });
        
        // LLM callback for sub_lm calls (set during processWithREPL)
        this._currentLlmCall = null;
        this._currentContext = null;

        // Phase 3.1: Query result cache
        this.cache = this.config.enableCache ? getQueryCache({
            maxEntries: this.config.cacheMaxEntries,
            defaultTTL: this.config.cacheTTL,
            enableFuzzyMatch: this.config.enableFuzzyCache
        }) : null;

        this.stats = {
            queriesProcessed: 0,
            totalSubQueries: 0,
            avgExecutionTime: 0,
            strategies: {},
            replExecutions: 0,
            replErrors: 0,
            subLmCalls: 0,
            subLmErrors: 0,
            cacheHits: 0,
            cacheMisses: 0
        };

        // Progress callback for train-of-thought UI updates
        this._progressCallback = null;

        // Shadow prompt storage (Milestone 2)
        this.shadowPrompt = null;

        // Focus tracking (Milestone 3)
        this.focusTracker = {
            toolCalls: 0,
            subLmCalls: 0,
            turns: 0,
            pendingReason: null,
            lastTokenEstimate: 0
        };

        // Guardrail telemetry (Milestone 4)
        this.guardrails = {
            lastPromptEstimate: 0,
            lastBudget: 0,
            lastMode: null,
            lastTrimmed: false,
            lastTrimmedTokens: 0,
            lastContextTokens: 0,
            lastSwmFallbackUsed: false,
            lastFallbackReason: null,
            lastRetrievalStats: null,
            lastUpdatedAt: null
        };
    }

    /**
     * Set a callback for progress updates during pipeline execution
     * @param {Function} callback - Function(step, type, details) to call on progress
     */
    setProgressCallback(callback) {
        this._progressCallback = callback;
    }

    /**
     * Emit a progress update
     * @private
     */
    _emitProgress(step, type = 'info', details = {}) {
        if (this._progressCallback) {
            try {
                this._progressCallback(step, type, details);
            } catch (e) {
                console.warn('[RLM] Progress callback error:', e);
            }
        }
    }

    /**
     * Initialize the REPL environment
     * @returns {Promise<boolean>} Whether initialization succeeded
     */
    async initializeREPL() {
        if (this.repl && this.repl.isReady()) {
            return true;
        }

        if (this.replInitializing) {
            // Wait for existing initialization
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (this.repl && this.repl.isReady()) {
                        clearInterval(check);
                        resolve(true);
                    }
                }, 100);
                setTimeout(() => {
                    clearInterval(check);
                    resolve(false);
                }, 60000);
            });
        }

        if (!isREPLSupported()) {
            console.warn('[RLM] REPL not supported in this environment');
            return false;
        }

        this.replInitializing = true;

        try {
            console.log('[RLM] Initializing REPL environment...');
            this.repl = getREPLEnvironment({
                defaultTimeout: this.config.replTimeout,
                subLmTimeout: this.config.subLmTimeout,
                maxRecursionDepth: this.config.maxDepth
            });
            
            // Phase 2.2: Set up LLM callback for sub_lm calls
            this.repl.setLLMCallback(async (query, contextSlice) => {
                return this._handleSubLmCallback(query, contextSlice);
            });
            
            // Phase 3.2: Set up sub_lm progress callbacks for UI updates
            this.repl.onSubLmStart = (data) => {
                console.log(`[RLM] sub_lm #${data.id} started at depth ${data.depth}: ${data.query.substring(0, 50)}...`);
                this._emitProgress(`sub_lm(${data.depth}): "${data.query.substring(0, 40)}..."`, 'recurse', {
                    subLmId: data.id,
                    depth: data.depth,
                    query: data.query
                });
            };
            
            this.repl.onSubLmComplete = (data) => {
                const status = data.success ? '✓' : '✗';
                console.log(`[RLM] sub_lm #${data.id} ${data.success ? 'completed' : 'failed'} in ${data.duration}ms`);
                this._emitProgress(`${status} sub_lm(${data.depth}) completed (${data.duration}ms)`, 
                    data.success ? 'success' : 'warning', {
                    subLmId: data.id,
                    depth: data.depth,
                    duration: data.duration,
                    success: data.success
                });
            };
            
            // Legacy callback (deprecated, for backward compatibility)
            this.repl.onSubLmCall = (data) => {
                console.log(`[RLM] sub_lm call at depth ${data.depth}: ${data.query.substring(0, 50)}...`);
            };
            
            await this.repl.initialize();

            // Sync context to REPL
            const contextData = this.contextStore.toPythonDict();
            await this.repl.setContext(contextData.agents);
            
            // Log capabilities
            const caps = this.repl.getCapabilities();
            console.log('[RLM] REPL environment ready', {
                syncEnabled: caps.syncEnabled,
                maxDepth: caps.maxRecursionDepth
            });

            this.replInitializing = false;
            return true;

        } catch (error) {
            console.error('[RLM] REPL initialization failed:', error);
            this.replInitializing = false;
            this.repl = null;
            return false;
        }
    }
    
    /**
     * Handle sub_lm callback from REPL
     * @private
     */
    async _handleSubLmCallback(query, contextSlice) {
        if (!this._currentLlmCall) {
            throw new Error('No LLM callback available for sub_lm');
        }
        
        this.stats.subLmCalls++;
        
        try {
            const systemPrompt = `You are analyzing meeting data to answer a specific question.
Be concise and focus only on information relevant to the question.
If the information is not available in the provided context, say so briefly.`;

            const userPrompt = contextSlice
                ? `Context:\n${contextSlice}\n\nQuestion: ${query}`
                : `Question: ${query}`;

            const response = await this._callWithPromptGuardrails(
                this._currentLlmCall,
                systemPrompt,
                userPrompt,
                this._currentContext,
                'sub-lm'
            );
            return response;
            
        } catch (error) {
            this.stats.subLmErrors++;
            console.error('[RLM] sub_lm callback error:', error.message);
            throw error;
        }
    }

    /**
     * Check if REPL is ready
     * @returns {boolean}
     */
    isREPLReady() {
        return this.repl && this.repl.isReady();
    }

    /**
     * Load agents into the context store
     * @param {Array} agents - Agent array from orchestrator state
     */
    loadAgents(agents) {
        this.contextStore.loadAgents(agents);
        console.log(`[RLM] Loaded ${agents.length} agents into context store`);

        // Phase 3.1: Invalidate cache when agents change
        // Cache keys include agent IDs, so changing agents invalidates cached results
        if (this.cache) {
            this.cache.clear();
            console.log('[RLM] Cache invalidated due to agent change');
        }

        // Sync to REPL if initialized
        if (this.repl && this.repl.isReady()) {
            const contextData = this.contextStore.toPythonDict();
            this.repl.setContext(contextData.agents).catch(err => {
                console.warn('[RLM] Failed to sync agents to REPL:', err.message);
            });
        }
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

        // Phase 3.1: Check cache for existing result
        const cachedResult = this._checkCache(query, 'rlm');
        if (cachedResult) {
            this.stats.cacheHits++;
            this._emitProgress('Cache hit - returning cached result', 'success');
            return {
                ...cachedResult,
                metadata: {
                    ...cachedResult.metadata,
                    cached: true,
                    cacheTime: Date.now() - startTime
                }
            };
        }
        this.stats.cacheMisses++;

        try {
            console.log('[RLM] Starting pipeline for query:', query.substring(0, 50) + '...');
            this._emitProgress('Starting RLM pipeline...', 'info');
            this._startFocusIfEnabled('RLM pipeline', query);
            this._runShadowPromptBuild(query, context, 'rlm');
            this._appendFocusEvent(`Received query: "${query}"`, { step: 'start', mode: 'rlm' });

            // Step 1: Decompose the query
            console.log('[RLM] Step 1: Decomposing query...');
            this._emitProgress('Analyzing query structure and intent', 'decompose');
            const decomposition = await this.decomposer.decompose(query, context);
            console.log(`[RLM] Decomposed into ${decomposition.subQueries.length} sub-queries using ${decomposition.strategy.type} strategy`);
            this._emitProgress(`Strategy: ${decomposition.strategy.type} (${decomposition.subQueries.length} sub-queries)`, 'decompose');
            this._appendFocusEvent(
                `Decomposition strategy: ${decomposition.strategy.type} with ${decomposition.subQueries.length} sub-queries.`,
                { step: 'decompose' }
            );

            // Step 2: Execute sub-queries
            console.log('[RLM] Step 2: Executing sub-queries...');
            this._emitProgress(`Executing ${decomposition.subQueries.length} sub-queries in parallel`, 'execute');
            const guardedSubQueryCall = this._wrapLLMCall(llmCall);
            const executionResult = await this.executor.execute(
                decomposition,
                guardedSubQueryCall,
                context
            );

            if (!executionResult.success) {
                throw new Error(executionResult.error || 'Execution failed');
            }

            console.log(`[RLM] Executed ${executionResult.results.length} sub-queries in ${executionResult.executionTime}ms`);
            this._emitProgress(`Completed ${executionResult.results.length} sub-queries (${executionResult.executionTime}ms)`, 'success');
            this.focusTracker.toolCalls += executionResult.results.length;
            this._appendFocusEvent(
                `Executed ${executionResult.results.length} sub-queries in ${executionResult.executionTime}ms.`,
                { step: 'execute' }
            );
            this._checkFocusTriggerCounts();

            // Step 3: Aggregate results
            console.log('[RLM] Step 3: Aggregating results...');
            this._emitProgress('Synthesizing results via LLM aggregation', 'aggregate');
            const guardedAggregationCall = (systemPrompt, userPrompt, callContext) => this._callWithPromptGuardrails(
                llmCall,
                systemPrompt,
                userPrompt,
                callContext,
                'aggregate'
            );
            const aggregation = await this.aggregator.aggregate(
                executionResult,
                decomposition,
                guardedAggregationCall,
                context
            );
            this._appendFocusEvent('Aggregated sub-query results into final response.', { step: 'aggregate' });
            this._queueFocusReason('phase_complete');

            // Update stats
            this._updateStats(decomposition, executionResult, Date.now() - startTime);

            // Format final response
            const finalResponse = this.aggregator.formatForDisplay(aggregation);

            console.log(`[RLM] Pipeline complete in ${Date.now() - startTime}ms`);

            const result = {
                success: true,
                response: finalResponse,
                metadata: {
                    ...aggregation.metadata,
                    rlmEnabled: true,
                    pipelineTime: Date.now() - startTime
                }
            };

            this._captureMemory(query, result);
            this._completeFocusIfReady();

            // Phase 3.1: Store result in cache
            this._storeInCache(query, result, 'rlm');

            return result;

        } catch (error) {
            console.error('[RLM] Pipeline error:', error);
            this._appendFocusEvent(`Pipeline error: ${error.message}`, { step: 'error' });
            this._queueFocusReason('termination');
            this._completeFocusIfReady();

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

    _estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(text.length / 4);
    }

    _getPromptBudget() {
        const budget = this.config.promptTokenBudget || 0;
        const reserve = this.config.promptTokenReserve || this.config.maxOutputTokens || 0;
        const maxInputTokens = Math.max(0, budget - reserve);
        return { budget, reserve, maxInputTokens };
    }

    _buildSubQueryPrompts(subQuery, contextText) {
        const systemPrompt = `You are analyzing meeting data to answer a specific question.
Be concise and focus only on information relevant to the question.
If the information is not available in the provided context, say so briefly.`;

        const userPrompt = `Context from meetings:
${contextText}

Question: ${subQuery}

Provide a focused answer based only on the context above.`;

        return { systemPrompt, userPrompt };
    }

    _buildLegacyPrompts(query, contextText) {
        const systemPrompt = `You are a helpful meeting assistant with access to data from multiple meetings.
Use the following meeting data to answer questions accurately and comprehensively.`;

        const userPrompt = `${contextText}\n\nQuestion: ${query}`.trim();
        return { systemPrompt, userPrompt };
    }

    _formatStateBlock(stateBlock) {
        if (!stateBlock) return '';
        const sections = [];
        const addSection = (label, items) => {
            if (!items || items.length === 0) return;
            sections.push(`${label}:\n${items.map(item => `- ${item.text}`).join('\n')}`);
        };

        addSection('Decisions', stateBlock.decisions);
        addSection('Actions', stateBlock.actions);
        addSection('Risks', stateBlock.risks);
        addSection('Entities', stateBlock.entities);
        addSection('Constraints', stateBlock.constraints);
        addSection('Open Questions', stateBlock.openQuestions);

        return sections.join('\n\n');
    }

    _formatWorkingWindow(workingWindow) {
        if (!workingWindow) return '';
        const parts = [];
        if (workingWindow.lastUserTurns?.length) {
            parts.push(`Recent User Turns:\n${workingWindow.lastUserTurns.map(turn => `- ${turn}`).join('\n')}`);
        }
        if (workingWindow.lastAssistantSummary) {
            parts.push(`Last Assistant Summary:\n${workingWindow.lastAssistantSummary}`);
        }
        return parts.join('\n\n');
    }

    _buildSwmFallbackContext() {
        if (!this.memoryStore) return '';
        const stateBlock = this._formatStateBlock(this.memoryStore.getStateBlock());
        const workingWindow = this._formatWorkingWindow(this.memoryStore.getWorkingWindow());
        return [stateBlock, workingWindow].filter(Boolean).join('\n\n');
    }

    _estimateSubQueryBaseTokens(subQuery) {
        const { systemPrompt, userPrompt } = this._buildSubQueryPrompts(subQuery, '');
        return this._estimateTokens(systemPrompt) + this._estimateTokens(userPrompt);
    }

    _truncateToTokenBudget(text, tokenBudget) {
        if (!text || !tokenBudget) return '';
        const maxChars = Math.max(0, tokenBudget * 4);
        if (text.length <= maxChars) return text;
        return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
    }

    _recordGuardrail(mode, promptEstimate, budget, trimmed, trimmedTokens, contextTokens, metadata = {}) {
        this.guardrails = {
            lastPromptEstimate: promptEstimate,
            lastBudget: budget,
            lastMode: mode,
            lastTrimmed: trimmed,
            lastTrimmedTokens: trimmedTokens,
            lastContextTokens: contextTokens,
            lastSwmFallbackUsed: Boolean(metadata.swmFallbackUsed),
            lastFallbackReason: metadata.fallbackReason || null,
            lastRetrievalStats: metadata.retrievalStats || null,
            lastUpdatedAt: new Date().toISOString()
        };
        this._checkFocusBudgetTrigger(promptEstimate);
    }

    _buildRetrievalPromptContext(query, localContext = '', options = {}) {
        if (!this.config.enableRetrievalPrompt || !this.memoryStore) {
            return {
                contextText: localContext || '',
                retrievalStats: null,
                tokenEstimate: this._estimateTokens(localContext),
                tokenBreakdown: [],
                retrievedSlices: [],
                reduction: null
            };
        }

        const recencyWindowMs = this.config.shadowPromptRecencyWindowDays
            ? this.config.shadowPromptRecencyWindowDays * 24 * 60 * 60 * 1000
            : null;
        const retrieval = this.memoryStore.retrieveSlices(query, {
            maxResults: this.config.shadowPromptMaxSlices,
            maxPerTag: this.config.shadowPromptMaxPerTag,
            maxPerAgent: this.config.shadowPromptMaxPerAgent,
            recencyWindowMs,
            updateStats: true
        });

        let retrievedSlices = retrieval.slices;
        let promptData = buildRetrievalPromptSections({
            stateBlock: this.memoryStore.getStateBlock(),
            workingWindow: this.memoryStore.getWorkingWindow(),
            retrievedSlices,
            localContext
        });

        const guardrail = this._getPromptBudget();
        const maxInputTokens = options.maxInputTokens ?? guardrail.maxInputTokens;
        let reduction = null;

        if (this.config.enablePromptBudgeting && maxInputTokens > 0 && promptData.tokenEstimate > maxInputTokens) {
            const originalCount = retrievedSlices.length;
            const originalTokens = promptData.tokenEstimate;
            let trimmed = [...retrievedSlices];
            while (trimmed.length > 0 && promptData.tokenEstimate > maxInputTokens) {
                trimmed.pop();
                promptData = buildRetrievalPromptSections({
                    stateBlock: this.memoryStore.getStateBlock(),
                    workingWindow: this.memoryStore.getWorkingWindow(),
                    retrievedSlices: trimmed,
                    localContext
                });
            }
            retrievedSlices = trimmed;
            reduction = {
                originalCount,
                finalCount: trimmed.length,
                dropped: Math.max(0, originalCount - trimmed.length),
                budget: maxInputTokens,
                originalTokens,
                finalTokens: promptData.tokenEstimate
            };
        }

        const retrievalStats = {
            ...retrieval.stats,
            selectedCount: retrievedSlices.length,
            selectedIds: retrievedSlices.map(slice => slice.id),
            reduction
        };

        return {
            contextText: promptData.prompt || localContext || '',
            retrievalStats,
            tokenEstimate: promptData.tokenEstimate,
            tokenBreakdown: promptData.tokenBreakdown,
            retrievedSlices,
            reduction
        };
    }

    async _callWithPromptGuardrails(llmCall, systemPrompt, userPrompt, context, mode = 'generic', metadata = {}) {
        const guardrail = this._getPromptBudget();
        const systemTokens = this._estimateTokens(systemPrompt);
        const userTokens = this._estimateTokens(userPrompt);
        let trimmed = false;
        let trimmedTokens = 0;
        let finalUserPrompt = userPrompt;

        if (this.config.enablePromptBudgeting && guardrail.maxInputTokens > 0) {
            const availableForUser = Math.max(0, guardrail.maxInputTokens - systemTokens);
            if (systemTokens + userTokens > guardrail.maxInputTokens) {
                finalUserPrompt = this._truncateToTokenBudget(userPrompt, availableForUser);
                trimmedTokens = userTokens - this._estimateTokens(finalUserPrompt);
                trimmed = true;
            }
        }

        const promptEstimate = systemTokens + this._estimateTokens(finalUserPrompt);
        this._recordGuardrail(
            mode,
            promptEstimate,
            guardrail.maxInputTokens,
            trimmed,
            trimmedTokens,
            userTokens,
            metadata
        );

        return llmCall(systemPrompt, finalUserPrompt, context);
    }

    /**
     * Wrap LLM call function for sub-queries
     * @private
     */
    _wrapLLMCall(llmCall) {
        return async (subQuery, agentContext, context) => {
            const { systemPrompt } = this._buildSubQueryPrompts(subQuery, '');
            let userPrompt = '';
            const guardrail = this._getPromptBudget();
            const baseTokens = this._estimateTokens(this._buildSubQueryPrompts(subQuery, '').userPrompt)
                + this._estimateTokens(systemPrompt);
            let trimmed = false;
            let trimmedTokens = 0;
            let fallbackUsed = false;
            let finalContext = agentContext;
            let retrievalStats = null;

            if (this.config.enableRetrievalPrompt && this.memoryStore) {
                const availableForContext = Math.max(0, guardrail.maxInputTokens - baseTokens);
                const retrievalData = this._buildRetrievalPromptContext(subQuery, '', {
                    maxInputTokens: availableForContext
                });
                finalContext = retrievalData.contextText;
                retrievalStats = retrievalData.retrievalStats;
                if (retrievalData.reduction && retrievalData.reduction.dropped > 0) {
                    trimmed = true;
                    trimmedTokens = Math.max(0, retrievalData.reduction.originalTokens - retrievalData.reduction.finalTokens);
                }
            } else if (this.config.enablePromptBudgeting && guardrail.maxInputTokens > 0) {
                const availableForContext = Math.max(0, guardrail.maxInputTokens - baseTokens);
                const contextTokens = this._estimateTokens(agentContext);
                if (contextTokens > availableForContext) {
                    finalContext = this._truncateToTokenBudget(agentContext, availableForContext);
                    trimmedTokens = contextTokens - this._estimateTokens(finalContext);
                    trimmed = true;
                }
                if (!finalContext) {
                    const fallbackContext = this._buildSwmFallbackContext();
                    if (fallbackContext && availableForContext > 0) {
                        const fallbackTokens = this._estimateTokens(fallbackContext);
                        finalContext = fallbackTokens > availableForContext
                            ? this._truncateToTokenBudget(fallbackContext, availableForContext)
                            : fallbackContext;
                        fallbackUsed = true;
                        const finalTokens = this._estimateTokens(finalContext);
                        trimmedTokens = Math.max(trimmedTokens, contextTokens - finalTokens);
                        trimmed = trimmed || fallbackTokens > availableForContext;
                    }
                }
            }

            if (!finalContext) {
                const fallbackContext = this._buildSwmFallbackContext();
                if (fallbackContext) {
                    finalContext = fallbackContext;
                    fallbackUsed = true;
                }
            }

            userPrompt = this._buildSubQueryPrompts(subQuery, finalContext).userPrompt;

            const promptEstimate = this._estimateTokens(systemPrompt) + this._estimateTokens(userPrompt);
            this._recordGuardrail(
                'subquery',
                promptEstimate,
                guardrail.maxInputTokens,
                trimmed,
                trimmedTokens,
                this._estimateTokens(finalContext),
                {
                    swmFallbackUsed: fallbackUsed,
                    fallbackReason: fallbackUsed ? 'context_trim' : null,
                    retrievalStats
                }
            );

            return llmCall(systemPrompt, userPrompt, context);
        };
    }

    /**
     * Legacy processing (non-RLM fallback)
     * @private
     */
    async _legacyProcess(query, llmCall, context) {
        const activeAgents = this.contextStore.getActiveAgents();
        const agentIds = activeAgents.map(agent => agent.id);
        let combinedContext = '';
        const guardrail = this._getPromptBudget();
        const { systemPrompt, userPrompt: baseUserPrompt } = this._buildLegacyPrompts(query, '');
        const baseTokens = this._estimateTokens(systemPrompt) + this._estimateTokens(baseUserPrompt);
        let retrievalStats = null;
        if (this.config.enableRetrievalPrompt && this.memoryStore) {
            const availableForContext = Math.max(0, guardrail.maxInputTokens - baseTokens);
            const retrievalData = this._buildRetrievalPromptContext(query, '', {
                maxInputTokens: availableForContext
            });
            combinedContext = retrievalData.contextText;
            retrievalStats = retrievalData.retrievalStats;
        } else {
            combinedContext = this.contextStore.getCombinedContext(agentIds, 'standard');
            if (this.config.enablePromptBudgeting && guardrail.maxInputTokens > 0) {
                const availableForContext = Math.max(0, guardrail.maxInputTokens - baseTokens);
                const contextTokens = this._estimateTokens(combinedContext);
                if (contextTokens > availableForContext) {
                    const budgeted = this.contextStore.getCombinedContextWithBudget(agentIds, availableForContext, {
                        preferredLevel: 'standard'
                    });
                    combinedContext = budgeted.context;
                }
            }
        }

        let swmFallbackUsed = false;
        if (!combinedContext) {
            const fallbackContext = this._buildSwmFallbackContext();
            if (fallbackContext) {
                swmFallbackUsed = true;
                if (this.config.enablePromptBudgeting && guardrail.maxInputTokens > 0) {
                    const availableForContext = Math.max(0, guardrail.maxInputTokens - baseTokens);
                    combinedContext = this._truncateToTokenBudget(fallbackContext, availableForContext);
                } else {
                    combinedContext = fallbackContext;
                }
            }
        }

        const { userPrompt } = this._buildLegacyPrompts(query, combinedContext);

        this._startFocusIfEnabled('Legacy pipeline', query);
        this._runShadowPromptBuild(query, context, 'legacy');
        this._appendFocusEvent(`Received query: "${query}"`, { step: 'start', mode: 'legacy' });

        const response = await this._callWithPromptGuardrails(
            llmCall,
            systemPrompt,
            userPrompt,
            context,
            'legacy',
            {
                swmFallbackUsed,
                fallbackReason: swmFallbackUsed ? 'overflow' : null,
                retrievalStats
            }
        );

        const result = {
            success: true,
            response,
            metadata: {
                rlmEnabled: false,
                legacy: true
            }
        };

        this._captureMemory(query, result);
        this._appendFocusEvent('Legacy response generated.', { step: 'complete', mode: 'legacy' });
        this._queueFocusReason('phase_complete');
        this._completeFocusIfReady();

        return result;
    }

    /**
     * Process a query using REPL-based code execution
     * The LLM generates Python code that runs against the meeting context
     * 
     * Phase 2.2: Now supports synchronous sub_lm() calls from within Python code
     * 
     * @param {string} query - User's natural language query
     * @param {Function} llmCall - Function to call LLM
     * @param {Object} context - Additional context
     * @returns {Promise<Object>} Processed result
     */
    async processWithREPL(query, llmCall, context = {}) {
        const startTime = Date.now();

        // Phase 3.1: Check cache for existing result
        const cachedResult = this._checkCache(query, 'repl');
        if (cachedResult) {
            this.stats.cacheHits++;
            this._emitProgress('Cache hit - returning cached result', 'success');
            return {
                ...cachedResult,
                metadata: {
                    ...cachedResult.metadata,
                    cached: true,
                    cacheTime: Date.now() - startTime
                }
            };
        }
        this.stats.cacheMisses++;

        // Phase 2.2: Store the LLM callback for sub_lm calls
        this._currentLlmCall = llmCall;
        this._currentContext = context;

        try {
            this._startFocusIfEnabled('REPL pipeline', query);
            this._runShadowPromptBuild(query, context, 'repl');
            this._appendFocusEvent(`Received query: "${query}"`, { step: 'start', mode: 'repl' });
            // Ensure REPL is initialized
            if (!this.isREPLReady()) {
                const initialized = await this.initializeREPL();
                if (!initialized) {
                    throw new Error('REPL initialization failed');
                }
            }

            console.log('[RLM:REPL] Processing query with code execution...');
            this._emitProgress('Initializing REPL code execution pipeline', 'info');
            
            // Classify the query for better code generation
            const classification = classifyQuery(query);
            console.log(`[RLM:REPL] Query classified as: ${classification.type} (confidence: ${classification.confidence.toFixed(2)})`);
            this._emitProgress(`Query type: ${classification.type} (${(classification.confidence * 100).toFixed(0)}% confidence)`, 'classify');

            // Step 1: Generate code prompt
            const stats = this.contextStore.getStats();
            const agentNames = this.contextStore.getAgentNames();
            const { systemPrompt, userPrompt } = generateCodePrompt(query, {
                activeAgents: stats.activeAgents,
                agentNames
            });

            // Step 2: Call LLM to generate code (with retry support)
            console.log('[RLM:REPL] Generating Python code...');
            this._emitProgress('Calling GPT to generate Python analysis code', 'code');
            const guardedCodeCall = (systemPrompt, userPrompt, callContext) => this._callWithPromptGuardrails(
                llmCall,
                systemPrompt,
                userPrompt,
                callContext,
                'repl-code'
            );
            const codeResult = await this.codeGenerator.generateWithRetry(
                query,
                { activeAgents: stats.activeAgents, agentNames },
                guardedCodeCall
            );

            if (!codeResult.success) {
                console.warn('[RLM:REPL] Code generation failed after retries:', codeResult.error);
                this._emitProgress('Code generation failed, falling back to RLM', 'warning');
                // Fallback to standard processing
                return this.process(query, llmCall, context);
            }

            console.log(`[RLM:REPL] Code generated (${codeResult.attempts} attempt(s)):`, codeResult.code.substring(0, 100) + '...');
            this._emitProgress(`Python code generated (${codeResult.attempts} attempt${codeResult.attempts > 1 ? 's' : ''})`, 'success');
            this._appendFocusEvent(`Generated Python analysis code in ${codeResult.attempts} attempt(s).`, { step: 'code' });

            // Step 3: Execute the code in REPL
            this._emitProgress('Executing Python in Pyodide sandbox', 'execute');
            const execResult = await this.repl.execute(codeResult.code, this.config.replTimeout);

            if (!execResult.success) {
                console.warn('[RLM:REPL] Code execution failed:', execResult.error);
                this.stats.replErrors++;
                this._emitProgress('Python execution failed, falling back to RLM', 'warning');
                // Fallback to standard processing
                return this.process(query, llmCall, context);
            }

            this._emitProgress('Python code executed successfully', 'success');
            this._appendFocusEvent('Executed Python analysis successfully.', { step: 'execute' });

            // Step 4: Parse the final answer
            this._emitProgress('Extracting FINAL answer from output', 'aggregate');
            const finalAnswer = parseFinalAnswer(execResult);

            this.stats.replExecutions++;

            // Phase 2.2: Handle async fallback sub-LM calls if sync was not available
            // (these are queued calls that weren't processed synchronously)
            if (finalAnswer.subLmCalls && finalAnswer.subLmCalls.length > 0) {
                const maxSubLmCalls = this.config.maxSubLmCalls || finalAnswer.subLmCalls.length;
                const pendingCalls = finalAnswer.subLmCalls.slice(0, maxSubLmCalls);
                const skippedCalls = finalAnswer.subLmCalls.length - pendingCalls.length;

                console.log(`[RLM:REPL] Processing ${pendingCalls.length} async fallback sub-LM calls...`);
                this._emitProgress(`Processing ${pendingCalls.length} recursive sub_lm() calls`, 'recurse');
                if (skippedCalls > 0) {
                    this._emitProgress(`Skipping ${skippedCalls} sub_lm() calls due to expansion limits`, 'warning');
                }

                // Process sub-LM calls and aggregate results
                const subResults = await this._processSubLmCalls(pendingCalls, llmCall, context);
                this.focusTracker.subLmCalls += pendingCalls.length;
                this._appendFocusEvent(`Processed ${pendingCalls.length} recursive sub_lm() calls.`, { step: 'recurse' });
                this._checkFocusTriggerCounts();
                
                // Combine with the main answer
                let combinedAnswer = finalAnswer.answer || '';
                if (subResults.length > 0) {
                    combinedAnswer += '\n\n---\n\n**Additional Analysis:**\n\n';
                    combinedAnswer += subResults.map(r => r.response).join('\n\n');
                    this._emitProgress(`Aggregated ${subResults.length} recursive results`, 'success');
                }
                if (skippedCalls > 0) {
                    combinedAnswer += `\n\n---\n\nNote: ${skippedCalls} recursive call${skippedCalls > 1 ? 's' : ''} skipped due to expansion limits.`;
                }
                finalAnswer.answer = combinedAnswer;
            }
            
            // Get sub_lm stats from REPL
            const subLmStats = this.repl.getSubLmStats();

            console.log(`[RLM:REPL] Complete in ${Date.now() - startTime}ms`, {
                syncEnabled: execResult.syncEnabled,
                subLmCalls: subLmStats.totalCalls
            });

            if (subLmStats.totalCalls > 0) {
                this._emitProgress(`Completed with ${subLmStats.totalCalls} recursive LLM call${subLmStats.totalCalls > 1 ? 's' : ''}`, 'recurse');
                this.focusTracker.subLmCalls += subLmStats.totalCalls;
                this._checkFocusTriggerCounts();
            }

            const result = {
                success: true,
                response: finalAnswer.answer || 'No result from code execution',
                metadata: {
                    rlmEnabled: true,
                    replUsed: true,
                    syncEnabled: execResult.syncEnabled,
                    classification: classification.type,
                    codeAttempts: codeResult.attempts,
                    subLmCalls: subLmStats.totalCalls,
                    pipelineTime: Date.now() - startTime,
                    stdout: finalAnswer.stdout,
                    stderr: finalAnswer.stderr
                }
            };

            this._captureMemory(query, result);
            this._appendFocusEvent('REPL response compiled.', { step: 'complete', mode: 'repl' });
            this._queueFocusReason('phase_complete');
            this._completeFocusIfReady();

            // Phase 3.1: Store result in cache
            this._storeInCache(query, result, 'repl');

            return result;

        } catch (error) {
            console.error('[RLM:REPL] Error:', error);
            this.stats.replErrors++;
            this._appendFocusEvent(`REPL pipeline error: ${error.message}`, { step: 'error' });
            this._queueFocusReason('termination');
            this._completeFocusIfReady();

            if (this.config.fallbackToLegacy) {
                console.log('[RLM:REPL] Falling back to standard processing');
                return this.process(query, llmCall, context);
            }

            return {
                success: false,
                response: `Error: ${error.message}`,
                metadata: {
                    rlmEnabled: true,
                    replUsed: true,
                    error: error.message,
                    pipelineTime: Date.now() - startTime
                }
            };
        } finally {
            // Clear the current LLM callback
            this._currentLlmCall = null;
            this._currentContext = null;
        }
    }

    /**
     * Process sub-LM calls generated by REPL code
     * @private
     */
    async _processSubLmCalls(subLmCalls, llmCall, context) {
        const results = [];

        for (const call of subLmCalls) {
            try {
                const systemPrompt = `You are analyzing meeting data to answer a specific question.
Be concise and focus only on information relevant to the question.`;

                const userPrompt = call.context
                    ? `Context:\n${call.context}\n\nQuestion: ${call.query}`
                    : `Question: ${call.query}`;

                const response = await this._callWithPromptGuardrails(
                    llmCall,
                    systemPrompt,
                    userPrompt,
                    context,
                    'sub-lm'
                );
                results.push({
                    id: call.id,
                    success: true,
                    response
                });

            } catch (error) {
                results.push({
                    id: call.id,
                    success: false,
                    error: error.message
                });
            }
        }

        return results;
    }

    /**
     * Capture memory for SWM store (Milestone 1).
     * @private
     */
    _captureMemory(query, result) {
        if (!this.memoryStore || !result?.success) {
            return;
        }

        this.memoryStore.captureCompletion({
            query,
            response: result.response,
            metadata: {
                agentIds: this.contextStore.getActiveAgents().map(agent => agent.id),
                mode: result.metadata?.replUsed ? 'repl' : (result.metadata?.legacy ? 'legacy' : 'rlm')
            }
        });
    }

    /**
     * Build a shadow prompt for retrieval logging (Milestone 2).
     * @private
     */
    _runShadowPromptBuild(query, context, mode) {
        if (!this.config.enableShadowPrompt || !this.memoryStore) {
            return;
        }

        const startedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        const recencyWindowMs = this.config.shadowPromptRecencyWindowDays
            ? this.config.shadowPromptRecencyWindowDays * 24 * 60 * 60 * 1000
            : null;

        const retrieval = this.memoryStore.retrieveSlices(query, {
            maxResults: this.config.shadowPromptMaxSlices,
            maxPerTag: this.config.shadowPromptMaxPerTag,
            maxPerAgent: this.config.shadowPromptMaxPerAgent,
            recencyWindowMs,
            updateStats: false
        });

        const retrievalFinishedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();

        const basePromptInput = {
            query,
            stateBlock: this.memoryStore.getStateBlock(),
            workingWindow: this.memoryStore.getWorkingWindow(),
            localContext: context?.localContext || ''
        };

        let retrievedSlices = retrieval.slices;
        let promptData = buildShadowPrompt({
            ...basePromptInput,
            retrievedSlices
        });
        const guardrail = this._getPromptBudget();
        let reduction = null;

        if (this.config.enablePromptBudgeting && guardrail.maxInputTokens > 0 && promptData.tokenEstimate > guardrail.maxInputTokens) {
            const originalCount = retrievedSlices.length;
            let trimmed = [...retrievedSlices];
            while (trimmed.length > 0 && promptData.tokenEstimate > guardrail.maxInputTokens) {
                trimmed.pop();
                promptData = buildShadowPrompt({
                    ...basePromptInput,
                    retrievedSlices: trimmed
                });
            }
            retrievedSlices = trimmed;
            reduction = {
                originalCount,
                finalCount: trimmed.length,
                dropped: Math.max(0, originalCount - trimmed.length),
                budget: guardrail.maxInputTokens,
                finalTokens: promptData.tokenEstimate
            };
        }

        const promptFinishedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();

        const previousIds = new Set(this.shadowPrompt?.retrievalStats?.selectedIds || []);
        const currentIds = retrievedSlices.map(slice => slice.id);
        const addedIds = currentIds.filter(id => !previousIds.has(id));
        const removedIds = [...previousIds].filter(id => !currentIds.includes(id));

        const summarizeByType = (slices) => slices.reduce((acc, slice) => {
            acc[slice.type] = (acc[slice.type] || 0) + 1;
            return acc;
        }, {});
        const currentTypeCounts = summarizeByType(retrievedSlices);
        const previousTypeCounts = summarizeByType(this.shadowPrompt?.retrievalSlices || []);

        this.shadowPrompt = {
            mode,
            query,
            createdAt: new Date().toISOString(),
            retrievalStats: {
                ...retrieval.stats,
                selectedCount: retrievedSlices.length,
                selectedIds: currentIds,
                reduction,
                diff: {
                    addedCount: addedIds.length,
                    removedCount: removedIds.length,
                    addedIds,
                    removedIds,
                    typeCounts: currentTypeCounts,
                    previousTypeCounts
                },
                latencyMs: retrieval.stats.latencyMs ?? Math.max(0, retrievalFinishedAt - startedAt)
            },
            retrievalSlices: retrievedSlices,
            promptPreview: promptData.prompt,
            tokenEstimate: promptData.tokenEstimate,
            tokenBreakdown: promptData.tokenBreakdown,
            promptLatencyMs: Math.max(0, promptFinishedAt - retrievalFinishedAt),
            totalLatencyMs: Math.max(0, promptFinishedAt - startedAt)
        };
        this._checkFocusBudgetTrigger(promptData.tokenEstimate);

        console.log('[RLM:ShadowPrompt] Built prompt in shadow mode', {
            mode,
            retrieved: retrieval.stats.selectedCount,
            candidates: retrieval.stats.candidateCount,
            tokenEstimate: promptData.tokenEstimate,
            retrievalLatencyMs: this.shadowPrompt.retrievalStats.latencyMs,
            promptLatencyMs: this.shadowPrompt.promptLatencyMs,
            totalLatencyMs: this.shadowPrompt.totalLatencyMs
        });
        console.log('[RLM:ShadowPrompt] Shadow-only telemetry snapshot', {
            promptPreview: promptData.prompt,
            retrievalStats: this.shadowPrompt.retrievalStats,
            tokenEstimate: promptData.tokenEstimate,
            tokenBreakdown: promptData.tokenBreakdown
        });
        if (addedIds.length || removedIds.length) {
            console.log('[RLM:ShadowPrompt] Retrieval diff (shadow only)', {
                addedIds,
                removedIds,
                currentTypeCounts,
                previousTypeCounts
            });
        }
        this._emitProgress('Shadow prompt built (shadow-only)', 'info', {
            shadowOnly: true,
            promptPreview: promptData.prompt,
            retrievalStats: this.shadowPrompt.retrievalStats,
            tokenEstimate: promptData.tokenEstimate,
            tokenBreakdown: promptData.tokenBreakdown,
            promptLatencyMs: this.shadowPrompt.promptLatencyMs,
            totalLatencyMs: this.shadowPrompt.totalLatencyMs
        });

        if (retrievedSlices.length > 0) {
            console.log('[RLM:ShadowPrompt] Retrieved slices (shadow only)', retrievedSlices.map(slice => ({
                id: slice.id,
                type: slice.type,
                score: slice._score,
                text: slice.text
            })));
        } else {
            console.log('[RLM:ShadowPrompt] No slices retrieved for shadow prompt');
        }
    }

    _startFocusIfEnabled(label, query) {
        if (!this._isFocusEnabled() || !this.memoryStore) {
            return;
        }

        this.focusTracker.turns += 1;
        this.memoryStore.startFocus(label, `Objective: ${query}`, {
            agentIds: this.contextStore.getActiveAgents().map(agent => agent.id)
        });
    }

    _appendFocusEvent(event, source = {}) {
        if (!this._isFocusEnabled() || !this.memoryStore) {
            return;
        }
        this.memoryStore.appendFocus(event, source);
    }

    _checkFocusBudgetTrigger(tokenEstimate) {
        if (!this._isFocusEnabled()) {
            return;
        }

        const previousEstimate = this.focusTracker.lastTokenEstimate || 0;
        this.focusTracker.lastTokenEstimate = tokenEstimate;
        if (!this.config.focusTokenBudget) {
            return;
        }
        const threshold = this.config.focusTokenBudget * this.config.focusBudgetThreshold;
        if (tokenEstimate >= threshold && previousEstimate < threshold) {
            this._appendFocusEvent(
                `Prompt estimate ${tokenEstimate} tokens exceeded budget threshold ${threshold}.`,
                { trigger: 'budget_pressure' }
            );
            this._queueFocusReason('budget_pressure');
        }
    }

    _checkFocusTriggerCounts() {
        if (!this._isFocusEnabled()) {
            return;
        }

        if (this.config.focusTriggerToolCalls && this.focusTracker.toolCalls >= this.config.focusTriggerToolCalls) {
            this._appendFocusEvent(
                `Tool call threshold reached (${this.focusTracker.toolCalls}).`,
                { trigger: 'tool_calls' }
            );
            this._queueFocusReason('tool_calls');
        }
        if (this.config.focusTriggerSubLmCalls && this.focusTracker.subLmCalls >= this.config.focusTriggerSubLmCalls) {
            this._appendFocusEvent(
                `Recursive call threshold reached (${this.focusTracker.subLmCalls}).`,
                { trigger: 'recursive_depth' }
            );
            this._queueFocusReason('recursive_depth');
        }
    }

    _queueFocusReason(reason) {
        if (!this._isFocusEnabled()) {
            return;
        }

        const priority = {
            budget_pressure: 5,
            phase_complete: 4,
            tool_calls: 3,
            recursive_depth: 2,
            termination: 1
        };
        const current = this.focusTracker.pendingReason;
        if (!current || (priority[reason] || 0) > (priority[current] || 0)) {
            this.focusTracker.pendingReason = reason;
        }
    }

    _completeFocusIfReady() {
        if (!this._isFocusEnabled() || !this.focusTracker.pendingReason || !this.memoryStore) {
            return;
        }

        const focusResult = this.memoryStore.completeFocus({
            reason: this.focusTracker.pendingReason,
            persist: this.config.enableFocusEpisodes,
            metadata: {
                agentIds: this.contextStore.getActiveAgents().map(agent => agent.id)
            }
        });

        this.focusTracker.toolCalls = 0;
        this.focusTracker.subLmCalls = 0;
        this.focusTracker.turns = 0;
        this.focusTracker.pendingReason = null;

        if (!focusResult) {
            return;
        }

        console.log('[RLM:Focus] Focus episode completed', {
            label: focusResult.label,
            reason: focusResult.reason,
            summary: focusResult.episode_summary,
            decisions: focusResult.decisions.length,
            actions: focusResult.actions.length,
            risks: focusResult.risks.length,
            entities: focusResult.entities.length
        });
        this._emitProgress('Focus episode completed', 'info', {
            shadowOnly: !this.config.enableFocusEpisodes,
            focusSummary: focusResult.episode_summary,
            focusReason: focusResult.reason
        });
    }

    _isFocusEnabled() {
        return Boolean(this.config.enableFocusShadow || this.config.enableFocusEpisodes);
    }

    // ==========================================
    // Phase 3.1: Cache Methods
    // ==========================================

    /**
     * Check cache for a query result
     * @private
     * @param {string} query - User query
     * @param {string} mode - Processing mode ('rlm' or 'repl')
     * @returns {Object|null} Cached result or null
     */
    _checkCache(query, mode = 'rlm') {
        if (!this.cache || !this.config.enableCache) {
            return null;
        }

        // Get active agent IDs for cache key
        const activeAgents = this.contextStore.getActiveAgents();
        const agentIds = activeAgents.map(a => a.id);

        // Generate cache key
        const cacheKey = this.cache.generateKey(query, agentIds, mode);

        // Try exact match first
        let cached = this.cache.get(cacheKey);

        // Try fuzzy match if enabled and no exact match
        if (!cached && this.config.enableFuzzyCache) {
            cached = this.cache.getFuzzy(query, agentIds, mode);
        }

        if (cached) {
            console.log(`[RLM:Cache] HIT for query: ${query.substring(0, 40)}...`);
        }

        return cached;
    }

    /**
     * Store a result in the cache
     * @private
     * @param {string} query - User query
     * @param {Object} result - Result to cache
     * @param {string} mode - Processing mode ('rlm' or 'repl')
     */
    _storeInCache(query, result, mode = 'rlm') {
        if (!this.cache || !this.config.enableCache) {
            return;
        }

        // Only cache successful results
        if (!result.success) {
            return;
        }

        // Get active agent IDs for cache key
        const activeAgents = this.contextStore.getActiveAgents();
        const agentIds = activeAgents.map(a => a.id);

        // Generate cache key and store
        const cacheKey = this.cache.generateKey(query, agentIds, mode);
        this.cache.set(cacheKey, result, this.config.cacheTTL);

        console.log(`[RLM:Cache] Stored result for query: ${query.substring(0, 40)}...`);
    }

    /**
     * Clear the query result cache
     * Call this when agents are modified
     */
    clearCache() {
        if (this.cache) {
            this.cache.clear();
            console.log('[RLM] Query cache cleared');
        }
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        if (!this.cache) {
            return { enabled: false };
        }
        return {
            enabled: true,
            ...this.cache.getStats()
        };
    }

    /**
     * Check if a query should use REPL execution
     * @param {string} query - User query
     * @param {{ auto?: boolean }} options - Auto-route REPL only for ambiguous prompts when true
     * @returns {boolean}
     */
    shouldUseREPL(query, { auto = true } = {}) {
        if (!this.config.enableREPL) return false;
        if (!isREPLSupported()) return false;
        if (auto && !this._isAmbiguousQuery(query)) return false;

        // Queries that benefit from code execution
        const replPatterns = [
            /search|find|grep|look for/i,
            /list all|show all|get all/i,
            /count|how many/i,
            /filter|extract/i,
            /sort|order by|rank/i,
            /combine|merge|aggregate/i
        ];

        return replPatterns.some(pattern => pattern.test(query));
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
        const replStats = this.repl ? {
            isReady: this.repl.isReady(),
            syncEnabled: this.repl.isSyncEnabled(),
            subLm: this.repl.getSubLmStats(),
            capabilities: this.repl.getCapabilities()
        } : null;
        
        // Phase 3.1: Include cache stats
        const cacheStats = this.getCacheStats();
        
        return {
            ...this.stats,
            contextStore: this.contextStore.getStats(),
            memoryStore: this.memoryStore.getStats(),
            shadowPrompt: this.shadowPrompt,
            guardrails: this.guardrails,
            repl: replStats,
            cache: cacheStats,
            config: this.config
        };
    }

    /**
     * Update pipeline configuration at runtime.
     * @param {Object} overrides
     */
    updateConfig(overrides = {}) {
        this.config = { ...this.config, ...overrides };

        if (this.executor?.updateOptions) {
            this.executor.updateOptions({
                maxConcurrent: this.config.maxConcurrent,
                maxDepth: this.config.maxDepth,
                tokensPerSubQuery: this.config.tokensPerSubQuery,
                timeout: this.config.timeout,
                enforcePromptBudget: this.config.enablePromptBudgeting,
                promptTokenBudget: this.config.promptTokenBudget,
                promptTokenReserve: this.config.promptTokenReserve,
                promptTokensForSubQuery: (subQuery) => this._estimateSubQueryBaseTokens(subQuery)
            });
        }

        if (this.repl) {
            this.repl.config.maxRecursionDepth = this.config.maxDepth;
            this.repl.config.subLmTimeout = this.config.subLmTimeout;
        }
    }

    /**
     * Check if RLM should be used for a query
     * @param {string} query - User query
     * @param {{ auto?: boolean }} options - Auto-route RLM only for ambiguous prompts when true
     * @returns {boolean} Whether to use RLM
     */
    shouldUseRLM(query, { auto = true } = {}) {
        if (!this.config.enableRLM) return false;
        if (!auto) return true;
        return this._isAmbiguousQuery(query);
    }

    /**
     * Heuristic ambiguity detector for routing RLM only on unclear prompts.
     * @param {string} query - User query
     * @returns {boolean}
     */
    _isAmbiguousQuery(query) {
        const normalizedQuery = (query || '').trim();
        if (!normalizedQuery) return true;

        const tokenCount = normalizedQuery.split(/\s+/).filter(Boolean).length;
        if (tokenCount <= 3) return true;

        const ambiguityIndicators = [
            // Vague referents without context
            /\b(this|that|these|those|it|they|them|do it|do that|fix it|make it)\b/i,
            // Undefined scope or targets
            /\b(something|anything|stuff|etc\.?)\b/i,
            // Multiple possible interpretations
            /\b(or|either)\b/i,
            // Explicit uncertainty
            /\b(not sure|unsure|maybe|kind of|sort of|roughly)\b/i
        ];

        if (ambiguityIndicators.some(pattern => pattern.test(normalizedQuery))) {
            return true;
        }

        // If multiple questions are asked, treat as ambiguous to decompose.
        const questionCount = (normalizedQuery.match(/\?/g) || []).length;
        if (questionCount > 1) return true;

        return false;
    }

    /**
     * Reset pipeline state
     */
    reset() {
        resetContextStore();
        this.contextStore = getContextStore();
        resetMemoryStore();
        this.memoryStore = getMemoryStore();
        this.shadowPrompt = null;

        // Reset REPL if initialized
        if (this.repl) {
            this.repl.reset().catch(() => {});
        }

        // Phase 3.1: Clear cache on reset
        if (this.cache) {
            this.cache.clear();
            this.cache.resetStats();
        }

        this.stats = {
            queriesProcessed: 0,
            totalSubQueries: 0,
            avgExecutionTime: 0,
            strategies: {},
            replExecutions: 0,
            replErrors: 0,
            subLmCalls: 0,
            subLmErrors: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
    }

    /**
     * Terminate the pipeline and clean up resources
     */
    terminate() {
        if (this.repl) {
            this.repl.terminate();
            this.repl = null;
        }
        this.reset();
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
    // Context Store
    ContextStore,
    getContextStore,
    resetContextStore,

    // Query Decomposition
    QueryDecomposer,
    createDecomposer,
    QueryComplexity,
    QueryIntent,

    // Execution
    SubExecutor,
    createExecutor,

    // Aggregation
    ResponseAggregator,
    createAggregator,

    // REPL Environment
    REPLEnvironment,
    getREPLEnvironment,
    resetREPLEnvironment,
    isREPLSupported,
    isSharedArrayBufferSupported,

    // Code Generation
    CodeGenerator,
    createCodeGenerator,
    generateCodePrompt,
    parseCodeOutput,
    parseFinalAnswer,
    validateCode,
    classifyQuery,
    QueryType,

    // Query Cache (Phase 3.1)
    QueryCache,
    getQueryCache,
    resetQueryCache,
    CACHE_CONFIG,
    // Memory Store (Milestone 1)
    MemoryStore,
    getMemoryStore,
    resetMemoryStore
};
