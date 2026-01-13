/**
 * RLM REPL Worker
 * 
 * Web Worker that runs Pyodide in an isolated sandbox for secure Python execution.
 * This worker handles all Python code execution, keeping it separate from the main thread.
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
    pyodideVersion: '0.25.0'
};

// Built-in Python helper functions injected into the namespace
const PYTHON_HELPERS = `
import re
import json

# RLM API Functions

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
    
    for agent in agents:
        matches = []
        for field in ['summary', 'keyPoints', 'actionItems', 'transcript']:
            content = agent.get(field, '')
            if content and keyword_lower in content.lower():
                # Extract excerpt around the match
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

def get_all_action_items():
    """Extract all action items from all agents."""
    agents = context.get('agents', [])
    all_items = []
    for agent in agents:
        if agent.get('enabled', True):
            items = agent.get('actionItems', '')
            if items:
                all_items.append({
                    'agent': agent.get('displayName', agent.get('title', 'Unknown')),
                    'items': items
                })
    return all_items

def get_all_summaries():
    """Get summaries from all enabled agents."""
    agents = context.get('agents', [])
    summaries = []
    for agent in agents:
        if agent.get('enabled', True):
            summaries.append({
                'agent': agent.get('displayName', agent.get('title', 'Unknown')),
                'date': agent.get('date'),
                'summary': agent.get('summary', '')
            })
    return summaries

# Placeholder for recursive LLM calls (implemented in main thread)
_pending_sub_lm_calls = []

def sub_lm(query, context_slice=None):
    """
    Queue a sub-LLM call for later execution.
    In full RLM, this spawns a recursive LLM call.
    Currently returns a placeholder that will be resolved by the main thread.
    """
    call_id = len(_pending_sub_lm_calls)
    _pending_sub_lm_calls.append({
        'id': call_id,
        'query': query,
        'context': context_slice
    })
    return f"[SUB_LM_PENDING:{call_id}]"

def get_pending_sub_lm_calls():
    """Get all pending sub-LLM calls for execution by main thread."""
    return _pending_sub_lm_calls.copy()

def clear_sub_lm_calls():
    """Clear pending sub-LLM calls."""
    global _pending_sub_lm_calls
    _pending_sub_lm_calls = []

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
                response = { success: true };
                break;
                
            case 'setContext':
                response = await setContext(params.context);
                break;
                
            case 'execute':
                response = await executeCode(params.code, params.timeout);
                break;
                
            case 'getVariable':
                response = await getVariable(params.name);
                break;
                
            case 'reset':
                response = await resetNamespace();
                break;
                
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
