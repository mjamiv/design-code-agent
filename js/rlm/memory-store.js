/**
 * RLM Memory Store
 *
 * Stores structured memory slices and a compact state block (SWM).
 * Milestone 1: Capture memory without affecting prompt assembly.
 */

const MEMORY_TYPES = [
    'requirement',
    'parameter',
    'crossref',
    'compliance',
    'calculation',
    'conflict',
    'exception',
    'episode'
];

export class MemoryStore {
    constructor() {
        this.reset();
    }

    reset() {
        this.stateBlock = {
            requirements: [],
            parameters: [],
            crossReferences: [],
            compliance: [],
            calculations: [],
            conflicts: [],
            exceptions: []
        };

        this.workingWindow = {
            lastUserTurns: [],
            lastAssistantSummary: ''
        };

        this.slices = [];
        this.stats = {
            totalSlices: 0,
            lastCapturedAt: null
        };
        this.focus = {
            current: null,
            episodes: [],
            stats: {
                totalEpisodes: 0,
                lastStartedAt: null,
                lastCompletedAt: null,
                lastSummary: null
            }
        };
        this._idCounter = 0;
    }

    /**
     * Capture memory from an assistant completion.
     * @param {Object} payload
     * @param {string} payload.query
     * @param {string} payload.response
     * @param {Object} payload.metadata
     */
    captureCompletion({ query, response, metadata = {} }) {
        if (!query && !response) return;

        this._updateWorkingWindow(query, response);

        const extracted = this._extractStructuredSlices(response);
        const timestamp = new Date().toISOString();

        extracted.forEach(slice => {
            const entry = this._buildSliceEntry(slice, metadata, timestamp);

            this.slices.push(entry);
            this._mergeIntoStateBlock(entry);
        });

        this.stats.totalSlices = this.slices.length;
        this.stats.lastCapturedAt = timestamp;
    }

    getStateBlock() {
        return { ...this.stateBlock };
    }

    getWorkingWindow() {
        return { ...this.workingWindow };
    }

    getSlices() {
        return [...this.slices];
    }

    getStats() {
        return {
            ...this.stats,
            stateBlockSize: Object.values(this.stateBlock).reduce((sum, items) => sum + items.length, 0),
            focus: {
                ...this.focus.stats,
                active: Boolean(this.focus.current),
                currentLabel: this.focus.current?.label || null
            }
        };
    }

    /**
     * Focus Episode API (Milestone 3).
     * @param {string} label
     * @param {string} objective
     * @param {Object} metadata
     * @returns {Object|null}
     */
    startFocus(label, objective, metadata = {}) {
        if (this.focus.current) {
            return this.focus.current;
        }

        const startedAt = new Date().toISOString();
        const focusSession = {
            id: this._nextFocusId(),
            label,
            objective,
            startedAt,
            events: [],
            source_agent_ids: metadata.agentIds || [],
            source_tool_ids: metadata.toolIds || []
        };

        this.focus.current = focusSession;
        this.focus.stats.lastStartedAt = startedAt;
        return focusSession;
    }

    appendFocus(event, source = {}) {
        if (!this.focus.current || !event) {
            return null;
        }

        const entry = {
            id: `${this.focus.current.id}-evt-${this.focus.current.events.length + 1}`,
            event: typeof event === 'string' ? event : JSON.stringify(event),
            source,
            timestamp: new Date().toISOString()
        };

        this.focus.current.events.push(entry);
        return entry;
    }

