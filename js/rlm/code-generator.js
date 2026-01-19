/**
 * RLM Code Generator
 * 
 * Generates prompts for the LLM to produce Python code that interacts with
 * the code context through the REPL environment.
 * 
 * Also handles parsing of LLM output to extract FINAL() and FINAL_VAR() calls.
 * 
 * Phase 2.1 additions:
 * - Query classification (factual, aggregative, comparative, search, recursive)
 * - Retry logic with error context
 * - Enhanced few-shot examples
 */

/**
 * Query types for classification
 */
export const QueryType = {
    FACTUAL: 'factual',
    AGGREGATIVE: 'aggregative',
    COMPARATIVE: 'comparative',
    SEARCH: 'search',
    RECURSIVE: 'recursive'
};

/**
 * Patterns for query classification
 */
const QUERY_PATTERNS = {
    [QueryType.COMPARATIVE]: [
        /compare|contrast|differ|versus|vs\.?|between/i,
        /how does .+ differ from/i,
        /what('s| is) the difference/i,
        /similarities and differences/i
    ],
    [QueryType.AGGREGATIVE]: [
        /all|every|across|summarize|summary|overall/i,
        /total|combined|aggregate|consolidate/i,
        /what (are|were) the .+ from (all|every)/i,
        /gather|collect|compile/i
    ],
    [QueryType.SEARCH]: [
        /search|find|look for|locate|where/i,
        /who (said|mentioned|discussed)/i,
        /when (was|did|were)/i,
        /any mention of/i,
        /grep|filter|extract/i
    ],
    [QueryType.RECURSIVE]: [
        /analyze|interpret|explain|why|how come/i,
        /pattern|trend|theme|insight/i,
        /what does .+ mean/i,
        /implications|conclusions|takeaways/i
    ]
};

/**
 * Classify a query into one of the query types
 * @param {string} query - User's question
 * @returns {Object} Classification result with type and confidence
 */
export function classifyQuery(query) {
    const scores = {};
    const normalizedQuery = query.toLowerCase();
    
    // Score each query type
    for (const [type, patterns] of Object.entries(QUERY_PATTERNS)) {
        scores[type] = 0;
        for (const pattern of patterns) {
            if (pattern.test(normalizedQuery)) {
                scores[type]++;
            }
        }
    }
    
    // Find the type with highest score
    let maxScore = 0;
    let bestType = QueryType.FACTUAL; // Default
    
    for (const [type, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            bestType = type;
        }
    }
    
    // Calculate confidence (0-1)
    const totalPatterns = Object.values(QUERY_PATTERNS).flat().length;
    const confidence = maxScore > 0 ? Math.min(maxScore / 3, 1) : 0.5;
    
    return {
        type: bestType,
        confidence,
        scores,
        suggestSubLm: bestType === QueryType.RECURSIVE && confidence > 0.6
    };
}

/**
 * System prompt for code generation
 */
export const CODE_GENERATION_SYSTEM_PROMPT = `You are an AI assistant that generates Python code to analyze engineering design code data.

## Available Context

The design code data is stored in a variable called \`context\` which is a dictionary with:
- \`context['agents']\`: List of code agent objects
- \`context['metadata']\`: Metadata about the loaded codes

Each agent in \`context['agents']\` has:
- \`id\`: Unique identifier
- \`displayName\`: Code name
- \`date\`: Imported date
- \`enabled\`: Whether the agent is active
- \`codeOverview\`: Scope and summary of the standard
- \`requirements\`: List of requirement objects
- \`designParameters\`: List of parameter objects
- \`crossReferences\`: List of cross-reference objects
- \`complianceNotes\`: List of compliance notes
- \`sourceText\`: Full source text (if available)

## Available Functions

\`\`\`python
# Text manipulation
partition(text, chunk_size=1000)  # Split text into chunks
grep(pattern, text)               # Regex search with context

# Agent queries
list_agents()                     # List all agents with IDs
get_agent(agent_id)               # Get specific agent by ID
search_agents(keyword)            # Search all agents for keyword
get_all_requirements()            # Get all requirements across codes
get_all_parameters()              # Get all design parameters across codes
get_all_crossrefs()               # Get all cross-references across codes

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

### Example 1: List all requirements
\`\`\`python
items = get_all_requirements()
result = "Requirements by Code:\\n"
for code in items:
    result += f"\\n## {code['agent']}\\n"
    for req in code['requirements']:
        result += f"- {req.get('id', '')} {req.get('text', '')}\\n"
FINAL(result)
\`\`\`

### Example 2: Search for a topic
\`\`\`python
results = search_agents("load factor")
if results:
    answer = f"Found {len(results)} codes mentioning 'load factor':\\n"
    for r in results:
        answer += f"\\n- {r['agent_name']}: {r['matches'][0]['excerpt']}"
else:
    answer = "No codes found mentioning 'load factor'"
FINAL(answer)
\`\`\`

### Example 3: Compare two codes
\`\`\`python
agents = list_agents()
if len(agents) >= 2:
    agent1 = get_agent(agents[0]['id'])
    agent2 = get_agent(agents[1]['id'])
    
    comparison = f"""Comparing codes:
    
## {agent1['displayName']}
{agent1['codeOverview']}

## {agent2['displayName']}
{agent2['codeOverview']}
"""
    FINAL(comparison)
else:
    FINAL("Need at least 2 codes to compare")
\`\`\`

### Example 4: Analyze patterns with sub-LLM
\`\`\`python
requirements = get_all_requirements()
combined = "\\n---\\n".join([f"{r['agent']}: {len(r['requirements'])} requirements" for r in requirements])
sub_lm("What patterns or conflicts emerge across these codes?", combined)
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
    factual: `# Answer a factual question about the codes
agents = [a for a in context['agents'] if a.get('enabled', True)]
relevant = []
for agent in agents:
    if 'keyword' in agent.get('codeOverview', '').lower():
        relevant.append(agent)

if relevant:
    answer = f"Found in {len(relevant)} codes: " + ", ".join([a['displayName'] for a in relevant])
else:
    answer = "Information not found in the codes"
FINAL(answer)`,

    aggregative: `# Aggregate requirements across all codes
items = get_all_requirements()
if not items:
    FINAL("No requirements found in any codes.")
else:
    result = f"## Requirements from {len(items)} codes:\\n"
    for item in items:
        result += f"\\n### {item['agent']}\\n"
        for req in item['requirements']:
            result += f"- {req.get('id', '')} {req.get('text', '')}\\n"
    FINAL(result)`,

    comparative: `# Compare information across codes
agents = [a for a in context['agents'] if a.get('enabled', True)]
if len(agents) < 2:
    FINAL("Need at least 2 codes to compare")
else:
    comparison = "# Code Comparison\\n"
    for agent in agents[:3]:  # Limit to 3 for brevity
        comparison += f"\\n## {agent['displayName']}\\n"
        comparison += f"**Overview:** {agent.get('codeOverview', 'N/A')[:300]}...\\n"
        comparison += f"**Requirements:** {len(agent.get('requirements', []))} items\\n"
    FINAL(comparison)`,

    search: `# Search for specific content
keyword = "target_keyword"
results = search_agents(keyword)

if results:
    answer = f"Found '{keyword}' in {len(results)} codes:\\n"
    for r in results:
        answer += f"\\n- **{r['agent_name']}**: {r['matches'][0]['excerpt']}"
    FINAL(answer)
else:
    FINAL(f"No mentions of '{keyword}' found in the codes")`,

    recursive: `# Analyze patterns using recursive LLM calls
requirements = get_all_requirements()
if not requirements:
    FINAL("No requirements available for analysis.")
else:
    combined = "\\n---\\n".join([f"**{r['agent']}**: {len(r['requirements'])} requirements" for r in requirements])
    analysis = sub_lm("Identify conflicts or overlaps across these codes. What insights emerge?", combined)
    result = f"# Pattern Analysis Across {len(requirements)} Codes\\n\\n{analysis}"
    FINAL(result)`
};

/**
 * Generate a code generation prompt for a user query
 * @param {string} query - User's question
 * @param {Object} context - Context metadata (agent count, etc.)
 * @returns {Object} System and user prompts with classification
 */
export function generateCodePrompt(query, context = {}) {
    const agentCount = context.activeAgents || 0;
    const agentNames = context.agentNames || [];
    
    // Classify the query to select appropriate example
    const classification = classifyQuery(query);
    const exampleCode = CODE_EXAMPLES[classification.type] || CODE_EXAMPLES.factual;
    
    // Build context summary for the prompt
    let contextSummary = `You have access to ${agentCount} code agents`;
    if (agentNames.length > 0) {
        contextSummary += `: ${agentNames.slice(0, 5).join(', ')}`;
        if (agentNames.length > 5) {
            contextSummary += `, and ${agentNames.length - 5} more`;
        }
    }
    
    // Build hints based on classification
    let strategyHint = '';
    switch (classification.type) {
        case QueryType.COMPARATIVE:
            strategyHint = 'This is a comparative query - compare data across multiple codes.';
            break;
        case QueryType.AGGREGATIVE:
            strategyHint = 'This is an aggregative query - gather and combine information from all codes.';
            break;
        case QueryType.SEARCH:
            strategyHint = 'This is a search query - use search_agents() to find relevant content.';
            break;
        case QueryType.RECURSIVE:
            strategyHint = 'This query requires analysis - consider using sub_lm() for deeper interpretation.';
            break;
        default:
            strategyHint = 'Answer the question directly using the available data.';
    }
    
    const userPrompt = `${contextSummary}.

${strategyHint}

User's question: ${query}

Here's an example of similar code:
\`\`\`python
${exampleCode}
\`\`\`

Now generate Python code to answer the user's question. Use the available context and functions.
Remember to call FINAL(answer) or FINAL_VAR(var_name) at the end.

\`\`\`python`;

    return {
        systemPrompt: CODE_GENERATION_SYSTEM_PROMPT,
        userPrompt,
        classification
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
            maxRetries: options.maxRetries || 2,
            ...options
        };
    }
    
    /**
     * Classify a query into a type
     * @param {string} query - User query
     * @returns {Object} Classification result
     */
    classifyQuery(query) {
        return classifyQuery(query);
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
     * Generate code with retry logic on validation failure
     * @param {string} query - User query
     * @param {Object} context - Context metadata
     * @param {Function} llmCall - LLM call function (systemPrompt, userPrompt, context) => response
     * @returns {Promise<Object>} Generated and validated code
     */
    async generateWithRetry(query, context, llmCall) {
        let lastError = null;
        let attempts = 0;
        
        while (attempts <= this.options.maxRetries) {
            attempts++;
            
            try {
                // Generate prompt (with error context if retrying)
                let prompts = this.generatePrompt(query, context);
                
                if (lastError && attempts > 1) {
                    // Add error context for retry
                    prompts.userPrompt = `${prompts.userPrompt}

IMPORTANT: Previous attempt failed with error: "${lastError}"
Please fix this issue in your code generation.`;
                }
                
                // Call LLM
                const llmResponse = await llmCall(prompts.systemPrompt, prompts.userPrompt, context);
                
                // Parse and validate
                const result = this.parseAndValidate(llmResponse);
                
                if (result.success) {
                    return {
                        ...result,
                        attempts,
                        classification: prompts.classification
                    };
                }
                
                // Store error for retry
                lastError = result.error;
                console.warn(`[CodeGenerator] Attempt ${attempts} failed: ${lastError}`);
                
            } catch (error) {
                lastError = error.message;
                console.warn(`[CodeGenerator] Attempt ${attempts} exception: ${lastError}`);
            }
        }
        
        // All retries exhausted
        return {
            success: false,
            error: `Failed after ${attempts} attempts. Last error: ${lastError}`,
            attempts
        };
    }
    
    /**
     * Get example code for a query type
     * @param {string} type - Query type (factual, aggregative, comparative, search, recursive)
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

// Re-export QueryType for external use
export { QueryType as CodeQueryType };
