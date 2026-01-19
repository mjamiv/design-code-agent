/**
 * RLM REPL Worker
 * 
 * Web Worker that runs Pyodide in an isolated sandbox for secure Python execution.
 * This worker handles all Python code execution, keeping it separate from the main thread.
 * 
 * Phase 2.2: True Recursion Support
 * - SharedArrayBuffer for synchronous sub_lm() calls
 * - Atomics.wait for blocking until LLM response
 * - Depth tracking for recursion limits
 * 
 * Security measures:
 * - Runs in isolated Web Worker (no DOM access)
 * - Execution timeout protection
 * - Output truncation (max 10KB returned)
 * - No network access from Python (Pyodide limitation)
 */

// Pyodide instance
let pyodide = null;
let isInitialized = false;
let initializationPromise = null;

// Configuration
const CONFIG = {
    maxOutputLength: 10240,  // 10KB max output
    defaultTimeout: 30000,   // 30 seconds default timeout
    pyodideVersion: '0.25.0',
    maxRecursionDepth: 3,    // Max depth for sub_lm calls
    sharedBufferSize: 65536  // 64KB for response data
};

// SharedArrayBuffer for synchronous messaging (Phase 2.2)
let sharedBuffer = null;
let syncArray = null;      // Int32Array for signaling
let dataLengthArray = null; // Int32Array for response length
let responseBuffer = null; // Uint8Array for response data
let syncEnabled = false;

// Current recursion depth
let currentDepth = 0;
let subLmCallId = 0;

/**
 * Initialize SharedArrayBuffer for sync messaging
 * Called from main thread with the shared buffer
 */
function initSyncBuffer(buffer) {
    if (!buffer || !(buffer instanceof SharedArrayBuffer)) {
        console.warn('[REPL Worker] Invalid SharedArrayBuffer provided');
        syncEnabled = false;
        return { success: false, error: 'Invalid SharedArrayBuffer' };
    }
    
    sharedBuffer = buffer;
    // Layout: [0-3] = signal (Int32), [4-7] = data length (Int32), [8+] = response data
    syncArray = new Int32Array(sharedBuffer, 0, 1);
    dataLengthArray = new Int32Array(sharedBuffer, 4, 1);
    responseBuffer = new Uint8Array(sharedBuffer, 8);
    syncEnabled = true;
    
    console.log('[REPL Worker] Sync buffer initialized, size:', buffer.byteLength);
    return { success: true };
}

/**
 * Synchronous sub_lm call using Atomics.wait
 * Blocks until main thread provides response
 */
function subLmSync(query, contextSlice) {
    if (!syncEnabled) {
        // Fallback to async mode - return placeholder
        const id = subLmCallId++;
        return `[SUB_LM_PENDING:${id}] (sync not available)`;
    }
    
    // Check recursion depth
    if (currentDepth >= CONFIG.maxRecursionDepth) {
        throw new Error(`Max recursion depth (${CONFIG.maxRecursionDepth}) exceeded`);
    }
    
    currentDepth++;
    
    try {
        const id = subLmCallId++;
        
        // Reset signal
        Atomics.store(syncArray, 0, 0);
        
        // Send request to main thread
        self.postMessage({
            type: 'SUB_LM',
            id,
            query,
            context: contextSlice,
            depth: currentDepth
        });
        
        // Block until main thread signals completion
        // Timeout after 60 seconds
        const waitResult = Atomics.wait(syncArray, 0, 0, 60000);
        
        if (waitResult === 'timed-out') {
            throw new Error('sub_lm call timed out after 60 seconds');
        }
        
        // Read response length
        const responseLength = Atomics.load(dataLengthArray, 0);
        
        if (responseLength <= 0) {
            throw new Error('Empty response from sub_lm');
        }
        
        // Read response data
        const responseBytes = responseBuffer.slice(0, responseLength);
        const decoder = new TextDecoder();
        const response = decoder.decode(responseBytes);
        
        return response;
        
    } finally {
        currentDepth--;
    }
}

/**
 * Write string to response buffer (used by main thread)
 */
function writeResponseToBuffer(str) {
    if (!responseBuffer) return 0;
    
    const encoder = new TextEncoder();
    const encoded = encoder.encode(str);
    const maxLength = responseBuffer.length;
    const writeLength = Math.min(encoded.length, maxLength);
    
    responseBuffer.set(encoded.subarray(0, writeLength));
    return writeLength;
}