    /**
     * Complete the current focus episode.
     * @param {Object} options
     * @param {string} options.reason
     * @param {boolean} options.persist
     * @param {Object} options.metadata
     * @returns {Object|null}
     */
    completeFocus({ reason = 'manual', persist = false, metadata = {} } = {}) {
        if (!this.focus.current) {
            return null;
        }

        const completedAt = new Date().toISOString();
        const current = this.focus.current;
        const eventText = current.events.map(item => item.event).join('\n');
        const combinedText = [current.label, current.objective, eventText].filter(Boolean).join('\n');
        const summary = this._summarizeResponse(combinedText);
        const extracted = this._extractStructuredSlices(combinedText);
        const grouped = this._groupSlicesByType(extracted);
        const learnedFacts = [...new Set(current.events.map(item => item.event).filter(Boolean))].slice(0, 5);

        const episodePayload = {
            id: current.id,
            label: current.label,
            objective: current.objective,
            reason,
            startedAt: current.startedAt,
            completedAt,
            episode_summary: summary,
            learned_facts: learnedFacts,
            requirements: grouped.requirements,
            parameters: grouped.parameters,
            cross_references: grouped.crossReferences,
            compliance: grouped.compliance,
            calculations: grouped.calculations,
            conflicts: grouped.conflicts,
            exceptions: grouped.exceptions,
            events: current.events
        };

        if (persist) {
            const entry = this._buildSliceEntry({
                type: 'episode',
                text: summary,
                tags: ['episode'],
                entities: this._extractEntities(summary),
                confidence: 0.6,
                importance: 0.6
            }, metadata, completedAt);
            this.slices.push(entry);

            extracted.forEach(slice => {
                if (slice.type === 'episode') return;
                const sliceEntry = this._buildSliceEntry(slice, metadata, completedAt);
                this.slices.push(sliceEntry);
                this._mergeIntoStateBlock(sliceEntry);
            });

            this.focus.episodes.push(episodePayload);
            this.stats.totalSlices = this.slices.length;
        }

        this.focus.stats.totalEpisodes = this.focus.episodes.length;
        this.focus.stats.lastCompletedAt = completedAt;
        this.focus.stats.lastSummary = summary;
        this.focus.current = null;

        return episodePayload;
    }

