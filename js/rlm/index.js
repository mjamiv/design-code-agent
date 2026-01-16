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
    enableFuzzyCache: false    // Enable fuzzy matching for similar queries
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

            const response = await this._currentLlmCall(systemPrompt, userPrompt, this._currentContext);
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

            // Step 1: Decompose the query
            console.log('[RLM] Step 1: Decomposing query...');
            this._emitProgress('Analyzing query structure and intent', 'decompose');
            const decomposition = await this.decomposer.decompose(query, context);
            console.log(`[RLM] Decomposed into ${decomposition.subQueries.length} sub-queries using ${decomposition.strategy.type} strategy`);
            this._emitProgress(`Strategy: ${decomposition.strategy.type} (${decomposition.subQueries.length} sub-queries)`, 'decompose');

            // Step 2: Execute sub-queries
            console.log('[RLM] Step 2: Executing sub-queries...');
            this._emitProgress(`Executing ${decomposition.subQueries.length} sub-queries in parallel`, 'execute');
            const executionResult = await this.executor.execute(
                decomposition,
                this._wrapLLMCall(llmCall),
                context
            );

            if (!executionResult.success) {
                throw new Error(executionResult.error || 'Execution failed');
            }

            console.log(`[RLM] Executed ${executionResult.results.length} sub-queries in ${executionResult.executionTime}ms`);
            this._emitProgress(`Completed ${executionResult.results.length} sub-queries (${executionResult.executionTime}ms)`, 'success');

            // Step 3: Aggregate results
            console.log('[RLM] Step 3: Aggregating results...');
            this._emitProgress('Synthesizing results via LLM aggregation', 'aggregate');
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

            const result = {
                success: true,
                response: finalResponse,
                metadata: {
                    ...aggregation.metadata,
                    rlmEnabled: true,
                    pipelineTime: Date.now() - startTime
                }
            };

            // Phase 3.1: Store result in cache
            this._storeInCache(query, result, 'rlm');

            return result;

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
            const codeResult = await this.codeGenerator.generateWithRetry(
                query,
                { activeAgents: stats.activeAgents, agentNames },
                llmCall
            );

            if (!codeResult.success) {
                console.warn('[RLM:REPL] Code generation failed after retries:', codeResult.error);
                this._emitProgress('Code generation failed, falling back to RLM', 'warning');
                // Fallback to standard processing
                return this.process(query, llmCall, context);
            }

            console.log(`[RLM:REPL] Code generated (${codeResult.attempts} attempt(s)):`, codeResult.code.substring(0, 100) + '...');
            this._emitProgress(`Python code generated (${codeResult.attempts} attempt${codeResult.attempts > 1 ? 's' : ''})`, 'success');

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

            // Phase 3.1: Store result in cache
            this._storeInCache(query, result, 'repl');

            return result;

        } catch (error) {
            console.error('[RLM:REPL] Error:', error);
            this.stats.replErrors++;

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

                const response = await llmCall(systemPrompt, userPrompt, context);
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
            repl: replStats,
            cache: cacheStats,
            config: this.config
        };
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
    CACHE_CONFIG
};
