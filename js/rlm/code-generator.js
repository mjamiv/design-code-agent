/**
 * RLM Code Generator
 * 
 * Generates prompts for the LLM to produce Python code that interacts with
 * the meeting context through the REPL environment.
 * 
 * Also handles parsing of LLM output to extract FINAL() and FINAL_VAR() calls.
 */

/**
 * System prompt for code generation
 */
export const CODE_GENERATION_SYSTEM_PROMPT = `You are an AI assistant that generates Python code to analyze meeting data.

## Available Context

The meeting data is stored in a variable called \`context\` which is a dictionary with:
- \`context['agents']\`: List of meeting agent objects
- \`context['metadata']\`: Metadata about the loaded meetings

Each agent in \`context['agents']\` has:
- \`id\`: Unique identifier
- \`displayName\`: Meeting name
- \`date\`: Meeting date
- \`enabled\`: Whether the agent is active
- \`summary\`: Executive summary
- \`keyPoints\`: Key discussion points
- \`actionItems\`: Action items from the meeting
- \`sentiment\`: Sentiment analysis
- \`transcript\`: Full transcript (if available)

## Available Functions

\`\`\`python
# Text manipulation
partition(text, chunk_size=1000)  # Split text into chunks
grep(pattern, text)               # Regex search with context

# Agent queries
list_agents()                     # List all agents with IDs
get_agent(agent_id)               # Get specific agent by ID
search_agents(keyword)            # Search all agents for keyword
get_all_action_items()            # Get all action items
get_all_summaries()               # Get all summaries

# Recursive LLM calls (for complex queries)
sub_lm(query, context_slice)      # Queue a sub-LLM call

# Final answer
FINAL(answer)                     # Return final answer directly
FINAL_VAR(var_name)               # Return variable as final answer
\`\`\`

## Output Format

Write Python code that:
1. Analyzes the context to answer the user's question
2. Stores intermediate results in variables
3. Calls FINAL(answer) or FINAL_VAR(var_name) with the final answer

## Examples

### Example 1: List all action items
\`\`\`python
items = get_all_action_items()
result = "Action Items by Meeting:\\n"
for meeting in items:
    result += f"\\n## {meeting['agent']}\\n{meeting['items']}\\n"
FINAL(result)
\`\`\`

### Example 2: Search for a topic
\`\`\`python
results = search_agents("budget")
if results:
    answer = f"Found {len(results)} meetings mentioning 'budget':\\n"
    for r in results:
        answer += f"\\n- {r['agent_name']}: {r['matches'][0]['excerpt']}"
else:
    answer = "No meetings found mentioning 'budget'"
FINAL(answer)
\`\`\`

### Example 3: Compare two meetings
\`\`\`python
agents = list_agents()
if len(agents) >= 2:
    agent1 = get_agent(agents[0]['id'])
    agent2 = get_agent(agents[1]['id'])
    
    comparison = f"""Comparing meetings:
    
## {agent1['displayName']}
{agent1['summary']}

## {agent2['displayName']}
{agent2['summary']}
"""
    FINAL(comparison)
else:
    FINAL("Need at least 2 meetings to compare")
\`\`\`

### Example 4: Analyze patterns with sub-LLM
\`\`\`python
# Get summaries for sub-LLM analysis
summaries = get_all_summaries()
combined = "\\n---\\n".join([f"{s['agent']}: {s['summary']}" for s in summaries])

# Queue sub-LLM call for pattern analysis
sub_lm("What patterns or themes emerge across these meetings?", combined)

# The main thread will execute the sub-LLM and return results
FINAL_VAR("combined")  # Fallback if sub-LLM not yet processed
\`\`\`

## Important Rules

1. Always call FINAL() or FINAL_VAR() at the end
2. Handle edge cases (empty lists, missing data)
3. Keep code concise and efficient
4. Use print() for debugging if needed
5. Don't modify the context variable
6. Return human-readable answers`;

/**
 * Few-shot examples for different query types
 */