// Built-in Python helper functions injected into the namespace
const PYTHON_HELPERS = `
import re
import json

# RLM API Functions - Phase 2.2: True Recursion Support

# Recursion tracking
MAX_DEPTH = 3
_current_depth = 0

def partition(text, chunk_size=1000):
    """Split text into chunks of approximately chunk_size characters."""
    if not text:
        return []
    chunks = []
    words = text.split()
    current_chunk = []
    current_length = 0
    
    for word in words:
        word_length = len(word) + 1  # +1 for space
        if current_length + word_length > chunk_size and current_chunk:
            chunks.append(' '.join(current_chunk))
            current_chunk = [word]
            current_length = word_length
        else:
            current_chunk.append(word)
            current_length += word_length
    
    if current_chunk:
        chunks.append(' '.join(current_chunk))
    
    return chunks

def grep(pattern, text, flags=0):
    """Search for regex pattern in text, return all matches with context."""
    if not text:
        return []
    try:
        matches = []
        lines = text.split('\\n')
        compiled = re.compile(pattern, flags)
        for i, line in enumerate(lines):
            if compiled.search(line):
                # Include surrounding context (1 line before/after)
                start = max(0, i - 1)
                end = min(len(lines), i + 2)
                context = '\\n'.join(lines[start:end])
                matches.append({
                    'line_number': i + 1,
                    'line': line,
                    'context': context
                })
        return matches
    except re.error as e:
        return [{'error': str(e)}]

def search_agents(keyword, agents=None):
    """Search all agents for a keyword, return matching agents with excerpts."""
    if agents is None:
        agents = context.get('agents', [])
    
    keyword_lower = keyword.lower()
    results = []
    
    def _stringify_list(items, fields):
        lines = []
        for item in items or []:
            parts = []
            for field in fields:
                value = item.get(field)
                if value:
                    parts.append(str(value))
            if parts:
                lines.append(' '.join(parts))
        return '\\n'.join(lines)
    
    for agent in agents:
        matches = []
        field_map = {
            'codeOverview': agent.get('codeOverview', ''),
            'requirements': _stringify_list(agent.get('requirements', []), ['id', 'text', 'section', 'type']),
            'designParameters': _stringify_list(agent.get('designParameters', []), ['id', 'name', 'value', 'unit', 'section']),
            'crossReferences': _stringify_list(agent.get('crossReferences', []), ['source', 'target', 'relationship', 'note']),
            'complianceNotes': '\\n'.join(agent.get('complianceNotes', []) or []),
            'sourceText': agent.get('sourceText', '')
        }
        
        for field, content in field_map.items():
            if content and keyword_lower in content.lower():
                idx = content.lower().find(keyword_lower)
                start = max(0, idx - 50)
                end = min(len(content), idx + len(keyword) + 50)
                excerpt = content[start:end]
                if start > 0:
                    excerpt = '...' + excerpt
                if end < len(content):
                    excerpt = excerpt + '...'
                matches.append({'field': field, 'excerpt': excerpt})
        
        if matches:
            results.append({
                'agent_id': agent.get('id'),
                'agent_name': agent.get('displayName', agent.get('title', 'Unknown')),
                'matches': matches
            })
    
    return results

def get_agent(agent_id):
    """Get a specific agent by ID."""
    agents = context.get('agents', [])
    for agent in agents:
        if agent.get('id') == agent_id:
            return agent
    return None

def list_agents():
    """List all available agents with their IDs and names."""
    agents = context.get('agents', [])
    return [{'id': a.get('id'), 'name': a.get('displayName', a.get('title', 'Unknown')), 
             'date': a.get('date'), 'enabled': a.get('enabled', True)} for a in agents]

def get_all_requirements():
    """Get all requirements from all enabled agents."""
    agents = context.get('agents', [])
    requirements = []
    for agent in agents:
        if agent.get('enabled', True):
            for req in agent.get('requirements', []) or []:
                requirements.append({
                    'agent': agent.get('displayName', agent.get('title', 'Unknown')),
                    'id': req.get('id'),
                    'text': req.get('text'),
                    'section': req.get('section'),
                    'type': req.get('type'),
                    'keywords': req.get('keywords', [])
                })
    return requirements

def get_all_parameters():
    """Get all design parameters from all enabled agents."""
    agents = context.get('agents', [])
    parameters = []
    for agent in agents:
        if agent.get('enabled', True):
            for param in agent.get('designParameters', []) or []:
                parameters.append({
                    'agent': agent.get('displayName', agent.get('title', 'Unknown')),
                    'id': param.get('id'),
                    'name': param.get('name'),
                    'value': param.get('value'),
                    'unit': param.get('unit'),
                    'section': param.get('section'),
                    'applicability': param.get('applicability')
                })
    return parameters

def get_all_crossrefs():
    """Get all cross-references from all enabled agents."""
    agents = context.get('agents', [])
    crossrefs = []
    for agent in agents:
        if agent.get('enabled', True):
            for ref in agent.get('crossReferences', []) or []:
                crossrefs.append({
                    'agent': agent.get('displayName', agent.get('title', 'Unknown')),
                    'source': ref.get('source'),
                    'target': ref.get('target'),
                    'relationship': ref.get('relationship'),
                    'note': ref.get('note')
                })
    return crossrefs

def get_all_action_items():
    """Legacy helper mapped to requirements for backward compatibility."""
    return get_all_requirements()

def get_all_summaries():
    """Legacy helper mapped to code overviews for backward compatibility."""
    agents = context.get('agents', [])
    summaries = []
    for agent in agents:
        if agent.get('enabled', True):
            summaries.append({
                'agent': agent.get('displayName', agent.get('title', 'Unknown')),
                'date': agent.get('date'),
                'summary': agent.get('codeOverview', '')
            })
    return summaries

# Recursive LLM calls - Phase 2.2: True Synchronous Implementation
_pending_sub_lm_calls = []
_sub_lm_sync_func = None  # Will be set by JavaScript

def _register_sub_lm_sync(func):
    """Register the synchronous sub_lm function from JavaScript."""
    global _sub_lm_sync_func
    _sub_lm_sync_func = func

def sub_lm(query, context_slice=None):
    """
    Make a recursive LLM call synchronously.
    
    Args:
        query: Natural language question to ask
        context_slice: Optional context to include (will be JSON serialized)
    
    Returns:
        LLM response as string
    
    Raises:
        RecursionError: If max depth exceeded
        TimeoutError: If LLM call times out
    """
    global _current_depth, _sub_lm_sync_func
    
    # Check recursion depth
    if _current_depth >= MAX_DEPTH:
        raise RecursionError(f"Maximum recursion depth ({MAX_DEPTH}) exceeded")
    
    # Prepare context
    ctx = None
    if context_slice is not None:
        if isinstance(context_slice, str):
            ctx = context_slice
        else:
            ctx = json.dumps(context_slice)
    
    # Try synchronous call if available
    if _sub_lm_sync_func is not None:
        _current_depth += 1
        try:
            result = _sub_lm_sync_func(query, ctx)
            return result
        finally:
            _current_depth -= 1
    
    # Fallback to async mode (queue for later)
    call_id = len(_pending_sub_lm_calls)
    _pending_sub_lm_calls.append({
        'id': call_id,
        'query': query,
        'context': ctx
    })
    return f"[SUB_LM_PENDING:{call_id}] - sync mode not available, will be processed after execution"

def get_pending_sub_lm_calls():
    """Get all pending sub-LLM calls for execution by main thread."""
    return _pending_sub_lm_calls.copy()

def clear_sub_lm_calls():
    """Clear pending sub-LLM calls."""
    global _pending_sub_lm_calls
    _pending_sub_lm_calls = []

def get_recursion_depth():
    """Get current recursion depth."""
    return _current_depth

def reset_recursion_depth():
    """Reset recursion depth counter."""
    global _current_depth
    _current_depth = 0

# Final answer functions
_final_answer = None
_final_var_name = None

def FINAL(answer):
    """Mark the final answer to be returned."""
    global _final_answer
    _final_answer = answer
    return answer

def FINAL_VAR(var_name):
    """Mark a variable as containing the final answer."""
    global _final_var_name
    _final_var_name = var_name
    return f"[FINAL_VAR:{var_name}]"

def get_final_answer():
    """Get the final answer if set."""
    global _final_answer, _final_var_name
    if _final_answer is not None:
        return {'type': 'direct', 'value': _final_answer}
    if _final_var_name is not None:
        return {'type': 'variable', 'name': _final_var_name}
    return None

def reset_final():
    """Reset final answer state."""
    global _final_answer, _final_var_name
    _final_answer = None
    _final_var_name = None

# Initialize empty context
context = {}
`;