    /**
     * Retrieve memory slices relevant to a query (Milestone 2 shadow mode).
     * @param {string} query
     * @param {Object} options
     * @returns {{ slices: Array, stats: Object }}
     */
    retrieveSlices(query, options = {}) {
        const startedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        const {
            maxResults = 6,
            tags,
            entities,
            intentTags = [],
            intentBoost = 1,
            intentFilter = false,
            recencyWindowMs = null,
            maxPerTag = 2,
            maxPerAgent = 2,
            allowedAgentIds = null,
            updateStats = false,
            updateShadowStats = false,
            shadowMode = false
        } = options;

        const normalizedQuery = (query || '').toLowerCase();
        const queryTags = tags || this._inferTagsFromQuery(normalizedQuery);
        const normalizedIntentTags = Array.isArray(intentTags)
            ? intentTags.filter(Boolean)
            : [];
        const queryEntities = entities || this._extractEntities(query || '');
        const queryKeywords = this._extractKeywords(normalizedQuery);

        const now = Date.now();
        const candidates = this.slices.filter(slice => {
            if (recencyWindowMs && slice.timestamp) {
                const ageMs = now - Date.parse(slice.timestamp);
                if (!Number.isNaN(ageMs) && ageMs > recencyWindowMs) {
                    return false;
                }
            }

            if (allowedAgentIds && allowedAgentIds.length > 0) {
                const agentMatches = (slice.source_agent_ids || []).some(id => allowedAgentIds.includes(id));
                if (!agentMatches) return false;
            }

            if (queryTags.length > 0) {
                const tagMatches = (slice.tags || []).some(tag => queryTags.includes(tag));
                if (!tagMatches) return false;
            } else if (intentFilter && normalizedIntentTags.length > 0) {
                const intentMatches = (slice.tags || []).some(tag => normalizedIntentTags.includes(tag));
                if (!intentMatches) return false;
            }

            if (queryEntities.length > 0) {
                const entityMatches = (slice.entities || []).some(entity => queryEntities.includes(entity));
                if (!entityMatches) return false;
            }

            return true;
        });

        const redundancyCountSource = (shadowMode || !updateStats) ? 'shadow' : 'live';
        const redundancyCountField = redundancyCountSource === 'shadow'
            ? 'retrieval_count_shadow'
            : 'retrieval_count';
        const scored = candidates.map(slice => {
            const tagScore = (slice.tags || []).filter(tag => queryTags.includes(tag)).length * 2;
            const intentScore = normalizedIntentTags.length > 0
                ? (slice.tags || []).filter(tag => normalizedIntentTags.includes(tag)).length * intentBoost
                : 0;
            const entityScore = (slice.entities || []).filter(entity => queryEntities.includes(entity)).length * 2;
            const recencyScore = this._scoreRecency(slice.timestamp) * 1.5;
            const importanceScore = (slice.importance_score || 0) * 1.2;
            const keywordScore = this._scoreKeywordMatch(slice.text, queryKeywords);
            const redundancyPenalty = Math.min(2, (slice[redundancyCountField] || 0) * 0.15);

            return {
                ...slice,
                _score: tagScore + intentScore + entityScore + recencyScore + importanceScore + keywordScore - redundancyPenalty,
                _redundancyPenalty: redundancyPenalty
            };
        });

        scored.sort((a, b) => b._score - a._score);

        const selected = [];
        const seenHashes = new Set();
        const tagCounts = new Map();
        const agentCounts = new Map();

        scored.forEach(slice => {
            if (selected.length >= maxResults) return;
            if (seenHashes.has(slice.source_hash)) return;

            if (maxPerAgent && slice.source_agent_ids?.length) {
                const tooManyAgents = slice.source_agent_ids.some(agentId => (agentCounts.get(agentId) || 0) >= maxPerAgent);
                if (tooManyAgents) return;
            }

            if (maxPerTag && slice.tags?.length) {
                const tagLimitReached = slice.tags.every(tag => (tagCounts.get(tag) || 0) >= maxPerTag);
                if (tagLimitReached) return;
            }

            selected.push(slice);
            seenHashes.add(slice.source_hash);

            slice.tags?.forEach(tag => {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            });
            slice.source_agent_ids?.forEach(agentId => {
                agentCounts.set(agentId, (agentCounts.get(agentId) || 0) + 1);
            });
        });

        if (updateStats || updateShadowStats) {
            const retrievedAt = new Date().toISOString();
            selected.forEach(slice => {
                const target = this.slices.find(entry => entry.id === slice.id);
                if (!target) return;
                if (updateStats) {
                    target.retrieval_count += 1;
                    target.last_retrieved_at = retrievedAt;
                }
                if (updateShadowStats) {
                    target.retrieval_count_shadow = (target.retrieval_count_shadow || 0) + 1;
                    target.last_retrieved_shadow_at = retrievedAt;
                }
            });
        }

        const finishedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();

        return {
            slices: selected,
            stats: {
                queryTags,
                queryEntities,
                queryKeywords,
                candidateCount: candidates.length,
                selectedCount: selected.length,
                requestedK: maxResults,
                intentTags: normalizedIntentTags,
                intentBoost,
                intentFilter,
                recencyWindowMs,
                redundancyCountSource,
                latencyMs: Math.max(0, finishedAt - startedAt)
            }
        };
    }

    _buildSliceEntry(slice, metadata, timestamp) {
        return {
            id: this._nextId(),
            type: slice.type,
            text: slice.text,
            summary: slice.text,
            tags: slice.tags,
            entities: slice.entities,
            source_agent_ids: metadata.agentIds || [],
            source_tool_ids: metadata.toolIds || [],
            timestamp,
            recency_score: 1,
            importance_score: slice.importance,
            retrieval_count: 0,
            retrieval_count_shadow: 0,
            last_retrieved_at: null,
            last_retrieved_shadow_at: null,
            token_estimate: this._estimateTokens(slice.text),
            confidence: slice.confidence,
            source_hash: this._hashText(slice.text)
        };
    }

