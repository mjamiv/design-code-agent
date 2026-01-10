/**
 * Northstar Meeting Insights - Client-Side Application
 * Transforms meeting audio/text/PDF into actionable insights using OpenAI
 */

// ============================================
// PDF.js Configuration
// ============================================
const pdfjsLib = window['pdfjs-dist/build/pdf'] || null;
let pdfJsLoaded = false;

// Load PDF.js dynamically
async function loadPdfJs() {
    if (pdfJsLoaded) return;
    
    try {
        const pdfjsModule = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
        window.pdfjsLib = pdfjsModule;
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
        pdfJsLoaded = true;
    } catch (e) {
        console.error('Failed to load PDF.js:', e);
    }
}

// ============================================
// State Management
// ============================================
const state = {
    apiKey: '',
    selectedFile: null,
    selectedPdfFile: null,
    inputMode: 'audio', // 'audio', 'pdf', or 'text'
    isProcessing: false,
    results: null,
    metrics: null
};

// ============================================
// Pricing Configuration (per 1M tokens / per minute)
// ============================================
const PRICING = {
    'gpt-5.2': {
        input: 2.50,   // $ per 1M input tokens
        output: 10.00  // $ per 1M output tokens
    },
    'whisper-1': {
        perMinute: 0.006  // $ per minute of audio
    }
};

// Metrics tracking for current run
let currentMetrics = {
    whisperMinutes: 0,
    gptInputTokens: 0,
    gptOutputTokens: 0,
    apiCalls: []
};

// ============================================
// DOM Elements (initialized in init())
// ============================================
let elements = {};

// ============================================
// Initialization
// ============================================
async function init() {
    // Initialize DOM element references
    elements = {
        // API Key
        apiKeyInput: document.getElementById('api-key'),
        toggleKeyBtn: document.getElementById('toggle-key'),
        saveKeyBtn: document.getElementById('save-key'),
        
        // Tabs
        tabBtns: document.querySelectorAll('.tab-btn'),
        audioTab: document.getElementById('audio-tab'),
        pdfTab: document.getElementById('pdf-tab'),
        textTab: document.getElementById('text-tab'),
        
        // Audio Upload
        dropZone: document.getElementById('drop-zone'),
        audioFileInput: document.getElementById('audio-file'),
        fileInfo: document.getElementById('file-info'),
        fileName: document.querySelector('.file-name'),
        removeFileBtn: document.querySelector('.remove-file'),
        
        // PDF Upload
        pdfDropZone: document.getElementById('pdf-drop-zone'),
        pdfFileInput: document.getElementById('pdf-file'),
        pdfFileInfo: document.getElementById('pdf-file-info'),
        pdfFileName: document.querySelector('.pdf-file-name'),
        removePdfFileBtn: document.querySelector('.remove-pdf-file'),
        
        // Text Input
        textInput: document.getElementById('text-input'),
        
        // Actions
        analyzeBtn: document.getElementById('analyze-btn'),
        downloadBtn: document.getElementById('download-btn'),
        newAnalysisBtn: document.getElementById('new-analysis-btn'),
        
        // Progress
        progressSection: document.getElementById('progress-section'),
        progressFill: document.querySelector('.progress-fill'),
        progressText: document.querySelector('.progress-text'),
        
        // Results
        resultsSection: document.getElementById('results-section'),
        resultSummary: document.getElementById('result-summary'),
        resultKeypoints: document.getElementById('result-keypoints'),
        resultActions: document.getElementById('result-actions'),
        resultSentiment: document.getElementById('result-sentiment'),
        
        // Error
        errorSection: document.getElementById('error-section'),
        errorMessage: document.getElementById('error-message'),
        dismissErrorBtn: document.getElementById('dismiss-error')
    };
    
    loadSavedApiKey();
    setupEventListeners();
    updateAnalyzeButton();
    
    // Pre-load PDF.js in the background
    loadPdfJs();
}

function loadSavedApiKey() {
    const savedKey = localStorage.getItem('northstar_api_key');
    if (savedKey) {
        state.apiKey = savedKey;
        elements.apiKeyInput.value = savedKey;
    }
}

