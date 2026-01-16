/**
 * RLM Shadow Prompt Builder
 *
 * Builds a prompt assembly for retrieval experiments without
 * impacting live LLM calls (shadow mode).
 */

const DEFAULT_SYSTEM_INSTRUCTIONS = `You are a helpful meeting assistant.
Use the provided context slices to answer the user query accurately.`;

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

function formatStateBlock(stateBlock) {
    if (!stateBlock) return '';

    const sections = [];
    const addSection = (label, items) => {
        if (!items || items.length === 0) return;
        sections.push(`${label}:\n${items.map(item => `- ${item.text}`).join('\n')}`);
    };

    addSection('Decisions', stateBlock.decisions);
    addSection('Actions', stateBlock.actions);
    addSection('Risks', stateBlock.risks);
    addSection('Entities', stateBlock.entities);
    addSection('Constraints', stateBlock.constraints);
    addSection('Open Questions', stateBlock.openQuestions);

    return sections.join('\n\n');
}

function formatWorkingWindow(workingWindow) {
    if (!workingWindow) return '';
    const parts = [];
    if (workingWindow.lastUserTurns?.length) {
        parts.push(`Recent User Turns:\n${workingWindow.lastUserTurns.map(turn => `- ${turn}`).join('\n')}`);
    }
    if (workingWindow.lastAssistantSummary) {
        parts.push(`Last Assistant Summary:\n${workingWindow.lastAssistantSummary}`);
    }
    return parts.join('\n\n');
}

function formatRetrievedSlices(retrievedSlices) {
    if (!retrievedSlices || retrievedSlices.length === 0) return '';
    return retrievedSlices.map((slice, index) => {
        const score = typeof slice._score === 'number' ? ` (score: ${slice._score.toFixed(2)})` : '';
        return `${index + 1}. [${slice.type}]${score} ${slice.text}`;
    }).join('\n');
}

export function buildShadowPrompt({
    query,
    stateBlock,
    workingWindow,
    retrievedSlices,
    localContext = '',
    systemInstructions = DEFAULT_SYSTEM_INSTRUCTIONS
}) {
    const sections = [];

    const systemSection = systemInstructions.trim();
    if (systemSection) {
        sections.push({
            label: 'System',
            content: systemSection
        });
    }

    const taskSection = `Task: Answer the user query.\nUser Query: ${query}`.trim();
    sections.push({
        label: 'Task',
        content: taskSection
    });

    const stateContent = formatStateBlock(stateBlock);
    if (stateContent) {
        sections.push({
            label: 'State Block',
            content: stateContent
        });
    }

    const workingContent = formatWorkingWindow(workingWindow);
    if (workingContent) {
        sections.push({
            label: 'Working Window',
            content: workingContent
        });
    }

    const retrievedContent = formatRetrievedSlices(retrievedSlices);
    if (retrievedContent) {
        sections.push({
            label: 'Retrieved Slices',
            content: retrievedContent
        });
    }

    if (localContext) {
        sections.push({
            label: 'Local Context',
            content: localContext
        });
    }

    const prompt = sections.map(section => `### ${section.label}\n${section.content}`).join('\n\n');

    const tokenBreakdown = sections.map(section => ({
        label: section.label,
        tokens: estimateTokens(section.content)
    }));
    const tokenEstimate = tokenBreakdown.reduce((sum, section) => sum + section.tokens, 0);

    return {
        prompt,
        sections,
        tokenEstimate,
        tokenBreakdown
    };
}