    _groupSlicesByType(slices) {
        const grouped = {
            requirements: [],
            parameters: [],
            crossReferences: [],
            compliance: [],
            calculations: [],
            conflicts: [],
            exceptions: []
        };

        slices.forEach(slice => {
            switch (slice.type) {
                case 'requirement':
                    grouped.requirements.push(slice.text);
                    break;
                case 'parameter':
                    grouped.parameters.push(slice.text);
                    break;
                case 'crossref':
                    grouped.crossReferences.push(slice.text);
                    break;
                case 'compliance':
                    grouped.compliance.push(slice.text);
                    break;
                case 'calculation':
                    grouped.calculations.push(slice.text);
                    break;
                case 'conflict':
                    grouped.conflicts.push(slice.text);
                    break;
                case 'exception':
                    grouped.exceptions.push(slice.text);
                    break;
                default:
                    break;
            }
        });

        return grouped;
    }

    _updateWorkingWindow(query, response) {
        if (query) {
            this.workingWindow.lastUserTurns = [query, ...this.workingWindow.lastUserTurns].slice(0, 2);
        }

        if (response) {
            this.workingWindow.lastAssistantSummary = this._summarizeResponse(response);
        }
    }

    _summarizeResponse(response) {
        if (!response) return '';
        const trimmed = response.replace(/\s+/g, ' ').trim();
        if (trimmed.length <= 320) return trimmed;
        const cutoff = trimmed.lastIndexOf('.', 320);
        if (cutoff > 120) {
            return trimmed.slice(0, cutoff + 1);
        }
        return trimmed.slice(0, 320) + '...';
    }

    _extractStructuredSlices(response) {
        if (!response) return [];

        const lines = response.split('\n').map(line => line.trim()).filter(Boolean);
        const buckets = {
            requirement: [],
            parameter: [],
            crossref: [],
            compliance: [],
            calculation: [],
            conflict: [],
            exception: []
        };

        let activeType = null;
        lines.forEach(line => {
            const headingMatch = line.match(/^(requirements?|parameters?|cross[-\s]?refs?|compliance|calculations?|conflicts?|exceptions?)[:\s-]*/i);
            if (headingMatch) {
                activeType = this._normalizeType(headingMatch[1]);
                const remainder = line.slice(headingMatch[0].length).trim();
                if (remainder) {
                    buckets[activeType].push(remainder);
                }
                return;
            }

            if (activeType && /^[-•\d]/.test(line)) {
                buckets[activeType].push(line.replace(/^[-•\d.\s]+/, '').trim());
                return;
            }

            activeType = null;
        });

        const slices = [];
        MEMORY_TYPES.forEach(type => {
            if (type === 'episode') return;
            const entries = buckets[type] || [];
            entries.forEach(text => {
                if (!text) return;
                slices.push({
                    type,
                    text,
                    tags: [type],
                    entities: this._extractEntities(text),
                    confidence: 0.6,
                    importance: this._importanceForType(type)
                });
            });
        });

        if (slices.length === 0) {
            const fallback = this._summarizeResponse(response);
            if (fallback) {
                slices.push({
                    type: 'episode',
                    text: fallback,
                    tags: ['episode'],
                    entities: this._extractEntities(fallback),
                    confidence: 0.4,
                    importance: 0.4
                });
            }
        }

        return slices;
    }

    _normalizeType(label) {
        const normalized = label.toLowerCase();
        if (normalized.startsWith('requirement')) return 'requirement';
        if (normalized.startsWith('parameter')) return 'parameter';
        if (normalized.startsWith('cross')) return 'crossref';
        if (normalized.startsWith('compliance')) return 'compliance';
        if (normalized.startsWith('calculation')) return 'calculation';
        if (normalized.startsWith('conflict')) return 'conflict';
        if (normalized.startsWith('exception')) return 'exception';
        return 'episode';
    }