// ============================================
// Event Listeners
// ============================================
function setupEventListeners() {
    // API Key
    elements.apiKeyInput.addEventListener('input', handleApiKeyChange);
    elements.toggleKeyBtn.addEventListener('click', toggleApiKeyVisibility);
    elements.saveKeyBtn.addEventListener('click', saveApiKey);
    
    // Tabs
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Audio Drag and Drop
    elements.dropZone.addEventListener('click', () => elements.audioFileInput.click());
    elements.dropZone.addEventListener('dragover', handleDragOver);
    elements.dropZone.addEventListener('dragleave', handleDragLeave);
    elements.dropZone.addEventListener('drop', handleDrop);
    elements.audioFileInput.addEventListener('change', handleFileSelect);
    elements.removeFileBtn.addEventListener('click', removeSelectedFile);
    
    // PDF Drag and Drop
    elements.pdfDropZone.addEventListener('click', () => elements.pdfFileInput.click());
    elements.pdfDropZone.addEventListener('dragover', handlePdfDragOver);
    elements.pdfDropZone.addEventListener('dragleave', handlePdfDragLeave);
    elements.pdfDropZone.addEventListener('drop', handlePdfDrop);
    elements.pdfFileInput.addEventListener('change', handlePdfFileSelect);
    elements.removePdfFileBtn.addEventListener('click', removeSelectedPdfFile);
    
    // Text Input
    elements.textInput.addEventListener('input', updateAnalyzeButton);
    
    // Actions
    elements.analyzeBtn.addEventListener('click', startAnalysis);
    elements.downloadBtn.addEventListener('click', downloadDocx);
    elements.newAnalysisBtn.addEventListener('click', resetForNewAnalysis);
    elements.dismissErrorBtn.addEventListener('click', hideError);
}

// ============================================
// API Key Handling
// ============================================
function handleApiKeyChange(e) {
    state.apiKey = e.target.value.trim();
    updateAnalyzeButton();
}

function toggleApiKeyVisibility() {
    const isPassword = elements.apiKeyInput.type === 'password';
    elements.apiKeyInput.type = isPassword ? 'text' : 'password';
    elements.toggleKeyBtn.innerHTML = isPassword ? '&#128064;' : '&#128065;';
}

function saveApiKey() {
    if (state.apiKey) {
        localStorage.setItem('northstar_api_key', state.apiKey);
        showTemporaryMessage(elements.saveKeyBtn, 'Saved!', 'Save');
    }
}

function showTemporaryMessage(btn, message, original) {
    const originalText = btn.textContent;
    btn.textContent = message;
    btn.disabled = true;
    setTimeout(() => {
        btn.textContent = original || originalText;
        btn.disabled = false;
    }, 1500);
}

// ============================================
// Tab Switching
// ============================================
function switchTab(tab) {
    state.inputMode = tab;
    
    elements.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    elements.audioTab.classList.toggle('active', tab === 'audio');
    elements.pdfTab.classList.toggle('active', tab === 'pdf');
    elements.textTab.classList.toggle('active', tab === 'text');
    
    updateAnalyzeButton();
}

// ============================================
// File Handling
// ============================================
function handleDragOver(e) {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        processSelectedFile(files[0]);
    }
}

function handleFileSelect(e) {
    if (e.target.files.length > 0) {
        processSelectedFile(e.target.files[0]);
    }
}

function processSelectedFile(file) {
    const allowedFormats = ['m4a', 'mp3', 'webm', 'mp4', 'mpga', 'wav', 'mpeg', 'ogg', 'oga', 'flac'];
    const extension = file.name.split('.').pop().toLowerCase();
    
    if (!allowedFormats.includes(extension)) {
        showError(`Invalid file format. Supported formats: ${allowedFormats.join(', ')}`);
        return;
    }
    
    // Check file size (OpenAI limit is 25MB)
    if (file.size > 25 * 1024 * 1024) {
        showError('File size exceeds 25MB limit.');
        return;
    }
    
    state.selectedFile = file;
    elements.fileName.textContent = file.name;
    elements.fileInfo.classList.remove('hidden');
    elements.dropZone.style.display = 'none';
    updateAnalyzeButton();
}

