/**
 * RLM Evaluation Harness (Scaffold)
 *
 * Provides a lightweight rubric and scoring helpers for manual or
 * automated evaluation. Intended for offline evaluation runs and
 * regression comparisons.
 */

export const EVAL_RUBRIC = {
    coverage: {
        label: 'Coverage',
        description: 'Did the response address all requested topics or codes?',
        maxScore: 5
    },
    correctness: {
        label: 'Correctness',
        description: 'Are the facts accurate and aligned with the code sources?',
        maxScore: 5
    },
    formatCompliance: {
        label: 'Format Compliance',
        description: 'Did the response follow the requested format constraints?',
        maxScore: 5
    },
    attribution: {
        label: 'Attribution',
        description: 'Are sources or code references noted where applicable?',
        maxScore: 5
    }
};

export function scoreEvaluation(scores = {}) {
    const entries = Object.entries(EVAL_RUBRIC).map(([key, rubric]) => {
        const raw = Number.isFinite(scores[key]) ? scores[key] : 0;
        const value = Math.max(0, Math.min(rubric.maxScore, raw));
        return { key, value, max: rubric.maxScore };
    });

    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const maxTotal = entries.reduce((sum, entry) => sum + entry.max, 0);
    const percentage = maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0;

    return {
        total,
        maxTotal,
        percentage,
        breakdown: entries
    };
}

export function buildEvalReport({ query, response, scores = {}, notes = '' } = {}) {
    const scoring = scoreEvaluation(scores);
    return {
        query,
        response,
        scores,
        scoring,
        notes,
        createdAt: new Date().toISOString()
    };
}