/**
 * Initialize Pyodide
 */
async function initializePyodide() {
    if (isInitialized) {
        return;
    }
    
    if (initializationPromise) {
        return initializationPromise;
    }
    
    initializationPromise = (async () => {
        try {
            // Import Pyodide - the script should be loaded before the worker
            importScripts(`https://cdn.jsdelivr.net/pyodide/v${CONFIG.pyodideVersion}/full/pyodide.js`);
            
            // Load Pyodide
            pyodide = await loadPyodide({
                indexURL: `https://cdn.jsdelivr.net/pyodide/v${CONFIG.pyodideVersion}/full/`
            });
            
            // Inject helper functions
            await pyodide.runPythonAsync(PYTHON_HELPERS);
            
            // Register the synchronous sub_lm function if sync is enabled
            if (syncEnabled) {
                registerSubLmSync();
            }
            
            isInitialized = true;
            console.log('[REPL Worker] Pyodide initialized successfully');
            
        } catch (error) {
            console.error('[REPL Worker] Failed to initialize Pyodide:', error);
            throw error;
        }
    })();
    
    return initializationPromise;
}

/**
 * Register the synchronous sub_lm JavaScript function with Python
 */
function registerSubLmSync() {
    if (!pyodide || !syncEnabled) {
        return;
    }
    
    try {
        // Create a JavaScript function that Python can call
        const subLmSyncWrapper = (query, contextSlice) => {
            return subLmSync(query, contextSlice);
        };
        
        // Register with Python
        pyodide.globals.set('_js_sub_lm_sync', subLmSyncWrapper);
        pyodide.runPython(`
_register_sub_lm_sync(_js_sub_lm_sync)
print("[Python] Synchronous sub_lm registered")
`);
        
        console.log('[REPL Worker] Synchronous sub_lm registered with Python');
        
    } catch (error) {
        console.error('[REPL Worker] Failed to register sub_lm sync:', error);
    }
}

