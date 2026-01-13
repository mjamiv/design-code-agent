/**
 * RLM REPL Environment
 * 
 * Main interface for the REPL environment. Manages the Web Worker,
 * handles communication, and provides a clean API for the RLM pipeline.
 * 
 * Phase 2.2: True Recursion Support
 * - SharedArrayBuffer for synchronous sub_lm() calls
 * - LLM callback for handling recursive calls
 * - Depth tracking and limits
 * 
 * Usage:
 *   const repl = new REPLEnvironment();
 *   repl.setLLMCallback(async (query, context) => { ... });
 *   await repl.initialize();
 *   await repl.setContext(agents);
 *   const result = await repl.execute('print(list_agents())');
 */

/**
 * Configuration for the REPL environment
 */
export const REPL_CONFIG = {
    workerPath: './repl-worker.js',
    defaultTimeout: 30000,      // 30 seconds
    initTimeout: 60000,         // 60 seconds for Pyodide initialization
    maxRetries: 2,
    retryDelay: 1000,
    sharedBufferSize: 65536,    // 64KB for sub_lm responses
    maxRecursionDepth: 3,       // Max depth for sub_lm calls
    subLmTimeout: 60000         // Timeout for individual sub_lm calls
};

/**
 * Check if SharedArrayBuffer is supported
 * Requires HTTPS and proper COOP/COEP headers
 */
export function isSharedArrayBufferSupported() {
    try {
        return typeof SharedArrayBuffer !== 'undefined' &&
               typeof Atomics !== 'undefined';
    } catch {
        return false;
    }
}

/**
 * REPL Environment class
 */
export class REPLEnvironment {
    constructor(config = {}) {
        this.config = { ...REPL_CONFIG, ...config };
        this.worker = null;
        this.isInitialized = false;
        this.isInitializing = false;
        this.pendingMessages = new Map();
        this.messageId = 0;
        this.context = null;
        
        // Phase 2.2: Sync support for sub_lm
        this.sharedBuffer = null;
        this.syncArray = null;
        this.dataLengthArray = null;
        this.responseBuffer = null;
        this.syncEnabled = false;
        
        // LLM callback for sub_lm calls
        this.llmCallback = null;
        this.subLmStats = {
            totalCalls: 0,
            successfulCalls: 0,
            failedCalls: 0,
            totalTime: 0
        };
        
        // Event callbacks
        this.onReady = null;
        this.onError = null;
        this.onOutput = null;
        this.onSubLmCall = null;      // Called when sub_lm is invoked (deprecated, use onSubLmStart)
        
        // Phase 3.2: Enhanced progress callbacks for sub_lm
        this.onSubLmStart = null;     // Called when sub_lm starts: (id, query, depth) => void
        this.onSubLmComplete = null;  // Called when sub_lm completes: (id, success, duration) => void
    }
    
    /**
     * Set the LLM callback for handling sub_lm calls
     * @param {Function} callback - async (query, context) => response
     */
    setLLMCallback(callback) {
        this.llmCallback = callback;
    }

    /**
     * Initialize the REPL environment
     * Loads Pyodide in the Web Worker
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }
        
        if (this.isInitializing) {
            // Wait for existing initialization
            return new Promise((resolve, reject) => {
                const checkInterval = setInterval(() => {
                    if (this.isInitialized) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
                
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error('Initialization timeout'));
                }, this.config.initTimeout);
            });
        }
        
        this.isInitializing = true;
        
        try {
            // Create the worker
            // Use absolute path from js/rlm/ directory
            const workerUrl = new URL(this.config.workerPath, import.meta.url);
            this.worker = new Worker(workerUrl);
            
            // Set up message handler
            this.worker.onmessage = (event) => this._handleMessage(event);
            this.worker.onerror = (error) => this._handleError(error);
            
            // Wait for worker ready signal
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Worker ready timeout'));
                }, 5000);
                
                const originalHandler = this.worker.onmessage;
                this.worker.onmessage = (event) => {
                    if (event.data.type === 'ready') {
                        clearTimeout(timeout);
                        this.worker.onmessage = originalHandler;
                        resolve();
                    }
                };
            });
            
            // Phase 2.2: Set up SharedArrayBuffer for sync sub_lm calls
            this._initSyncBuffer();
            
            // Initialize Pyodide in the worker
            const initResult = await this._sendMessage('init', {}, this.config.initTimeout);
            
            // Send sync buffer to worker if available
            if (this.syncEnabled) {
                try {
                    await this._sendMessage('initSync', { buffer: this.sharedBuffer }, 5000);
                    console.log('[REPL] Sync buffer initialized for sub_lm support');
                } catch (err) {
                    console.warn('[REPL] Failed to initialize sync buffer:', err.message);
                    this.syncEnabled = false;
                }
            }
            
            this.isInitialized = true;
            this.isInitializing = false;
            
            console.log('[REPL] Environment initialized successfully', {
                syncEnabled: this.syncEnabled,
                maxDepth: this.config.maxRecursionDepth
            });
            
            if (this.onReady) {
                this.onReady();
            }
            
        } catch (error) {
            this.isInitializing = false;
            console.error('[REPL] Initialization failed:', error);
            throw error;
        }
    }
    
    /**
     * Initialize SharedArrayBuffer for sync messaging
     * @private
     */
    _initSyncBuffer() {
        if (!isSharedArrayBufferSupported()) {
            console.warn('[REPL] SharedArrayBuffer not supported - sub_lm will use async fallback');
            this.syncEnabled = false;
            return;
        }
        
        try {
            // Layout: [0-3] = signal (Int32), [4-7] = data length (Int32), [8+] = response data
            this.sharedBuffer = new SharedArrayBuffer(this.config.sharedBufferSize);
            this.syncArray = new Int32Array(this.sharedBuffer, 0, 1);
            this.dataLengthArray = new Int32Array(this.sharedBuffer, 4, 1);
            this.responseBuffer = new Uint8Array(this.sharedBuffer, 8);
            this.syncEnabled = true;
            
            console.log('[REPL] SharedArrayBuffer initialized:', this.config.sharedBufferSize, 'bytes');
            
        } catch (error) {
            console.warn('[REPL] Failed to create SharedArrayBuffer:', error.message);
            this.syncEnabled = false;
        }
    }

