/**
 * RLM Response Aggregator
 *
 * Merges results from parallel sub-queries into a coherent final response.
 * Handles conflict resolution, deduplication, and synthesis.
 *
 * Future RLM expansion: This will support hierarchical aggregation from
 * recursive sub-calls at different depths.
 */

export class ResponseAggregator {
    constructor(options = {}) {
        this.options = {
            maxFinalLength: options.maxFinalLength || 4000,
            enableLLMSynthesis: options.enableLLMSynthesis !== false,
            deduplicationThreshold: options.deduplicationThreshold || 0.7,
            ...options
        };
    }

    /**
     * Aggregate execution results into final response
     * @param {Object} executionResult - Result from SubExecutor
     * @param {Object} decomposition - Original decomposition
     * @param {Function} llmCall - LLM function for synthesis (optional)
     * @param {Object} context - Additional context
     * @returns {Promise<Object>} Aggregated result
     */
    async aggregate(executionResult, decomposition, llmCall = null, context = {}) {
        const { results, strategy } = executionResult;
        const { originalQuery, classification } = decomposition;

        // Check for reduce result (already aggregated by map-reduce)
        const reduceResult = results.find(r => r.type === 'reduce' && r.isAggregation);
        if (reduceResult && reduceResult.response) {
            return {
                success: true,
                response: reduceResult.response,
                aggregationType: 'map-reduce',
                sources: results.filter(r => r.type !== 'reduce').map(r => ({
                    agentName: r.agentName,
                    queryId: r.queryId
                })),
                metadata: this._buildMetadata(executionResult, decomposition)
            };
        }

        // For other strategies, aggregate the results
        const successfulResults = results.filter(r => r.success && r.response);

        if (successfulResults.length === 0) {
            return {
                success: false,
                response: 'No results could be gathered from the available meetings.',
                aggregationType: 'none',
                metadata: this._buildMetadata(executionResult, decomposition)
            };
        }

        // Single result - return directly
        if (successfulResults.length === 1) {
            return {
                success: true,
                response: successfulResults[0].response,
                aggregationType: 'single',
                sources: [{
                    agentName: successfulResults[0].agentName,
                    queryId: successfulResults[0].queryId
                }],
                metadata: this._buildMetadata(executionResult, decomposition)
            };
        }

        // Multiple results - need aggregation
        if (this.options.enableLLMSynthesis && llmCall) {
            return await this._llmAggregate(
                successfulResults,
                originalQuery,
                classification,
                llmCall,
                context,
                executionResult,
                decomposition
            );
        } else {
            return this._simpleAggregate(
                successfulResults,
                originalQuery,
                executionResult,
                decomposition
            );
        }
    }

    /**
     * Use LLM to synthesize multiple results
     * @private
     */
    async _llmAggregate(results, originalQuery, classification, llmCall, context, executionResult, decomposition) {
        // Build context from all results
        const resultsContext = results.map((r, i) => {
            const source = r.agentName || `Source ${i + 1}`;
            return `[${source}]:\n${r.response}`;
        }).join('\n\n---\n\n');

        // Build synthesis prompt based on intent
        const synthesisPrompt = this._buildSynthesisPrompt(originalQuery, classification);

        try {
            const synthesizedResponse = await llmCall(
                synthesisPrompt,
                resultsContext,
                context
            );

            return {
                success: true,
                response: synthesizedResponse,
                aggregationType: 'llm-synthesis',
                sources: results.map(r => ({
                    agentName: r.agentName,
                    queryId: r.queryId
                })),
                metadata: this._buildMetadata(executionResult, decomposition)
            };
        } catch (error) {
            // Fallback to simple aggregation
            console.warn('LLM synthesis failed, falling back to simple aggregation:', error.message);
            return this._simpleAggregate(results, originalQuery, executionResult, decomposition);
        }
    }

    /**
     * Build synthesis prompt based on query intent
     * @private
     */
    _buildSynthesisPrompt(originalQuery, classification) {
        const basePrompt = `You are synthesizing information from multiple meeting sources to answer: "${originalQuery}"

Instructions:
- Combine the information coherently
- Resolve any conflicting information by noting the discrepancy
- Be concise but comprehensive
- Cite which meeting/source information came from when relevant
- Use bullet points for lists`;

        const intentSpecific = {
            'factual': '\n- Focus on providing a clear, factual answer',
            'comparative': '\n- Highlight similarities and differences between sources',
            'aggregative': '\n- Compile a complete list without duplicates',
            'analytical': '\n- Identify overarching patterns and themes',
            'temporal': '\n- Present information in chronological order if possible'
        };

        return basePrompt + (intentSpecific[classification?.intent] || '');
    }

