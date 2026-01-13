/**
 * RLM Query Cache
 * 
 * LRU cache with TTL support for caching query results.
 * Reduces redundant LLM calls for repeated or similar queries.
 * 
 * Features:
 * - LRU (Least Recently Used) eviction policy
 * - TTL-based expiration
 * - Cache key generation from normalized query + agent context
 * - Optional fuzzy matching for similar queries
 * - Cache statistics tracking
 */

/**
 * Cache configuration defaults
 */
export const CACHE_CONFIG = {
    maxEntries: 50,           // Maximum cache entries
    defaultTTL: 5 * 60 * 1000, // 5 minutes in milliseconds
    enableFuzzyMatch: false,   // Enable similarity-based cache hits
    fuzzyThreshold: 0.85,      // Similarity threshold (0-1) for fuzzy matching
    normalizeQueries: true     // Normalize queries before caching
};

/**
 * Cache entry structure
 */
class CacheEntry {
    constructor(key, value, ttl) {
        this.key = key;
        this.value = value;
        this.createdAt = Date.now();
        this.lastAccessedAt = Date.now();
        this.expiresAt = Date.now() + ttl;
        this.hitCount = 0;
    }

    isExpired() {
        return Date.now() > this.expiresAt;
    }

    touch() {
        this.lastAccessedAt = Date.now();
        this.hitCount++;
    }
}

/**
 * Query Cache class
 */