export const CODE_EXAMPLES = {
    factual: `# Answer a factual question about the meetings
agents = [a for a in context['agents'] if a.get('enabled', True)]
relevant = []
for agent in agents:
    if 'keyword' in agent.get('summary', '').lower():
        relevant.append(agent)

if relevant:
    answer = f"Found in {len(relevant)} meetings: " + ", ".join([a['displayName'] for a in relevant])
else:
    answer = "Information not found in the meetings"
FINAL(answer)`,

    aggregative: `# Aggregate information across all meetings
items = []
for agent in context['agents']:
    if agent.get('enabled', True):
        items.append({
            'meeting': agent['displayName'],
            'summary': agent.get('summary', 'N/A')
        })

result = "Summary of all meetings:\\n"
for item in items:
    result += f"\\n## {item['meeting']}\\n{item['summary']}\\n"
FINAL(result)`,

    comparative: `# Compare information across meetings
agents = [a for a in context['agents'] if a.get('enabled', True)]
if len(agents) < 2:
    FINAL("Need at least 2 meetings to compare")
else:
    comparison = "Comparison:\\n"
    for agent in agents[:3]:  # Limit to 3 for brevity
        comparison += f"\\n### {agent['displayName']}\\n"
        comparison += f"Key Points: {agent.get('keyPoints', 'N/A')[:200]}...\\n"
    FINAL(comparison)`,

    search: `# Search for specific content
keyword = "target_keyword"
results = search_agents(keyword)

if results:
    answer = f"Found '{keyword}' in {len(results)} meetings:\\n"
    for r in results:
        answer += f"\\n- **{r['agent_name']}**: {r['matches'][0]['excerpt']}"
    FINAL(answer)
else:
    FINAL(f"No mentions of '{keyword}' found in the meetings")`
};

/**
 * Generate a code generation prompt for a user query
 * @param {string} query - User's question
 * @param {Object} context - Context metadata (agent count, etc.)
 * @returns {Object} System and user prompts
 */
export function generateCodePrompt(query, context = {}) {
    const agentCount = context.activeAgents || 0;
    const agentNames = context.agentNames || [];
    
    // Build context summary for the prompt
    let contextSummary = `You have access to ${agentCount} meeting agents`;
    if (agentNames.length > 0) {
        contextSummary += `: ${agentNames.slice(0, 5).join(', ')}`;
        if (agentNames.length > 5) {
            contextSummary += `, and ${agentNames.length - 5} more`;
        }
    }
    
    const userPrompt = `${contextSummary}.

User's question: ${query}

Generate Python code to answer this question using the available context and functions.
Remember to call FINAL(answer) or FINAL_VAR(var_name) at the end.

\`\`\`python`;

    return {
        systemPrompt: CODE_GENERATION_SYSTEM_PROMPT,
        userPrompt
    };
}

/**
 * Parse LLM output to extract Python code
 * @param {string} output - LLM response
 * @returns {Object} Parsed result with code and metadata
 */
export function parseCodeOutput(output) {
    const result = {
        hasCode: false,
        code: null,
        rawOutput: output,
        explanation: null
    };
    
    // Try to extract code from markdown code blocks
    const codeBlockMatch = output.match(/```python\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        result.hasCode = true;
        result.code = codeBlockMatch[1].trim();
        
        // Extract any explanation before the code block
        const beforeCode = output.substring(0, output.indexOf('```python'));
        if (beforeCode.trim()) {
            result.explanation = beforeCode.trim();
        }
        
        return result;
    }
    
    // Try plain code block
    const plainBlockMatch = output.match(/```\s*([\s\S]*?)```/);
    if (plainBlockMatch) {
        const code = plainBlockMatch[1].trim();
        // Check if it looks like Python
        if (code.includes('def ') || code.includes('import ') || 
            code.includes('FINAL') || code.includes('context')) {
            result.hasCode = true;
            result.code = code;
            return result;
        }
    }
    
    // Check if the entire output is code (no markdown)
    if (output.includes('FINAL(') || output.includes('FINAL_VAR(')) {
        result.hasCode = true;
        result.code = output.trim();
        return result;
    }
    
    return result;
}

/**
 * Parse execution result for final answer
 * @param {Object} execResult - Result from REPL execution
 * @returns {Object} Parsed final answer
 */