/**
 * Set context in Python namespace
 */
async function setContext(contextData) {
    if (!isInitialized) {
        await initializePyodide();
    }
    
    // Convert to JSON and load into Python
    const contextJson = JSON.stringify(contextData);
    await pyodide.runPythonAsync(`
import json
context = json.loads('''${contextJson.replace(/'/g, "\\'")}''')
reset_final()
clear_sub_lm_calls()
`);
    
    return { success: true };
}

/**
 * Execute Python code with timeout
 */
async function executeCode(code, timeout = CONFIG.defaultTimeout) {
    if (!isInitialized) {
        await initializePyodide();
    }
    
    // Capture stdout
    let stdout = '';
    let stderr = '';
    
    // Set up output capture
    await pyodide.runPythonAsync(`
import sys
from io import StringIO
_stdout_capture = StringIO()
_stderr_capture = StringIO()
_original_stdout = sys.stdout
_original_stderr = sys.stderr
sys.stdout = _stdout_capture
sys.stderr = _stderr_capture
`);
    
    let result = null;
    let error = null;
    
    try {
        // Execute with timeout
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout);
        });
        
        const executionPromise = pyodide.runPythonAsync(code);
        
        result = await Promise.race([executionPromise, timeoutPromise]);
        
    } catch (err) {
        error = err.message || String(err);
    }
    
    // Capture output and restore stdout/stderr
    const outputResult = await pyodide.runPythonAsync(`
sys.stdout = _original_stdout
sys.stderr = _original_stderr
_stdout_output = _stdout_capture.getvalue()
_stderr_output = _stderr_capture.getvalue()
_stdout_capture.close()
_stderr_capture.close()
{'stdout': _stdout_output, 'stderr': _stderr_output}
`);
    
    stdout = outputResult.get('stdout') || '';
    stderr = outputResult.get('stderr') || '';
    
    // Get final answer if set
    const finalAnswerResult = await pyodide.runPythonAsync('get_final_answer()');
    let finalAnswer = null;
    if (finalAnswerResult) {
        finalAnswer = {
            type: finalAnswerResult.get('type'),
            value: finalAnswerResult.get('value'),
            name: finalAnswerResult.get('name')
        };
        
        // If it's a variable reference, get the actual value
        if (finalAnswer.type === 'variable' && finalAnswer.name) {
            try {
                const varValue = await pyodide.runPythonAsync(finalAnswer.name);
                finalAnswer.resolvedValue = pyodide.isPyProxy(varValue) 
                    ? varValue.toJs({ dict_converter: Object.fromEntries })
                    : varValue;
            } catch (e) {
                finalAnswer.resolvedValue = `[Error resolving variable: ${e.message}]`;
            }
        }
    }
    
    // Get pending sub-LM calls
    const pendingCalls = await pyodide.runPythonAsync('get_pending_sub_lm_calls()');
    const subLmCalls = pendingCalls ? pendingCalls.toJs() : [];
    
    // Truncate output if too long
    if (stdout.length > CONFIG.maxOutputLength) {
        stdout = stdout.substring(0, CONFIG.maxOutputLength) + '\n...[output truncated]';
    }
    if (stderr.length > CONFIG.maxOutputLength) {
        stderr = stderr.substring(0, CONFIG.maxOutputLength) + '\n...[output truncated]';
    }
    
    // Convert result if it's a PyProxy
    let resultValue = null;
    if (result !== null && result !== undefined) {
        if (pyodide.isPyProxy(result)) {
            try {
                resultValue = result.toJs({ dict_converter: Object.fromEntries });
            } catch {
                resultValue = String(result);
            }
        } else {
            resultValue = result;
        }
    }
    
    return {
        success: !error,
        result: resultValue,
        stdout,
        stderr,
        error,
        finalAnswer,
        subLmCalls
    };
}