function removeSelectedFile() {
    state.selectedFile = null;
    elements.audioFileInput.value = '';
    elements.fileInfo.classList.add('hidden');
    elements.dropZone.style.display = 'block';
    updateAnalyzeButton();
}

// ============================================
// PDF File Handling
// ============================================
function handlePdfDragOver(e) {
    e.preventDefault();
    elements.pdfDropZone.classList.add('dragover');
}

function handlePdfDragLeave(e) {
    e.preventDefault();
    elements.pdfDropZone.classList.remove('dragover');
}

function handlePdfDrop(e) {
    e.preventDefault();
    elements.pdfDropZone.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        processSelectedPdfFile(files[0]);
    }
}

function handlePdfFileSelect(e) {
    if (e.target.files.length > 0) {
        processSelectedPdfFile(e.target.files[0]);
    }
}

function processSelectedPdfFile(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    
    if (extension !== 'pdf') {
        showError('Invalid file format. Please upload a PDF file.');
        return;
    }
    
    // Check file size (50MB limit for PDFs)
    if (file.size > 50 * 1024 * 1024) {
        showError('File size exceeds 50MB limit.');
        return;
    }
    
    state.selectedPdfFile = file;
    elements.pdfFileName.textContent = file.name;
    elements.pdfFileInfo.classList.remove('hidden');
    elements.pdfDropZone.style.display = 'none';
    updateAnalyzeButton();
}

function removeSelectedPdfFile() {
    state.selectedPdfFile = null;
    elements.pdfFileInput.value = '';
    elements.pdfFileInfo.classList.add('hidden');
    elements.pdfDropZone.style.display = 'block';
    updateAnalyzeButton();
}

// ============================================
// PDF Text Extraction
// ============================================
async function extractTextFromPdf(file) {
    // Ensure PDF.js is loaded
    if (!pdfJsLoaded) {
        await loadPdfJs();
    }
    
    if (!window.pdfjsLib) {
        throw new Error('PDF.js library failed to load. Please refresh the page and try again.');
    }
    
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    let fullText = '';
    const totalPages = pdf.numPages;
    
    for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + '\n\n';
        
        // Update progress for large PDFs
        const progress = Math.round((i / totalPages) * 20);
        updateProgress(progress, `Extracting text from PDF (page ${i}/${totalPages})...`);
    }
    
    return fullText.trim();
}

// ============================================
// Analyze Button State
// ============================================
function updateAnalyzeButton() {
    let canAnalyze = false;
    
    if (state.apiKey) {
        if (state.inputMode === 'audio' && state.selectedFile) {
            canAnalyze = true;
        } else if (state.inputMode === 'pdf' && state.selectedPdfFile) {
            canAnalyze = true;
        } else if (state.inputMode === 'text' && elements.textInput.value.trim()) {
            canAnalyze = true;
        }
    }
    
    elements.analyzeBtn.disabled = !canAnalyze;
}

// ============================================
// Analysis Pipeline
// ============================================
async function startAnalysis() {
    if (state.isProcessing) return;
    
    state.isProcessing = true;
    hideError();
    showProgress();
    setButtonLoading(true);
    
    // Reset metrics for new run
    currentMetrics = {
        whisperMinutes: 0,
        gptInputTokens: 0,
        gptOutputTokens: 0,
        apiCalls: []
    };
    
    try {
        let transcriptionText;
        
        if (state.inputMode === 'audio') {
            updateProgress(5, 'Transcribing audio with Whisper...');
            transcriptionText = await transcribeAudio(state.selectedFile);
        } else if (state.inputMode === 'pdf') {
            updateProgress(5, 'Extracting text from PDF...');
            transcriptionText = await extractTextFromPdf(state.selectedPdfFile);
            
            if (!transcriptionText || transcriptionText.length < 10) {
                throw new Error('Could not extract text from PDF. The file may be image-based or empty.');
            }
        } else {
            transcriptionText = elements.textInput.value.trim();
        }
        
        updateProgress(30, 'Generating summary...');
        const summary = await extractSummary(transcriptionText);
        
        updateProgress(50, 'Extracting key points...');
        const keyPoints = await extractKeyPoints(transcriptionText);
        
        updateProgress(70, 'Identifying action items...');
        const actionItems = await extractActionItems(transcriptionText);
        
        updateProgress(90, 'Analyzing sentiment...');
        const sentiment = await analyzeSentiment(transcriptionText);
        
        updateProgress(100, 'Complete!');
        
        // Calculate costs
        const metrics = calculateMetrics();
        
        state.results = {
            transcription: transcriptionText,
            summary,
            keyPoints,
            actionItems,
            sentiment
        };
        state.metrics = metrics;
        
        setTimeout(() => {
            hideProgress();
            displayResults();
        }, 500);
        
    } catch (error) {
        console.error('Analysis error:', error);
        hideProgress();
        showError(error.message || 'An error occurred during analysis. Please try again.');
    } finally {
        state.isProcessing = false;
        setButtonLoading(false);
    }
}

