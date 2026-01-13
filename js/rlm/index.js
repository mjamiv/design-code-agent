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
 * Future full RLM will add:
 * - Recursive sub-LM calls (depth > 1)
 * - Async parallel execution
 */

import { ContextStore, getContextStore, resetContextStore } from './context-store.js';
import { QueryDecomposer, createDecomposer, QueryComplexity, QueryIntent } from './query-decomposer.js';
import { SubExecutor, createExecutor } from './sub-executor.js';
import { ResponseAggregator, createAggregator } from './aggregator.js';
import { REPLEnvironment, getREPLEnvironment, resetREPLEnvironment, isREPLSupported } from './repl-environment.js';
import { CodeGenerator, createCodeGenerator, generateCodePrompt, parseCodeOutput, parseFinalAnswer, validateCode } from './code-generator.js';

/**
 * RLM Configuration
 */
export const RLM_CONFIG = {
    // Decomposition settings
    maxSubQueries: 5,
    minRelevanceScore: 2,

    // Execution settings
    maxConcurrent: 3,
    maxDepth: 2,          // For recursive implementation
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

    // Feature flags
    enableRLM: true,           // Master switch for RLM processing
    fallbackToLegacy: true     // Fall back to legacy if RLM fails
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
            validateCode: true
        });

        this.stats = {
            queriesProcessed: 0,
            totalSubQueries: 0,
            avgExecutionTime: 0,
            strategies: {},
            replExecutions: 0,
            replErrors: 0
        };
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
                defaultTimeout: this.config.replTimeout
            });
            await this.repl.initialize();

            // Sync context to REPL
            const contextData = this.contextStore.toPythonDict();
            await this.repl.setContext(contextData.agents);

            console.log('[RLM] REPL environment ready');
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
     * Process a query using REPL-based code execution
     * The LLM generates Python code that runs against the meeting context
     * @param {string} query - User's natural language query
     * @param {Function} llmCall - Function to call LLM
     * @param {Object} context - Additional context
     * @returns {Promise<Object>} Processed result
     */
    async processWithREPL(query, llmCall, context = {}) {
        const startTime = Date.now();

        try {
            // Ensure REPL is initialized
            if (!this.isREPLReady()) {
                const initialized = await this.initializeREPL();
                if (!initialized) {
                    throw new Error('REPL initialization failed');
                }
            }

            console.log('[RLM:REPL] Processing query with code execution...');

            // Step 1: Generate code prompt
            const stats = this.contextStore.getStats();
            const agentNames = this.contextStore.getAgentNames();
            const { systemPrompt, userPrompt } = generateCodePrompt(query, {
                activeAgents: stats.activeAgents,
                agentNames
            });

            // Step 2: Call LLM to generate code
            console.log('[RLM:REPL] Generating Python code...');
            const llmResponse = await llmCall(systemPrompt, userPrompt, context);

            // Step 3: Parse and validate the generated code
            const parseResult = this.codeGenerator.parseAndValidate(llmResponse);

            if (!parseResult.success) {
                console.warn('[RLM:REPL] Code generation failed:', parseResult.error);
                // Fallback to standard processing
                return this.process(query, llmCall, context);
            }

            console.log('[RLM:REPL] Executing code:', parseResult.code.substring(0, 100) + '...');

            // Step 4: Execute the code in REPL
            const execResult = await this.repl.execute(parseResult.code, this.config.replTimeout);

            if (!execResult.success) {
                console.warn('[RLM:REPL] Code execution failed:', execResult.error);
                this.stats.replErrors++;
                // Fallback to standard processing
                return this.process(query, llmCall, context);
            }

            // Step 5: Parse the final answer
            const finalAnswer = parseFinalAnswer(execResult);

            this.stats.replExecutions++;

            // Handle sub-LM calls if any
            if (finalAnswer.subLmCalls && finalAnswer.subLmCalls.length > 0) {
                console.log(`[RLM:REPL] Processing ${finalAnswer.subLmCalls.length} sub-LM calls...`);
                // Process sub-LM calls and aggregate results
                const subResults = await this._processSubLmCalls(finalAnswer.subLmCalls, llmCall, context);
                
                // Combine with the main answer
                let combinedAnswer = finalAnswer.answer || '';
                if (subResults.length > 0) {
                    combinedAnswer += '\n\n---\n\n**Additional Analysis:**\n\n';
                    combinedAnswer += subResults.map(r => r.response).join('\n\n');
                }
                finalAnswer.answer = combinedAnswer;
            }

            console.log(`[RLM:REPL] Complete in ${Date.now() - startTime}ms`);

            return {
                success: true,
                response: finalAnswer.answer || 'No result from code execution',
                metadata: {
                    rlmEnabled: true,
                    replUsed: true,
                    pipelineTime: Date.now() - startTime,
                    stdout: finalAnswer.stdout,
                    stderr: finalAnswer.stderr
                }
            };

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

    /**
     * Check if a query should use REPL execution
     * @param {string} query - User query
     * @returns {boolean}
     */
    shouldUseREPL(query) {
        if (!this.config.enableREPL) return false;
        if (!isREPLSupported()) return false;

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

        // Reset REPL if initialized
        if (this.repl) {
            this.repl.reset().catch(() => {});
        }

        this.stats = {
            queriesProcessed: 0,
            totalSubQueries: 0,
            avgExecutionTime: 0,
            strategies: {},
            replExecutions: 0,
            replErrors: 0
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

    // Code Generation
    CodeGenerator,
    createCodeGenerator,
    generateCodePrompt,
    parseCodeOutput,
    parseFinalAnswer,
    validateCode
};