    _mergeIntoStateBlock(entry) {
        const map = {
            requirement: 'requirements',
            parameter: 'parameters',
            crossref: 'crossReferences',
            compliance: 'compliance',
            calculation: 'calculations',
            conflict: 'conflicts',
            exception: 'exceptions'
        };
        const key = map[entry.type];
        if (!key) return;

        const existing = this.stateBlock[key];
        if (!existing.find(item => item.source_hash === entry.source_hash)) {
            existing.push({
                text: entry.text,
                confidence: entry.confidence,
                source_hash: entry.source_hash,
                timestamp: entry.timestamp
            });
        }
    }

    _importanceForType(type) {
        switch (type) {
            case 'requirement':
                return 0.9;
            case 'compliance':
                return 0.8;
            case 'parameter':
                return 0.7;
            case 'crossref':
                return 0.6;
            case 'conflict':
                return 0.5;
            case 'exception':
                return 0.4;
            default:
                return 0.3;
        }
    }

    _extractEntities(text) {
        if (!text) return [];
        const candidates = text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];
        return [...new Set(candidates)].slice(0, 8);
    }

    _extractKeywords(text) {
        if (!text) return [];
        const stopWords = new Set([
            'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
            'in', 'with', 'to', 'for', 'of', 'as', 'by', 'from', 'what',
            'where', 'when', 'why', 'how', 'who', 'about', 'can', 'could',
            'should', 'would', 'will', 'are', 'was', 'were', 'been', 'be',
            'have', 'has', 'had', 'do', 'does', 'did', 'this', 'that',
            'these', 'those', 'there', 'here', 'all', 'each', 'every',
            'both', 'few', 'more', 'most', 'other', 'some', 'such', 'than',
            'too', 'very', 'just', 'also', 'now', 'only', 'then', 'so'
        ]);

        return [...new Set(
            text.replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length > 2 && !stopWords.has(word))
        )];
    }

    _scoreKeywordMatch(text, keywords) {
        if (!text || keywords.length === 0) return 0;
        const lowerText = text.toLowerCase();
        let score = 0;
        keywords.forEach(keyword => {
            if (lowerText.includes(keyword)) {
                score += 0.5;
            }
        });
        return score;
    }

    _scoreRecency(timestamp) {
        if (!timestamp) return 0;
        const ageMs = Date.now() - Date.parse(timestamp);
        if (Number.isNaN(ageMs)) return 0;
        const days = ageMs / (1000 * 60 * 60 * 24);
        return Math.max(0, 1 - days / 30);
    }

    _inferTagsFromQuery(query) {
        if (!query) return [];
        const tags = [];
        if (/\bdecision(s)?\b/.test(query)) tags.push('decision');
        if (/\baction(s| items)?\b/.test(query)) tags.push('action');
        if (/\brisk(s)?\b/.test(query)) tags.push('risk');
        if (/\bconstraint(s)?\b/.test(query)) tags.push('constraint');
        if (/\bentit(y|ies)\b/.test(query)) tags.push('entity');
        if (/\bopen question(s)?\b/.test(query)) tags.push('open_question');
        if (/\bepisode(s)?\b/.test(query)) tags.push('episode');
        return tags;
    }

    _estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(text.length / 4);
    }

    _hashText(text) {
        let hash = 0;
        for (let i = 0; i < text.length; i += 1) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return `h${Math.abs(hash)}`;
    }

    _nextId() {
        this._idCounter += 1;
        return `mem-${Date.now()}-${this._idCounter}`;
    }

    _nextFocusId() {
        this._idCounter += 1;
        return `focus-${Date.now()}-${this._idCounter}`;
    }
}

let memoryStoreInstance = null;

export function getMemoryStore() {
    if (!memoryStoreInstance) {
        memoryStoreInstance = new MemoryStore();
    }
    return memoryStoreInstance;
}

export function resetMemoryStore() {
    memoryStoreInstance = new MemoryStore();
    return memoryStoreInstance;
}