/**
 * Get a variable from Python namespace
 */
async function getVariable(name) {
    if (!isInitialized) {
        throw new Error('REPL not initialized');
    }
    
    try {
        const result = await pyodide.runPythonAsync(name);
        
        if (pyodide.isPyProxy(result)) {
            return { success: true, value: result.toJs({ dict_converter: Object.fromEntries }) };
        }
        return { success: true, value: result };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Reset the Python namespace
 */
async function resetNamespace() {
    if (!isInitialized) {
        return { success: true };
    }
    
    // Re-inject helpers to reset state
    await pyodide.runPythonAsync(PYTHON_HELPERS);
    
    return { success: true };
}

/**
 * Message handler
 */
self.onmessage = async function(event) {
    const { id, type, ...params } = event.data;
    
    try {
        let response;
        
        switch (type) {
            case 'init':
                await initializePyodide();
                response = { success: true, syncEnabled };
                break;
            
            case 'initSync':
                // Initialize SharedArrayBuffer for synchronous sub_lm calls
                response = initSyncBuffer(params.buffer);
                // If Pyodide is already initialized, register the sync function
                if (isInitialized && syncEnabled) {
                    registerSubLmSync();
                }
                break;
                
            case 'setContext':
                response = await setContext(params.context);
                break;
                
            case 'execute':
                // Reset recursion depth before execution
                currentDepth = 0;
                subLmCallId = 0;
                if (pyodide) {
                    await pyodide.runPythonAsync('reset_recursion_depth()');
                }
                response = await executeCode(params.code, params.timeout);
                // Include sync mode info in response
                response.syncEnabled = syncEnabled;
                response.maxDepth = CONFIG.maxRecursionDepth;
                break;
                
            case 'getVariable':
                response = await getVariable(params.name);
                break;
                
            case 'reset':
                response = await resetNamespace();
                currentDepth = 0;
                subLmCallId = 0;
                break;
            
            case 'SUB_LM_RESPONSE':
                // Response to a sub_lm call - write to shared buffer and signal
                if (syncEnabled && responseBuffer) {
                    const encoder = new TextEncoder();
                    const encoded = encoder.encode(params.response || '');
                    const writeLength = Math.min(encoded.length, responseBuffer.length);
                    responseBuffer.set(encoded.subarray(0, writeLength));
                    Atomics.store(dataLengthArray, 0, writeLength);
                    Atomics.store(syncArray, 0, 1);
                    Atomics.notify(syncArray, 0);
                }
                // No response needed for this message type
                return;
                
            default:
                response = { success: false, error: `Unknown message type: ${type}` };
        }
        
        self.postMessage({ id, type: 'response', ...response });
        
    } catch (error) {
        self.postMessage({
            id,
            type: 'error',
            success: false,
            error: error.message || String(error)
        });
    }
};

// Signal that the worker is ready
self.postMessage({ type: 'ready' });