function setButtonLoading(loading) {
    const btnText = elements.analyzeBtn.querySelector('.btn-text');
    const btnLoader = elements.analyzeBtn.querySelector('.btn-loader');
    
    btnText.classList.toggle('hidden', loading);
    btnLoader.classList.toggle('hidden', !loading);
    elements.analyzeBtn.disabled = loading;
}

// ============================================
// OpenAI API Calls
// ============================================
async function transcribeAudio(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', 'whisper-1');
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`
        },
        body: formData
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Transcription failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Estimate audio duration from file size (rough estimate: ~1MB per minute for common formats)
    const estimatedMinutes = Math.max(0.1, file.size / (1024 * 1024));
    currentMetrics.whisperMinutes += estimatedMinutes;
    currentMetrics.apiCalls.push({
        name: 'Audio Transcription',
        model: 'whisper-1',
        duration: estimatedMinutes.toFixed(2) + ' min'
    });
    
    return data.text;
}

async function callChatAPI(systemPrompt, userContent, callName = 'API Call') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-5.2',
            temperature: 0,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ]
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API call failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Track token usage
    if (data.usage) {
        currentMetrics.gptInputTokens += data.usage.prompt_tokens || 0;
        currentMetrics.gptOutputTokens += data.usage.completion_tokens || 0;
        currentMetrics.apiCalls.push({
            name: callName,
            model: 'gpt-5.2',
            inputTokens: data.usage.prompt_tokens || 0,
            outputTokens: data.usage.completion_tokens || 0
        });
    }
    
    return data.choices[0].message.content;
}

async function extractSummary(text) {
    const systemPrompt = `You are a highly skilled AI trained in language comprehension and summarization. 
Read the following text and summarize it into a concise abstract paragraph. 
Retain the most important points, providing a coherent and readable summary that helps someone understand the main points without reading the entire text. 
Avoid unnecessary details or tangential points.`;
    
    return await callChatAPI(systemPrompt, text, 'Summary');
}

async function extractKeyPoints(text) {
    const systemPrompt = `You are a proficient AI with a specialty in distilling information into key points. 
Based on the following text, identify and list the main points that were discussed or brought up. 
These should be the most important ideas, findings, or topics that are crucial to the essence of the discussion. 
Format each point on its own line starting with a dash (-).`;
    
    return await callChatAPI(systemPrompt, text, 'Key Points');
}

async function extractActionItems(text) {
    const systemPrompt = `You are a highly skilled AI trained in identifying action items. 
Review the following text and identify any specific tasks or action items that were assigned or discussed. 
Format each action item on its own line starting with a dash (-).
If no action items are found, respond with "No specific action items identified."`;
    
    return await callChatAPI(systemPrompt, text, 'Action Items');
}

async function analyzeSentiment(text) {
    const systemPrompt = `You are an AI trained in sentiment analysis. 
Analyze the overall sentiment of the following text. 
Respond with exactly one word: "Positive", "Negative", or "Neutral".`;
    
    return await callChatAPI(systemPrompt, text, 'Sentiment');
}

// ============================================
// Metrics Calculation
// ============================================
function calculateMetrics() {
    const whisperCost = currentMetrics.whisperMinutes * PRICING['whisper-1'].perMinute;
    const gptInputCost = (currentMetrics.gptInputTokens / 1000000) * PRICING['gpt-5.2'].input;
    const gptOutputCost = (currentMetrics.gptOutputTokens / 1000000) * PRICING['gpt-5.2'].output;
    const totalCost = whisperCost + gptInputCost + gptOutputCost;
    
    return {
        whisperMinutes: currentMetrics.whisperMinutes,
        gptInputTokens: currentMetrics.gptInputTokens,
        gptOutputTokens: currentMetrics.gptOutputTokens,
        totalTokens: currentMetrics.gptInputTokens + currentMetrics.gptOutputTokens,
        whisperCost,
        gptInputCost,
        gptOutputCost,
        totalCost,
        apiCalls: currentMetrics.apiCalls
    };
}

// ============================================
// Progress UI
// ============================================
function showProgress() {
    elements.progressSection.classList.remove('hidden');
    elements.resultsSection.classList.add('hidden');
}

function hideProgress() {
    elements.progressSection.classList.add('hidden');
}

function updateProgress(percent, message) {
    elements.progressFill.style.width = `${percent}%`;
    elements.progressText.textContent = message;
}

// ============================================
// Results Display
// ============================================
function displayResults() {
    if (!state.results) return;
    
    elements.resultsSection.classList.remove('hidden');
    
    // Summary
    elements.resultSummary.innerHTML = `<p>${escapeHtml(state.results.summary)}</p>`;
    
    // Key Points
    elements.resultKeypoints.innerHTML = formatListContent(state.results.keyPoints);
    
    // Action Items
    elements.resultActions.innerHTML = formatListContent(state.results.actionItems);
    
    // Sentiment
    const sentiment = state.results.sentiment.trim().toLowerCase();
    let sentimentClass = 'sentiment-neutral';
    let sentimentEmoji = '😐';
    
    if (sentiment.includes('positive')) {
        sentimentClass = 'sentiment-positive';
        sentimentEmoji = '😊';
    } else if (sentiment.includes('negative')) {
        sentimentClass = 'sentiment-negative';
        sentimentEmoji = '😟';
    }
    
    elements.resultSentiment.innerHTML = `
        <span class="${sentimentClass}">${sentimentEmoji} ${capitalize(state.results.sentiment)}</span>
    `;
    
    // Display metrics
    displayMetrics();
    
    // Scroll to results
    elements.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function displayMetrics() {
    const metrics = state.metrics;
    if (!metrics) return;
    
    const resultMetrics = document.getElementById('result-metrics');
    if (!resultMetrics) return;
    
    const formatCost = (cost) => cost < 0.01 ? '<$0.01' : `$${cost.toFixed(4)}`;
    const formatTokens = (tokens) => tokens.toLocaleString();
    
    let breakdownHtml = '';
    metrics.apiCalls.forEach(call => {
        if (call.model === 'whisper-1') {
            breakdownHtml += `
                <div class="metric-breakdown-item">
                    <span>${call.name}</span>
                    <span>${call.duration}</span>
                </div>`;
        } else {
            breakdownHtml += `
                <div class="metric-breakdown-item">
                    <span>${call.name}</span>
                    <span>${formatTokens(call.inputTokens + call.outputTokens)} tokens</span>
                </div>`;
        }
    });
    
    resultMetrics.innerHTML = `
        <div class="metrics-grid">
            <div class="metric-item">
                <span class="metric-value">${formatTokens(metrics.totalTokens)}</span>
                <span class="metric-label">Total Tokens</span>
            </div>
            <div class="metric-item">
                <span class="metric-value">${formatCost(metrics.totalCost)}</span>
                <span class="metric-label">Est. Cost</span>
            </div>
        </div>
        <div class="metric-breakdown">
            <div class="metric-breakdown-item">
                <span>GPT-5.2 Input</span>
                <span>${formatTokens(metrics.gptInputTokens)} tokens (${formatCost(metrics.gptInputCost)})</span>
            </div>
            <div class="metric-breakdown-item">
                <span>GPT-5.2 Output</span>
                <span>${formatTokens(metrics.gptOutputTokens)} tokens (${formatCost(metrics.gptOutputCost)})</span>
            </div>
            ${metrics.whisperMinutes > 0 ? `
            <div class="metric-breakdown-item">
                <span>Whisper Audio</span>
                <span>${metrics.whisperMinutes.toFixed(2)} min (${formatCost(metrics.whisperCost)})</span>
            </div>` : ''}
        </div>
        <div class="metric-breakdown" style="margin-top: var(--space-sm);">
            <strong style="color: var(--text-secondary);">API Calls:</strong>
            ${breakdownHtml}
        </div>
    `;
}

function formatListContent(text) {
    const lines = text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    const listItems = lines.map(line => {
        // Remove leading dash or bullet if present
        const cleanLine = line.replace(/^[-•*]\s*/, '');
        return `<li>${escapeHtml(cleanLine)}</li>`;
    }).join('');
    
    return `<ul>${listItems}</ul>`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ============================================
// DOCX Generation
// ============================================
async function downloadDocx() {
    if (!state.results) return;
    
    const { Document, Paragraph, TextRun, HeadingLevel, Packer } = docx;
    
    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                // Title
                new Paragraph({
                    text: "Meeting Minutes",
                    heading: HeadingLevel.TITLE,
                    spacing: { after: 300 }
                }),
                
                // Generated by
                new Paragraph({
                    children: [
                        new TextRun({
                            text: "Generated by Northstar Meeting Insights",
                            italics: true,
                            color: "666666"
                        })
                    ],
                    spacing: { after: 400 }
                }),
                
                // Transcription
                new Paragraph({
                    text: "Full Transcription",
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 400, after: 200 }
                }),
                new Paragraph({
                    text: state.results.transcription,
                    spacing: { after: 400 }
                }),
                
                // Summary
                new Paragraph({
                    text: "Summary",
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 400, after: 200 }
                }),
                new Paragraph({
                    text: state.results.summary,
                    spacing: { after: 400 }
                }),
                
                // Key Points
                new Paragraph({
                    text: "Key Points",
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 400, after: 200 }
                }),
                ...state.results.keyPoints.split('\n')
                    .filter(line => line.trim())
                    .map(point => new Paragraph({
                        text: point.replace(/^[-•*]\s*/, '• '),
                        spacing: { after: 100 }
                    })),
                
                // Action Items
                new Paragraph({
                    text: "Action Items",
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 400, after: 200 }
                }),
                ...state.results.actionItems.split('\n')
                    .filter(line => line.trim())
                    .map(item => new Paragraph({
                        text: item.replace(/^[-•*]\s*/, '☐ '),
                        spacing: { after: 100 }
                    })),
                
                // Sentiment
                new Paragraph({
                    text: "Overall Sentiment",
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 400, after: 200 }
                }),
                new Paragraph({
                    text: state.results.sentiment,
                    spacing: { after: 200 }
                })
            ]
        }]
    });
    
    // Generate and download
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-minutes-${new Date().toISOString().slice(0, 10)}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================
// Reset / New Analysis
// ============================================
function resetForNewAnalysis() {
    state.results = null;
    state.metrics = null;
    state.selectedFile = null;
    state.selectedPdfFile = null;
    
    elements.audioFileInput.value = '';
    elements.pdfFileInput.value = '';
    elements.textInput.value = '';
    elements.fileInfo.classList.add('hidden');
    elements.pdfFileInfo.classList.add('hidden');
    elements.dropZone.style.display = 'block';
    elements.pdfDropZone.style.display = 'block';
    elements.resultsSection.classList.add('hidden');
    
    updateAnalyzeButton();
    
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================
// Error Handling
// ============================================
function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorSection.classList.remove('hidden');
    elements.errorSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideError() {
    elements.errorSection.classList.add('hidden');
}

// ============================================
// Start the App
// ============================================
// Handle both cases: DOM already loaded (module scripts) or still loading
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