    /**
     * Set the context (meeting agents) in the Python environment
     * @param {Array} agents - Array of agent objects
     */
    async setContext(agents) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        // Transform agents to Python-friendly format
        const contextData = {
            agents: agents.map(agent => ({
                id: agent.id,
                displayName: agent.displayName || agent.title,
                title: agent.title,
                date: agent.date,
                sourceType: agent.sourceType,
                enabled: agent.enabled !== false,
                summary: agent.summary || '',
                keyPoints: agent.keyPoints || '',
                actionItems: agent.actionItems || '',
                sentiment: agent.sentiment || '',
                transcript: agent.transcript || ''
            })),
            metadata: {
                totalAgents: agents.length,
                activeAgents: agents.filter(a => a.enabled !== false).length,
                loadedAt: new Date().toISOString()
            }
        };
        
        this.context = contextData;
        
        const result = await this._sendMessage('setContext', { context: contextData });
        
        console.log(`[REPL] Context set with ${contextData.agents.length} agents`);
        
        return result;
    }

    /**
     * Execute Python code
     * @param {string} code - Python code to execute
     * @param {number} timeout - Execution timeout in ms
     * @returns {Promise<Object>} Execution result
     */
    async execute(code, timeout = this.config.defaultTimeout) {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        console.log('[REPL] Executing code:', code.substring(0, 100) + (code.length > 100 ? '...' : ''));
        
        const result = await this._sendMessage('execute', { code, timeout }, timeout + 5000);
        
        // Log output if callback is set
        if (this.onOutput && (result.stdout || result.stderr)) {
            this.onOutput({
                stdout: result.stdout,
                stderr: result.stderr
            });
        }
        
        return result;
    }

    /**
     * Get a variable from the Python namespace
     * @param {string} name - Variable name
     * @returns {Promise<any>} Variable value
     */
    async getVariable(name) {
        if (!this.isInitialized) {
            throw new Error('REPL not initialized');
        }
        
        const result = await this._sendMessage('getVariable', { name });
        
        if (!result.success) {
            throw new Error(result.error || 'Failed to get variable');
        }
        
        return result.value;
    }

    /**
     * Reset the Python namespace
     */
    async reset() {
        if (!this.isInitialized) {
            return;
        }
        
        await this._sendMessage('reset', {});
        this.context = null;
        
        console.log('[REPL] Namespace reset');
    }

    /**
     * Terminate the REPL environment
     */
    terminate() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        
        this.isInitialized = false;
        this.isInitializing = false;
        this.pendingMessages.clear();
        this.context = null;
        
        // Clean up sync buffers
        this.sharedBuffer = null;
        this.syncArray = null;
        this.dataLengthArray = null;
        this.responseBuffer = null;
        this.syncEnabled = false;
        
        console.log('[REPL] Environment terminated');
    }

    /**
     * Check if REPL is ready
     */
    isReady() {
        return this.isInitialized;
    }
    
    /**
     * Check if synchronous sub_lm is enabled
     */
    isSyncEnabled() {
        return this.syncEnabled;
    }

    /**
     * Get current context
     */
    getContext() {
        return this.context;
    }
    
    /**
     * Get environment capabilities
     */
    getCapabilities() {
        return {
            isReady: this.isInitialized,
            syncEnabled: this.syncEnabled,
            sharedArrayBufferSupported: isSharedArrayBufferSupported(),
            maxRecursionDepth: this.config.maxRecursionDepth,
            hasLLMCallback: !!this.llmCallback
        };
    }

    /**
     * Send a message to the worker and wait for response
     * @private
     */
    _sendMessage(type, params = {}, timeout = this.config.defaultTimeout) {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId;
            
            const timeoutHandle = setTimeout(() => {
                this.pendingMessages.delete(id);
                reject(new Error(`Message ${type} timed out after ${timeout}ms`));
            }, timeout);
            
            this.pendingMessages.set(id, {
                resolve: (result) => {
                    clearTimeout(timeoutHandle);
                    this.pendingMessages.delete(id);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timeoutHandle);
                    this.pendingMessages.delete(id);
                    reject(error);
                }
            });
            
            this.worker.postMessage({ id, type, ...params });
        });
    }

    /**
     * Handle messages from the worker
     * @private
     */
    _handleMessage(event) {
        const { id, type, ...data } = event.data;
        
        if (type === 'ready') {
            // Initial ready signal, handled in initialize()
            return;
        }
        
        // Phase 2.2: Handle SUB_LM requests from worker
        if (type === 'SUB_LM') {
            this._handleSubLmRequest(data);
            return;
        }
        
        const pending = this.pendingMessages.get(id);
        if (pending) {
            if (type === 'error') {
                pending.reject(new Error(data.error || 'Worker error'));
            } else {
                pending.resolve(data);
            }
        }
    }
    
    /**
     * Handle sub_lm request from worker
     * Makes LLM call and writes response to shared buffer
     * @private
     */
    async _handleSubLmRequest(data) {
        const { id, query, context: contextSlice, depth } = data;
        const startTime = Date.now();
        
        this.subLmStats.totalCalls++;
        
        console.log(`[REPL] sub_lm request #${id} at depth ${depth}:`, query.substring(0, 50) + '...');
        
        // Phase 3.2: Emit start callback for UI progress
        if (this.onSubLmStart) {
            try {
                this.onSubLmStart({
                    id,
                    query,
                    depth,
                    context: contextSlice ? contextSlice.substring(0, 100) + '...' : null
                });
            } catch (e) {
                console.warn('[REPL] onSubLmStart callback error:', e);
            }
        }
        
        // Legacy callback (deprecated but still supported)
        if (this.onSubLmCall) {
            this.onSubLmCall({ id, query, context: contextSlice, depth });
        }
        
        let response = '';
        let success = false;
        
        try {
            if (!this.llmCallback) {
                throw new Error('No LLM callback configured for sub_lm calls');
            }
            
            // Make the LLM call
            response = await Promise.race([
                this.llmCallback(query, contextSlice),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('sub_lm timeout')), this.config.subLmTimeout)
                )
            ]);
            
            this.subLmStats.successfulCalls++;
            this.subLmStats.totalTime += Date.now() - startTime;
            success = true;
            
            console.log(`[REPL] sub_lm #${id} completed in ${Date.now() - startTime}ms`);
            
        } catch (error) {
            console.error(`[REPL] sub_lm #${id} failed:`, error.message);
            this.subLmStats.failedCalls++;
            response = `[Error: ${error.message}]`;
            success = false;
        }
        
        const duration = Date.now() - startTime;
        
        // Phase 3.2: Emit complete callback for UI progress
        if (this.onSubLmComplete) {
            try {
                this.onSubLmComplete({
                    id,
                    success,
                    duration,
                    depth,
                    responseLength: response.length
                });
            } catch (e) {
                console.warn('[REPL] onSubLmComplete callback error:', e);
            }
        }
        
        // Write response to shared buffer and signal worker
        if (this.syncEnabled && this.responseBuffer) {
            const encoder = new TextEncoder();
            const encoded = encoder.encode(response);
            const writeLength = Math.min(encoded.length, this.responseBuffer.length);
            
            this.responseBuffer.set(encoded.subarray(0, writeLength));
            Atomics.store(this.dataLengthArray, 0, writeLength);
            Atomics.store(this.syncArray, 0, 1);
            Atomics.notify(this.syncArray, 0);
        } else {
            // Fallback: send response as message (async mode)
            this.worker.postMessage({
                type: 'SUB_LM_RESPONSE',
                id,
                response
            });
        }
    }
    
    /**
     * Get sub_lm statistics
     */
    getSubLmStats() {
        return {
            ...this.subLmStats,
            avgTime: this.subLmStats.successfulCalls > 0 
                ? Math.round(this.subLmStats.totalTime / this.subLmStats.successfulCalls)
                : 0
        };
    }

    /**
     * Handle worker errors
     * @private
     */
    _handleError(error) {
        console.error('[REPL] Worker error:', error);
        
        if (this.onError) {
            this.onError(error);
        }
        
        // Reject all pending messages
        for (const [id, pending] of this.pendingMessages) {
            pending.reject(new Error('Worker error: ' + error.message));
        }
        this.pendingMessages.clear();
    }
}

// Singleton instance
let replInstance = null;

/**
 * Get or create the REPL environment instance
 * @param {Object} config - Optional configuration
 * @returns {REPLEnvironment}
 */
export function getREPLEnvironment(config = {}) {
    if (!replInstance) {
        replInstance = new REPLEnvironment(config);
    }
    return replInstance;
}

/**
 * Reset the REPL environment
 * @param {Object} config - Optional new configuration
 * @returns {REPLEnvironment}
 */
export function resetREPLEnvironment(config = {}) {
    if (replInstance) {
        replInstance.terminate();
    }
    replInstance = new REPLEnvironment(config);
    return replInstance;
}

/**
 * Check if REPL is supported in this environment
 * @returns {boolean}
 */
export function isREPLSupported() {
    return typeof Worker !== 'undefined';
}