    /**
     * Simple aggregation without LLM (fallback)
     * @private
     */
    _simpleAggregate(results, originalQuery, executionResult, decomposition) {
        // Deduplicate and format results
        const deduped = this._deduplicateResults(results);

        // Format as structured response
        const formattedParts = deduped.map(r => {
            const source = r.agentName || 'Meeting';
            return `**From ${source}:**\n${r.response}`;
        });

        const response = `Based on ${results.length} meetings:\n\n${formattedParts.join('\n\n---\n\n')}`;

        return {
            success: true,
            response: this._truncateIfNeeded(response),
            aggregationType: 'simple-merge',
            sources: results.map(r => ({
                agentName: r.agentName,
                queryId: r.queryId
            })),
            metadata: this._buildMetadata(executionResult, decomposition)
        };
    }

    /**
     * Deduplicate similar results
     * @private
     */
    _deduplicateResults(results) {
        if (results.length <= 1) return results;

        const deduped = [results[0]];

        for (let i = 1; i < results.length; i++) {
            const current = results[i];
            const isDuplicate = deduped.some(existing =>
                this._calculateSimilarity(existing.response, current.response) > this.options.deduplicationThreshold
            );

            if (!isDuplicate) {
                deduped.push(current);
            }
        }

        return deduped;
    }

    /**
     * Calculate text similarity (simple Jaccard-like)
     * @private
     */
    _calculateSimilarity(text1, text2) {
        const words1 = new Set(text1.toLowerCase().split(/\s+/));
        const words2 = new Set(text2.toLowerCase().split(/\s+/));

        const intersection = new Set([...words1].filter(w => words2.has(w)));
        const union = new Set([...words1, ...words2]);

        return intersection.size / union.size;
    }

    /**
     * Truncate response if too long
     * @private
     */
    _truncateIfNeeded(text) {
        if (text.length <= this.options.maxFinalLength) {
            return text;
        }

        return text.substring(0, this.options.maxFinalLength - 100) +
            '\n\n...[Response truncated for length]';
    }

    /**
     * Build metadata object
     * @private
     */
    _buildMetadata(executionResult, decomposition) {
        return {
            originalQuery: decomposition.originalQuery,
            strategy: executionResult.strategy,
            executionTime: executionResult.executionTime,
            totalSubQueries: decomposition.subQueries.length,
            successfulQueries: executionResult.results.filter(r => r.success).length,
            failedQueries: executionResult.results.filter(r => !r.success).length,
            classification: decomposition.classification,
            depth: executionResult.depth || 0,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Format aggregated response for display
     * @param {Object} aggregation - Result from aggregate()
     * @returns {string} Formatted response
     */
    formatForDisplay(aggregation) {
        let formatted = aggregation.response;

        // Add source attribution if multiple sources
        if (aggregation.sources && aggregation.sources.length > 1) {
            const sourceList = aggregation.sources
                .filter(s => s.agentName)
                .map(s => s.agentName)
                .join(', ');

            if (sourceList && !formatted.includes(sourceList)) {
                formatted += `\n\n*Sources: ${sourceList}*`;
            }
        }

        return formatted;
    }

    /**
     * Future RLM hook: Hierarchical aggregation from recursive calls
     * @param {Array} depthResults - Results from different recursion depths
     * @returns {Promise<Object>} Hierarchically aggregated result
     */
    async aggregateHierarchical(depthResults) {
        // Placeholder for full RLM implementation
        // In full RLM, this would aggregate results from depth=0, depth=1, etc.
        console.warn('aggregateHierarchical: Hierarchical aggregation not yet implemented');

        // For now, flatten and aggregate
        const flatResults = depthResults.flat();
        return {
            success: true,
            response: flatResults.map(r => r.response).join('\n\n'),
            aggregationType: 'flat-hierarchical',
            _futureFeature: true
        };
    }
}

// Factory function
export function createAggregator(options = {}) {
    return new ResponseAggregator(options);
}