export function parseFinalAnswer(execResult) {
    const result = {
        hasAnswer: false,
        answer: null,
        type: null,
        subLmCalls: [],
        stdout: execResult.stdout || '',
        stderr: execResult.stderr || ''
    };
    
    // Check for sub-LM calls that need processing
    if (execResult.subLmCalls && execResult.subLmCalls.length > 0) {
        result.subLmCalls = execResult.subLmCalls;
    }
    
    // Check for final answer
    if (execResult.finalAnswer) {
        result.hasAnswer = true;
        result.type = execResult.finalAnswer.type;
        
        if (execResult.finalAnswer.type === 'direct') {
            result.answer = execResult.finalAnswer.value;
        } else if (execResult.finalAnswer.type === 'variable') {
            result.answer = execResult.finalAnswer.resolvedValue;
        }
        
        return result;
    }
    
    // Fallback: check stdout for answer
    if (execResult.stdout && execResult.stdout.trim()) {
        result.hasAnswer = true;
        result.answer = execResult.stdout.trim();
        result.type = 'stdout';
        return result;
    }
    
    // Fallback: check result value
    if (execResult.result !== null && execResult.result !== undefined) {
        result.hasAnswer = true;
        result.answer = String(execResult.result);
        result.type = 'result';
        return result;
    }
    
    return result;
}

/**
 * Validate generated code for safety
 * @param {string} code - Python code to validate
 * @returns {Object} Validation result
 */
export function validateCode(code) {
    const result = {
        isValid: true,
        warnings: [],
        errors: []
    };
    
    // Check for dangerous patterns
    const dangerousPatterns = [
        { pattern: /import\s+os/i, message: 'os module import not allowed' },
        { pattern: /import\s+sys/i, message: 'sys module import not allowed (use provided functions)' },
        { pattern: /import\s+subprocess/i, message: 'subprocess module not allowed' },
        { pattern: /open\s*\(/i, message: 'file operations not allowed' },
        { pattern: /exec\s*\(/i, message: 'exec() not allowed' },
        { pattern: /eval\s*\(/i, message: 'eval() not allowed' },
        { pattern: /__import__/i, message: '__import__() not allowed' },
        { pattern: /globals\s*\(\s*\)/i, message: 'globals() not allowed' },
        { pattern: /locals\s*\(\s*\)/i, message: 'locals() not allowed' }
    ];
    
    for (const { pattern, message } of dangerousPatterns) {
        if (pattern.test(code)) {
            result.isValid = false;
            result.errors.push(message);
        }
    }
    
    // Check for FINAL call
    if (!code.includes('FINAL(') && !code.includes('FINAL_VAR(')) {
        result.warnings.push('Code does not call FINAL() or FINAL_VAR() - may not return a result');
    }
    
    // Check for infinite loops (basic detection)
    if (code.includes('while True:') && !code.includes('break')) {
        result.warnings.push('Potential infinite loop detected');
    }
    
    return result;
}

/**
 * Code generator class for more complex scenarios
 */
export class CodeGenerator {
    constructor(options = {}) {
        this.options = {
            maxCodeLength: options.maxCodeLength || 2000,
            validateCode: options.validateCode !== false,
            ...options
        };
    }
    
    /**
     * Generate code for a query
     * @param {string} query - User query
     * @param {Object} context - Context metadata
     * @returns {Object} Generated prompts
     */
    generatePrompt(query, context = {}) {
        return generateCodePrompt(query, context);
    }
    
    /**
     * Parse and validate LLM output
     * @param {string} output - LLM response
     * @returns {Object} Parsed and validated code
     */
    parseAndValidate(output) {
        const parsed = parseCodeOutput(output);
        
        if (!parsed.hasCode) {
            return {
                success: false,
                error: 'No code found in LLM output',
                parsed
            };
        }
        
        if (this.options.validateCode) {
            const validation = validateCode(parsed.code);
            if (!validation.isValid) {
                return {
                    success: false,
                    error: 'Code validation failed: ' + validation.errors.join(', '),
                    parsed,
                    validation
                };
            }
            
            return {
                success: true,
                code: parsed.code,
                parsed,
                validation
            };
        }
        
        return {
            success: true,
            code: parsed.code,
            parsed
        };
    }
    
    /**
     * Get example code for a query type
     * @param {string} type - Query type (factual, aggregative, comparative, search)
     * @returns {string} Example code
     */
    getExample(type) {
        return CODE_EXAMPLES[type] || CODE_EXAMPLES.factual;
    }
}

// Factory function
export function createCodeGenerator(options = {}) {
    return new CodeGenerator(options);
}