export class QueryCache {
    constructor(config = {}) {
        this.config = { ...CACHE_CONFIG, ...config };
        this.cache = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            expirations: 0,
            fuzzyHits: 0
        };
    }

    /**
     * Generate a cache key from query and context
     * @param {string} query - The user query
     * @param {Array} activeAgentIds - IDs of active agents
     * @param {string} mode - Processing mode ('rlm' or 'repl')
     * @returns {string} Cache key
     */
    generateKey(query, activeAgentIds = [], mode = 'rlm') {
        // Normalize the query if enabled
        const normalizedQuery = this.config.normalizeQueries
            ? this._normalizeQuery(query)
            : query;

        // Sort agent IDs for consistent key generation
        const sortedAgentIds = [...activeAgentIds].sort().join(',');

        // Create composite key
        return `${mode}:${sortedAgentIds}:${normalizedQuery}`;
    }

    /**
     * Normalize a query for consistent caching
     * @private
     */
    _normalizeQuery(query) {
        return query
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')          // Collapse whitespace
            .replace(/[?!.]+$/g, '')       // Remove trailing punctuation
            .replace(/\b(please|can you|could you|would you)\b/gi, '') // Remove politeness
            .trim();
    }

    /**
     * Get a value from the cache
     * @param {string} key - Cache key
     * @returns {Object|null} Cached result or null if not found
     */
    get(key) {
        const entry = this.cache.get(key);

        if (!entry) {
            this.stats.misses++;
            return null;
        }

        // Check expiration
        if (entry.isExpired()) {
            this.cache.delete(key);
            this.stats.expirations++;
            this.stats.misses++;
            return null;
        }

        // Update LRU tracking
        entry.touch();
        this.stats.hits++;

        console.log(`[Cache] HIT for key: ${key.substring(0, 50)}...`);

        return entry.value;
    }

    /**
     * Try fuzzy match against cache entries
     * @param {string} query - Original query
     * @param {Array} activeAgentIds - Active agent IDs
     * @param {string} mode - Processing mode
     * @returns {Object|null} Best matching cached result or null
     */
    getFuzzy(query, activeAgentIds = [], mode = 'rlm') {
        if (!this.config.enableFuzzyMatch) {
            return null;
        }

        const normalizedQuery = this._normalizeQuery(query);
        const sortedAgentIds = [...activeAgentIds].sort().join(',');
        const prefix = `${mode}:${sortedAgentIds}:`;

        let bestMatch = null;
        let bestSimilarity = 0;

        for (const [key, entry] of this.cache.entries()) {
            // Skip if expired or different context
            if (entry.isExpired() || !key.startsWith(prefix)) {
                continue;
            }

            // Extract the query portion of the key
            const cachedQuery = key.substring(prefix.length);
            const similarity = this._calculateSimilarity(normalizedQuery, cachedQuery);

            if (similarity >= this.config.fuzzyThreshold && similarity > bestSimilarity) {
                bestMatch = entry;
                bestSimilarity = similarity;
            }
        }

        if (bestMatch) {
            bestMatch.touch();
            this.stats.hits++;
            this.stats.fuzzyHits++;
            console.log(`[Cache] FUZZY HIT (${(bestSimilarity * 100).toFixed(1)}% similarity)`);
            return bestMatch.value;
        }

        return null;
    }

    /**
     * Calculate similarity between two strings using Levenshtein distance
     * @private
     */
    _calculateSimilarity(str1, str2) {
        if (str1 === str2) return 1;
        if (!str1 || !str2) return 0;

        const len1 = str1.length;
        const len2 = str2.length;
        const maxLen = Math.max(len1, len2);

        if (maxLen === 0) return 1;

        // Simple Levenshtein distance
        const matrix = Array(len2 + 1).fill(null)
            .map(() => Array(len1 + 1).fill(null));

        for (let i = 0; i <= len1; i++) matrix[0][i] = i;
        for (let j = 0; j <= len2; j++) matrix[j][0] = j;

        for (let j = 1; j <= len2; j++) {
            for (let i = 1; i <= len1; i++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j][i - 1] + 1,     // Deletion
                    matrix[j - 1][i] + 1,     // Insertion
                    matrix[j - 1][i - 1] + cost // Substitution
                );
            }
        }

        const distance = matrix[len2][len1];
        return 1 - (distance / maxLen);
    }

    /**
     * Set a value in the cache
     * @param {string} key - Cache key
     * @param {Object} value - Value to cache
     * @param {number} ttl - Time-to-live in milliseconds (optional)
     */
    set(key, value, ttl = this.config.defaultTTL) {
        // Evict if at capacity
        if (this.cache.size >= this.config.maxEntries && !this.cache.has(key)) {
            this._evictLRU();
        }

        const entry = new CacheEntry(key, value, ttl);
        this.cache.set(key, entry);

        console.log(`[Cache] SET key: ${key.substring(0, 50)}... (TTL: ${ttl / 1000}s)`);
    }

    /**
     * Evict the least recently used entry
     * @private
     */
    _evictLRU() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastAccessedAt < oldestTime) {
                oldestTime = entry.lastAccessedAt;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.stats.evictions++;
            console.log(`[Cache] EVICT LRU entry: ${oldestKey.substring(0, 50)}...`);
        }
    }

    /**
     * Clear all cache entries
     */
    clear() {
        const size = this.cache.size;
        this.cache.clear();
        console.log(`[Cache] CLEARED ${size} entries`);
    }

    /**
     * Clear expired entries
     */
    clearExpired() {
        let cleared = 0;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.isExpired()) {
                this.cache.delete(key);
                cleared++;
                this.stats.expirations++;
            }
        }
        if (cleared > 0) {
            console.log(`[Cache] Cleared ${cleared} expired entries`);
        }
        return cleared;
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getStats() {
        const totalRequests = this.stats.hits + this.stats.misses;
        const hitRate = totalRequests > 0
            ? (this.stats.hits / totalRequests * 100).toFixed(1)
            : 0;

        return {
            ...this.stats,
            size: this.cache.size,
            maxSize: this.config.maxEntries,
            hitRate: `${hitRate}%`,
            totalRequests
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            expirations: 0,
            fuzzyHits: 0
        };
    }

    /**
     * Check if cache has a valid entry for key
     * @param {string} key - Cache key
     * @returns {boolean}
     */
    has(key) {
        const entry = this.cache.get(key);
        if (!entry) return false;
        if (entry.isExpired()) {
            this.cache.delete(key);
            this.stats.expirations++;
            return false;
        }
        return true;
    }

    /**
     * Get all cache entries (for debugging)
     * @returns {Array} Array of cache entry info
     */
    getEntries() {
        const entries = [];
        for (const [key, entry] of this.cache.entries()) {
            entries.push({
                key: key.substring(0, 80) + (key.length > 80 ? '...' : ''),
                isExpired: entry.isExpired(),
                hitCount: entry.hitCount,
                age: Math.round((Date.now() - entry.createdAt) / 1000) + 's',
                ttlRemaining: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)) + 's'
            });
        }
        return entries;
    }
}

// Singleton instance
let cacheInstance = null;

/**
 * Get or create the query cache instance
 * @param {Object} config - Optional configuration
 * @returns {QueryCache}
 */
export function getQueryCache(config = {}) {
    if (!cacheInstance) {
        cacheInstance = new QueryCache(config);
    }
    return cacheInstance;
}

/**
 * Reset the query cache
 * @param {Object} config - Optional new configuration
 * @returns {QueryCache}
 */
export function resetQueryCache(config = {}) {
    if (cacheInstance) {
        cacheInstance.clear();
    }
    cacheInstance = new QueryCache(config);
    return cacheInstance;
}
