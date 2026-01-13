/**
 * RLM REPL Environment
 * 
 * Main interface for the REPL environment. Manages the Web Worker,
 * handles communication, and provides a clean API for the RLM pipeline.
 * 
 * Usage:
 *   const repl = new REPLEnvironment();
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
    retryDelay: 1000
};

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
        
        // Event callbacks
        this.onReady = null;
        this.onError = null;
        this.onOutput = null;
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
            
            // Initialize Pyodide in the worker
            await this._sendMessage('init', {}, this.config.initTimeout);
            
            this.isInitialized = true;
            this.isInitializing = false;
            
            console.log('[REPL] Environment initialized successfully');
            
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
        
        console.log('[REPL] Environment terminated');
    }

    /**
     * Check if REPL is ready
     */
    isReady() {
        return this.isInitialized;
    }

    /**
     * Get current context
     */
    getContext() {
        return this.context;
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
