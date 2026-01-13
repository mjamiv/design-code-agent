/**
 * RLM Phase 2 Test Suite
 * Run with: node --experimental-vm-modules js/rlm/test-phase2.mjs
 */

import { classifyQuery, validateCode, createCodeGenerator, generateCodePrompt, QueryType } from './code-generator.js';

console.log('╔════════════════════════════════════════════════╗');
console.log('║         RLM Phase 2 Test Suite                 ║');
console.log('╚════════════════════════════════════════════════╝\n');

let totalPassed = 0;
let totalFailed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        totalPassed++;
    } catch (err) {
        console.log(`  ✗ ${name}: ${err.message}`);
        totalFailed++;
    }
}

function assertEqual(actual, expected, msg = '') {
    if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}. ${msg}`);
    }
}

// ═══════════════════════════════════════════════════
// Test 1: Query Classification
// ═══════════════════════════════════════════════════
console.log('📋 Query Classification Tests\n');

test('Factual query classification', () => {
    const result = classifyQuery('What was discussed in the Q4 meeting?');
    assertEqual(result.type, 'factual');
});

test('Comparative query classification', () => {
    const result = classifyQuery('Compare the action items between meeting A and meeting B');
    assertEqual(result.type, 'comparative');
});

test('Aggregative query classification', () => {
    const result = classifyQuery('Get all action items across every meeting');
    assertEqual(result.type, 'aggregative');
});

test('Search query classification', () => {
    const result = classifyQuery('Find mentions of budget in the meetings');
    assertEqual(result.type, 'search');
});

test('Recursive query classification', () => {
    const result = classifyQuery('Analyze the patterns and themes that emerge across meetings');
    assertEqual(result.type, 'recursive');
});

test('Classification includes confidence score', () => {
    const result = classifyQuery('Compare all meetings');
    if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
        throw new Error('Confidence should be a number between 0 and 1');
    }
});

test('Classification includes suggestSubLm flag', () => {
    const result = classifyQuery('Analyze the implications of these discussions');
    if (typeof result.suggestSubLm !== 'boolean') {
        throw new Error('suggestSubLm should be a boolean');
    }
});

// ═══════════════════════════════════════════════════
// Test 2: Code Validation
// ═══════════════════════════════════════════════════
console.log('\n🔒 Code Validation Tests\n');

test('Valid code passes validation', () => {
    const code = `items = get_all_action_items()
FINAL(items)`;
    const result = validateCode(code);
    assertEqual(result.isValid, true);
});

test('Blocks os module import', () => {
    const code = 'import os';
    const result = validateCode(code);
    assertEqual(result.isValid, false);
});

test('Blocks sys module import', () => {
    const code = 'import sys';
    const result = validateCode(code);
    assertEqual(result.isValid, false);
});

test('Blocks subprocess import', () => {
    const code = 'import subprocess';
    const result = validateCode(code);
    assertEqual(result.isValid, false);
});

test('Blocks exec() calls', () => {
    const code = 'exec("print(1)")';
    const result = validateCode(code);
    assertEqual(result.isValid, false);
});

test('Blocks eval() calls', () => {
    const code = 'result = eval("1+1")';
    const result = validateCode(code);
    assertEqual(result.isValid, false);
});

test('Blocks file operations', () => {
    const code = 'f = open("file.txt", "r")';
    const result = validateCode(code);
    assertEqual(result.isValid, false);
});

test('Warns on missing FINAL call', () => {
    const code = 'result = 1 + 1';
    const result = validateCode(code);
    if (!result.warnings.some(w => w.includes('FINAL'))) {
        throw new Error('Should warn about missing FINAL');
    }
});

test('Warns on potential infinite loop', () => {
    const code = 'while True:\n    pass';
    const result = validateCode(code);
    if (!result.warnings.some(w => w.includes('infinite loop'))) {
        throw new Error('Should warn about infinite loop');
    }
});

// ═══════════════════════════════════════════════════
// Test 3: Code Generator
// ═══════════════════════════════════════════════════
console.log('\n⚙️ Code Generator Tests\n');

test('Creates generator with default options', () => {
    const generator = createCodeGenerator();
    if (!generator.options.validateCode) {
        throw new Error('validateCode should default to true');
    }
});

test('Creates generator with custom maxRetries', () => {
    const generator = createCodeGenerator({ maxRetries: 5 });
    assertEqual(generator.options.maxRetries, 5);
});

test('Generator classifyQuery method works', () => {
    const generator = createCodeGenerator();
    const result = generator.classifyQuery('Compare meetings');
    assertEqual(result.type, 'comparative');
});

test('Generator getExample returns code for each type', () => {
    const generator = createCodeGenerator();
    for (const type of ['factual', 'aggregative', 'comparative', 'search', 'recursive']) {
        const example = generator.getExample(type);
        if (!example || !example.includes('FINAL')) {
            throw new Error(`Missing or invalid example for ${type}`);
        }
    }
});

// ═══════════════════════════════════════════════════
// Test 4: Prompt Generation
// ═══════════════════════════════════════════════════
console.log('\n📝 Prompt Generation Tests\n');

test('generateCodePrompt returns system and user prompts', () => {
    const result = generateCodePrompt('Get action items', {});
    if (!result.systemPrompt || !result.userPrompt) {
        throw new Error('Should return both systemPrompt and userPrompt');
    }
});

test('generateCodePrompt includes classification', () => {
    const result = generateCodePrompt('Compare meetings', {});
    if (!result.classification || !result.classification.type) {
        throw new Error('Should include classification');
    }
});

test('generateCodePrompt includes agent context', () => {
    const result = generateCodePrompt('Query', {
        activeAgents: 5,
        agentNames: ['Meeting 1', 'Meeting 2', 'Meeting 3']
    });
    if (!result.userPrompt.includes('5 meeting agents')) {
        throw new Error('Should include agent count');
    }
    if (!result.userPrompt.includes('Meeting 1')) {
        throw new Error('Should include agent names');
    }
});

test('generateCodePrompt includes strategy hint', () => {
    const result = generateCodePrompt('Compare all meetings', {});
    if (!result.userPrompt.includes('comparative')) {
        throw new Error('Should include strategy hint for comparative queries');
    }
});

test('generateCodePrompt includes example code', () => {
    const result = generateCodePrompt('Search for budget', {});
    if (!result.userPrompt.includes('search_agents')) {
        throw new Error('Should include search example for search queries');
    }
});

// ═══════════════════════════════════════════════════
// Test 5: QueryType Enum
// ═══════════════════════════════════════════════════
console.log('\n🏷️ QueryType Enum Tests\n');

test('QueryType has all expected values', () => {
    const expected = ['FACTUAL', 'AGGREGATIVE', 'COMPARATIVE', 'SEARCH', 'RECURSIVE'];
    for (const type of expected) {
        if (!QueryType[type]) {
            throw new Error(`Missing QueryType.${type}`);
        }
    }
});

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════════╗');
console.log(`║  Results: ${totalPassed} passed, ${totalFailed} failed                    ║`);
console.log('╚════════════════════════════════════════════════╝');

if (totalFailed > 0) {
    process.exit(1);
}
