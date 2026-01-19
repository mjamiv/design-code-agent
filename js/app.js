/**
 * northstar.LM - Client-Side Application
 * Transforms design code audio/text/PDF into actionable insights using OpenAI
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
    selectedImageFile: null,
    selectedImageBase64: null, // Base64-encoded image for Vision API
    selectedVideoFile: null,
    inputMode: 'audio', // 'audio', 'pdf', 'image', 'video', 'text', or 'url'
    isProcessing: false,
    results: null,
    metrics: null,
    chatHistory: [], // Stores chat conversation history
    sourceUrl: null,
    exportMeta: {
        agentId: null,
        source: {
            audio: null,
            pdf: null,
            image: null,
            video: null,
            url: null
        },
        processing: {
            inputMode: null,
            analysis: null,
            transcriptionMethod: null,
            pdf: {
                totalPages: null,
                usedVisionOcr: false,
                ocrPagesAnalyzed: 0,
                ocrPageLimit: 0
            }
        },
        artifacts: {
            audioBriefing: null,
            infographic: null
        }
    },
    urlContent: null // Stores fetched URL content
};

const GPT_52_MODEL = 'gpt-5.2-2025-12-11';

function isCorsError(error) {
    if (!error) {
        return false;
    }
    return error.name === 'TypeError' && /failed to fetch|networkerror|load resource/i.test(error.message || '');
}

function buildCorsErrorMessage() {
    return 'Browser blocked this request due to CORS. When running from GitHub Pages, you must route OpenAI API calls through your own backend/proxy so the response includes Access-Control-Allow-Origin.';
}

async function fetchOpenAI(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
        if (isCorsError(error)) {
            throw new Error(buildCorsErrorMessage());
        }
        throw error;
    }
}

// ============================================
// Pricing Configuration (per 1M tokens / per minute / per unit)
// ============================================
const PRICING = {
    'gpt-5.2': {
        input: 1.75,   // $ per 1M input tokens
        output: 14.00  // $ per 1M output tokens
    },
    'gpt-5.2-2025-12-11': {
        input: 1.75,   // $ per 1M input tokens
        output: 14.00  // $ per 1M output tokens
    },
    'whisper-1': {
        perMinute: 0.006  // $ per minute of audio
    },
    'gpt-4o-mini-tts': {
        perKChars: 0.015  // $ per 1K characters (estimated)
    },
    'gpt-image-1.5': {
        input: 10.00,   // $ per 1M input tokens
        output: 40.00   // $ per 1M output tokens (image generation)
    }
};

const PROMPTS = {
    analysisBatchSystem: `You are an expert structural engineering code analyst with deep knowledge of ASCE, AASHTO, ACI, AISC, and other design standards.

Analyze the following engineering design code document and extract structured information in JSON format:

{
    "codeOverview": "Brief description of what this code/standard covers, including scope and primary application areas",

    "requirements": [
        {
            "id": "Section/clause identifier (e.g., 'ASCE-BTH 3.2.1')",
            "text": "Full requirement statement",
            "section": "Parent section name",
            "type": "mandatory|advisory|reference",
            "keywords": ["key", "terms"]
        }
    ],

    "designParameters": [
        {
            "id": "Parameter identifier",
            "name": "Human-readable name (e.g., 'Load Factor for Dead Load')",
            "value": "Numerical value or formula",
            "unit": "Unit of measure",
            "section": "Source section reference",
            "applicability": "When/where this parameter applies"
        }
    ],

    "crossReferences": [
        {
            "source": "Current section reference",
            "target": "Referenced code/section",
            "relationship": "requires|supersedes|related|exception",
            "note": "Context for the reference"
        }
    ],

    "complianceNotes": [
        "Critical compliance items, exceptions, or warnings"
    ]
}

Focus on:
1. Extracting specific, actionable requirements with exact section references
2. Capturing all load factors, safety factors, and design formulas
3. Mapping dependencies between code sections and to other standards
4. Noting exceptions, limitations, or special conditions

Ensure your response is valid JSON only.`,

    summarySystem: `You are an expert engineering code analyst.
Provide a concise overview of the following design standard or code section.
Include: scope of applicability, key design requirements, and relationship to other standards.`,

    visionOcrSystem: `You are an expert at analyzing images of engineering drawings, specification tables, and technical documents.

Extract ALL text content visible, including:
1. Table data (preserve as markdown tables)
2. Figure references and captions
3. Equations and formulas (use LaTeX notation)
4. Dimensional data and units
5. Notes and annotations

For tables, use markdown format. Note any design values, load factors, or key parameters.`,

    audioBriefingSystem: 'You create professional engineering code briefings for design teams.'
};

// Metrics tracking for current run
let currentMetrics = {
    whisperMinutes: 0,
    gptInputTokens: 0,
    gptOutputTokens: 0,
    chatInputTokens: 0,
    chatOutputTokens: 0,
    ttsCharacters: 0,
    imageInputTokens: 0,
    imageOutputTokens: 0,
    apiCalls: []
};

// Store generated audio/image data for download
let generatedAudioUrl = null;
let generatedAudioBase64 = null;
let generatedImageUrl = null;
let generatedImageBase64 = null; // Store base64 for DOCX embedding

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
        apiKeyContainer: document.getElementById('api-key-container'),
        apiKeyCollapsed: document.getElementById('api-key-collapsed'),
        expandKeyBtn: document.getElementById('expand-key-btn'),
        
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

        // Image Upload
        imageTab: document.getElementById('image-tab'),
        imageDropZone: document.getElementById('image-drop-zone'),
        imageFileInput: document.getElementById('image-file'),
        imageFileInfo: document.getElementById('image-file-info'),
        imageFileName: document.querySelector('.image-file-name'),
        removeImageFileBtn: document.querySelector('.remove-image-file'),
        imagePreview: document.getElementById('image-preview'),
        imagePreviewImg: document.getElementById('image-preview-img'),

        // Video Upload
        videoTab: document.getElementById('video-tab'),
        videoDropZone: document.getElementById('video-drop-zone'),
        videoFileInput: document.getElementById('video-file'),
        videoFileInfo: document.getElementById('video-file-info'),
        videoFileName: document.querySelector('.video-file-name'),
        removeVideoFileBtn: document.querySelector('.remove-video-file'),

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
        resultsNav: document.getElementById('results-nav'),
        resultOverview: document.getElementById('result-overview'),
        resultRequirements: document.getElementById('result-requirements'),
        resultParameters: document.getElementById('result-parameters'),
        resultCrossrefs: document.getElementById('result-crossrefs'),
        resultCompliance: document.getElementById('result-compliance'),
        resultSourceText: document.getElementById('result-source-text'),
        
        // Error
        errorSection: document.getElementById('error-section'),
        errorMessage: document.getElementById('error-message'),
        dismissErrorBtn: document.getElementById('dismiss-error'),
        
        // Audio Briefing
        audioPrompt: document.getElementById('audio-prompt'),
        voiceSelect: document.getElementById('voice-select'),
        generateAudioBtn: document.getElementById('generate-audio-btn'),
        audioPlayerContainer: document.getElementById('audio-player-container'),
        audioPlayer: document.getElementById('audio-player'),
        downloadAudioBtn: document.getElementById('download-audio-btn'),
        
        // Infographic
        infographicPrompt: document.getElementById('infographic-prompt'),
        generateInfographicBtn: document.getElementById('generate-infographic-btn'),
        infographicContainer: document.getElementById('infographic-container'),
        infographicImage: document.getElementById('infographic-image'),
        downloadInfographicBtn: document.getElementById('download-infographic-btn'),
        
        // Chat with Data
        chatMessages: document.getElementById('chat-messages'),
        chatInput: document.getElementById('chat-input'),
        chatSendBtn: document.getElementById('chat-send-btn'),
        
        // URL Input
        urlTab: document.getElementById('url-tab'),
        urlInput: document.getElementById('url-input'),
        fetchUrlBtn: document.getElementById('fetch-url-btn'),
        urlPreview: document.getElementById('url-preview'),
        urlPreviewContent: document.getElementById('url-preview-content'),
        clearUrlBtn: document.querySelector('.clear-url-btn'),
        
        // Agent Import/Export
        exportAgentBtn: document.getElementById('export-agent-btn'),
        importAgentBtn: document.getElementById('import-agent-btn'),
        agentFileInput: document.getElementById('agent-file'),
        
        // Agent Name Modal
        agentNameModal: document.getElementById('agent-name-modal'),
        agentNameInput: document.getElementById('agent-name-input'),
        agentNameHint: document.getElementById('agent-name-hint'),
        modalCloseBtn: document.getElementById('modal-close-btn'),
        modalCancelBtn: document.getElementById('modal-cancel-btn'),
        modalConfirmBtn: document.getElementById('modal-confirm-btn'),
        
        // Help Modal
        helpBtn: document.getElementById('help-btn'),
        helpModal: document.getElementById('help-modal'),
        helpCloseBtn: document.getElementById('help-close-btn'),
        helpGotItBtn: document.getElementById('help-got-it-btn'),
        
        // About Dropdown
        aboutBtn: document.getElementById('about-btn'),
        aboutDropdown: document.getElementById('about-dropdown')
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
        collapseApiKeySection();
    }
}

function collapseApiKeySection() {
    if (elements.apiKeyContainer && elements.apiKeyCollapsed) {
        elements.apiKeyContainer.classList.add('hidden');
        elements.apiKeyCollapsed.classList.remove('hidden');
    }
}

function expandApiKeySection() {
    if (elements.apiKeyContainer && elements.apiKeyCollapsed) {
        elements.apiKeyContainer.classList.remove('hidden');
        elements.apiKeyCollapsed.classList.add('hidden');
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
    if (elements.expandKeyBtn) {
        elements.expandKeyBtn.addEventListener('click', expandApiKeySection);
    }
    
    // Tabs
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Audio Drag and Drop
    // Note: Click to browse is handled natively by <label for="audio-file">
    elements.dropZone.addEventListener('dragover', handleDragOver);
    elements.dropZone.addEventListener('dragleave', handleDragLeave);
    elements.dropZone.addEventListener('drop', handleDrop);
    elements.audioFileInput.addEventListener('change', handleFileSelect);
    elements.removeFileBtn.addEventListener('click', removeSelectedFile);
    
    // PDF Drag and Drop
    elements.pdfDropZone.addEventListener('click', (e) => {
        // Trigger file input on click (explicit handler for cross-browser support)
        e.preventDefault();
        elements.pdfFileInput.click();
    });
    elements.pdfDropZone.addEventListener('dragover', handlePdfDragOver);
    elements.pdfDropZone.addEventListener('dragleave', handlePdfDragLeave);
    elements.pdfDropZone.addEventListener('drop', handlePdfDrop);
    elements.pdfFileInput.addEventListener('change', handlePdfFileSelect);
    elements.removePdfFileBtn.addEventListener('click', removeSelectedPdfFile);

    // Image Drag and Drop
    elements.imageDropZone.addEventListener('click', (e) => {
        e.preventDefault();
        elements.imageFileInput.click();
    });
    elements.imageDropZone.addEventListener('dragover', handleImageDragOver);
    elements.imageDropZone.addEventListener('dragleave', handleImageDragLeave);
    elements.imageDropZone.addEventListener('drop', handleImageDrop);
    elements.imageFileInput.addEventListener('change', handleImageFileSelect);
    elements.removeImageFileBtn.addEventListener('click', removeSelectedImageFile);

    // Video Drag and Drop
    elements.videoDropZone.addEventListener('click', (e) => {
        e.preventDefault();
        elements.videoFileInput.click();
    });
    elements.videoDropZone.addEventListener('dragover', handleVideoDragOver);
    elements.videoDropZone.addEventListener('dragleave', handleVideoDragLeave);
    elements.videoDropZone.addEventListener('drop', handleVideoDrop);
    elements.videoFileInput.addEventListener('change', handleVideoFileSelect);
    elements.removeVideoFileBtn.addEventListener('click', removeSelectedVideoFile);

    // Text Input
    elements.textInput.addEventListener('input', updateAnalyzeButton);
    
    // Actions
    elements.analyzeBtn.addEventListener('click', startAnalysis);
    elements.downloadBtn.addEventListener('click', downloadDocx);
    elements.newAnalysisBtn.addEventListener('click', resetForNewAnalysis);
    elements.dismissErrorBtn.addEventListener('click', hideError);
    
    // Audio Briefing
    elements.generateAudioBtn.addEventListener('click', generateAudioBriefing);
    elements.downloadAudioBtn.addEventListener('click', downloadAudio);
    
    // Infographic
    elements.generateInfographicBtn.addEventListener('click', generateInfographic);
    elements.downloadInfographicBtn.addEventListener('click', downloadInfographic);
    
    // Chat with Data
    elements.chatSendBtn.addEventListener('click', sendChatMessage);
    elements.chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    
    // URL Input
    elements.fetchUrlBtn.addEventListener('click', fetchUrlContent);
    elements.urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fetchUrlContent();
        }
    });
    elements.urlInput.addEventListener('input', updateAnalyzeButton);
    elements.clearUrlBtn.addEventListener('click', clearUrlContent);
    
    // Agent Import/Export
    elements.exportAgentBtn.addEventListener('click', showAgentNameModal);
    elements.importAgentBtn.addEventListener('click', () => elements.agentFileInput.click());
    elements.agentFileInput.addEventListener('change', handleAgentFileSelect);
    
    // Agent Name Modal
    elements.modalCloseBtn.addEventListener('click', hideAgentNameModal);
    elements.modalCancelBtn.addEventListener('click', hideAgentNameModal);
    elements.modalConfirmBtn.addEventListener('click', confirmExportAgent);
    elements.agentNameModal.addEventListener('click', (e) => {
        if (e.target === elements.agentNameModal) hideAgentNameModal();
    });
    elements.agentNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmExportAgent();
    });
    
    // Help Modal
    elements.helpBtn.addEventListener('click', showHelpModal);
    elements.helpCloseBtn.addEventListener('click', hideHelpModal);
    elements.helpGotItBtn.addEventListener('click', hideHelpModal);
    elements.helpModal.addEventListener('click', (e) => {
        if (e.target === elements.helpModal) hideHelpModal();
    });
    
    // About Dropdown
    if (elements.aboutBtn && elements.aboutDropdown) {
        elements.aboutBtn.addEventListener('click', toggleAboutDropdown);
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!elements.aboutBtn.contains(e.target) && !elements.aboutDropdown.contains(e.target)) {
                elements.aboutDropdown.classList.add('hidden');
            }
        });
    }
    
    // Results Navigation
    setupResultsNav();
    
    // Wearable Modal (Coming Soon)
    initWearableModal();
}

// ============================================
// Results Navigation & Scroll Spy
// ============================================
function setupResultsNav() {
    if (!elements.resultsNav) return;
    
    // Handle nav pill clicks
    const navPills = elements.resultsNav.querySelectorAll('.nav-pill');
    navPills.forEach(pill => {
        pill.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = pill.getAttribute('data-section');
            const targetElement = document.getElementById(targetId);
            
            if (targetElement) {
                // Smooth scroll to section
                const navHeight = elements.resultsNav.offsetHeight;
                const targetPosition = targetElement.getBoundingClientRect().top + window.scrollY - navHeight - 20;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
                
                // Update active state
                updateActiveNavPill(targetId);
            }
        });
    });
    
    // Scroll spy - update active pill based on scroll position
    let scrollTimeout;
    window.addEventListener('scroll', () => {
        if (scrollTimeout) {
            window.cancelAnimationFrame(scrollTimeout);
        }
        scrollTimeout = window.requestAnimationFrame(() => {
            updateNavOnScroll();
        });
    });
}

function updateActiveNavPill(sectionId) {
    if (!elements.resultsNav) return;
    
    const navPills = elements.resultsNav.querySelectorAll('.nav-pill');
    navPills.forEach(pill => {
        pill.classList.remove('active');
        if (pill.getAttribute('data-section') === sectionId) {
            pill.classList.add('active');
            // Scroll the pill into view if needed (for mobile)
            pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    });
}

function updateNavOnScroll() {
    if (!elements.resultsNav || elements.resultsSection.classList.contains('hidden')) return;
    
    const navPills = elements.resultsNav.querySelectorAll('.nav-pill');
    const navHeight = elements.resultsNav.offsetHeight;
    const scrollPosition = window.scrollY + navHeight + 100; // Offset for better UX
    
    let currentSection = null;
    
    navPills.forEach(pill => {
        const sectionId = pill.getAttribute('data-section');
        const section = document.getElementById(sectionId);
        
        if (section) {
            const sectionTop = section.offsetTop;
            const sectionBottom = sectionTop + section.offsetHeight;
            
            if (scrollPosition >= sectionTop && scrollPosition < sectionBottom) {
                currentSection = sectionId;
            }
        }
    });
    
    if (currentSection) {
        updateActiveNavPill(currentSection);
    }
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
        // Collapse after a short delay to show the "Saved!" message
        setTimeout(() => {
            collapseApiKeySection();
        }, 1000);
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
    // Handle wearable tab specially - show modal instead of switching
    if (tab === 'wearable') {
        showWearableModal();
        return;
    }
    
    state.inputMode = tab;

    elements.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    elements.audioTab.classList.toggle('active', tab === 'audio');
    elements.pdfTab.classList.toggle('active', tab === 'pdf');
    elements.imageTab.classList.toggle('active', tab === 'image');
    elements.videoTab.classList.toggle('active', tab === 'video');
    elements.textTab.classList.toggle('active', tab === 'text');
    elements.urlTab.classList.toggle('active', tab === 'url');
    
    const wearableTab = document.getElementById('wearable-tab');
    if (wearableTab) {
        wearableTab.classList.toggle('active', tab === 'wearable');
    }

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
    state.exportMeta.source.audio = getFileMeta(file);
    elements.fileName.textContent = file.name;
    elements.fileInfo.classList.remove('hidden');
    elements.dropZone.style.display = 'none';
    updateAnalyzeButton();
}

function removeSelectedFile() {
    state.selectedFile = null;
    state.exportMeta.source.audio = null;
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
    state.exportMeta.source.pdf = getFileMeta(file);
    elements.pdfFileName.textContent = file.name;
    elements.pdfFileInfo.classList.remove('hidden');
    elements.pdfDropZone.style.display = 'none';
    updateAnalyzeButton();
}

function removeSelectedPdfFile() {
    state.selectedPdfFile = null;
    state.exportMeta.source.pdf = null;
    elements.pdfFileInput.value = '';
    elements.pdfFileInfo.classList.add('hidden');
    elements.pdfDropZone.style.display = 'block';
    updateAnalyzeButton();
}

// ============================================
// Image File Handling
// ============================================
function handleImageDragOver(e) {
    e.preventDefault();
    elements.imageDropZone.classList.add('dragover');
}

function handleImageDragLeave(e) {
    e.preventDefault();
    elements.imageDropZone.classList.remove('dragover');
}

function handleImageDrop(e) {
    e.preventDefault();
    elements.imageDropZone.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
        processSelectedImageFile(files[0]);
    }
}

function handleImageFileSelect(e) {
    if (e.target.files.length > 0) {
        processSelectedImageFile(e.target.files[0]);
    }
}

async function processSelectedImageFile(file) {
    const allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const extension = file.name.split('.').pop().toLowerCase();

    if (!allowedFormats.includes(extension)) {
        showError(`Invalid file format. Supported formats: ${allowedFormats.join(', ')}`);
        return;
    }

    // Check file size (20MB limit for images)
    if (file.size > 20 * 1024 * 1024) {
        showError('File size exceeds 20MB limit.');
        return;
    }

    // Convert image to base64 for Vision API
    try {
        const base64 = await fileToBase64(file);
        state.selectedImageFile = file;
        state.selectedImageBase64 = base64;
        state.exportMeta.source.image = getFileMeta(file);

        // Update UI
        elements.imageFileName.textContent = file.name;
        elements.imageFileInfo.classList.remove('hidden');
        elements.imageDropZone.style.display = 'none';

        // Show image preview
        elements.imagePreviewImg.src = base64;
        elements.imagePreview.classList.remove('hidden');

        updateAnalyzeButton();
    } catch (error) {
        showError('Failed to process image file.');
        console.error('Image processing error:', error);
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function base64ToBlob(base64, mimeType) {
    if (!base64) return null;
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

function removeSelectedImageFile() {
    state.selectedImageFile = null;
    state.selectedImageBase64 = null;
    state.exportMeta.source.image = null;
    elements.imageFileInput.value = '';
    elements.imageFileInfo.classList.add('hidden');
    elements.imagePreview.classList.add('hidden');
    elements.imagePreviewImg.src = '';
    elements.imageDropZone.style.display = 'block';
    updateAnalyzeButton();
}

// ============================================
// Video File Handling
// ============================================
function handleVideoDragOver(e) {
    e.preventDefault();
    elements.videoDropZone.classList.add('dragover');
}

function handleVideoDragLeave(e) {
    e.preventDefault();
    elements.videoDropZone.classList.remove('dragover');
}

function handleVideoDrop(e) {
    e.preventDefault();
    elements.videoDropZone.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
        processSelectedVideoFile(files[0]);
    }
}

function handleVideoFileSelect(e) {
    if (e.target.files.length > 0) {
        processSelectedVideoFile(e.target.files[0]);
    }
}

function processSelectedVideoFile(file) {
    // Whisper-compatible formats: mp3, mp4, mpeg, mpga, m4a, wav, webm
    const allowedFormats = ['mp4', 'webm', 'mpeg', 'mpga', 'm4a', 'mp3', 'wav'];
    const extension = file.name.split('.').pop().toLowerCase();

    if (!allowedFormats.includes(extension)) {
        showError(`Invalid file format. Whisper supports: MP4, WebM, MPEG, M4A, MP3, WAV`);
        return;
    }

    // Check file size (OpenAI Whisper limit is 25MB)
    if (file.size > 25 * 1024 * 1024) {
        showError('File size exceeds 25MB limit for transcription.');
        return;
    }

    state.selectedVideoFile = file;
    state.exportMeta.source.video = getFileMeta(file);
    elements.videoFileName.textContent = file.name;
    elements.videoFileInfo.classList.remove('hidden');
    elements.videoDropZone.style.display = 'none';
    updateAnalyzeButton();
}

function removeSelectedVideoFile() {
    state.selectedVideoFile = null;
    state.exportMeta.source.video = null;
    elements.videoFileInput.value = '';
    elements.videoFileInfo.classList.add('hidden');
    elements.videoDropZone.style.display = 'block';
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
    if (state.exportMeta?.processing?.pdf) {
        state.exportMeta.processing.pdf.totalPages = totalPages;
        state.exportMeta.processing.pdf.usedVisionOcr = false;
        state.exportMeta.processing.pdf.ocrPagesAnalyzed = 0;
        state.exportMeta.processing.pdf.ocrPageLimit = 0;
    }

    for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + '\n\n';

        // Update progress for large PDFs
        const progress = Math.round((i / totalPages) * 20);
        updateProgress(progress, `Extracting text from PDF (page ${i}/${totalPages})...`);
    }

    fullText = fullText.trim();

    // Return both text and PDF object for potential image-based processing
    return { text: fullText, pdf, totalPages };
}

// ============================================
// PDF to Image Conversion (for image-based PDFs)
// ============================================
async function renderPdfPagesToImages(pdf, totalPages, maxPages = 5) {
    const images = [];
    const pagesToRender = Math.min(totalPages, maxPages);

    for (let i = 1; i <= pagesToRender; i++) {
        updateProgress(10 + Math.round((i / pagesToRender) * 10), `Converting PDF page ${i}/${pagesToRender} to image...`);

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better OCR

        // Create canvas
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // Render page to canvas
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;

        // Convert canvas to base64
        const base64Image = canvas.toDataURL('image/png');
        images.push(base64Image);
    }

    return images;
}

async function analyzeImageBasedPdf(pdf, totalPages) {
    updateProgress(10, 'Detected image-based PDF. Converting pages to images...');

    // Render PDF pages to images
    const images = await renderPdfPagesToImages(pdf, totalPages);
    if (state.exportMeta?.processing?.pdf) {
        state.exportMeta.processing.pdf.usedVisionOcr = true;
        state.exportMeta.processing.pdf.ocrPagesAnalyzed = images.length;
        state.exportMeta.processing.pdf.ocrPageLimit = Math.min(totalPages, images.length);
    }

    updateProgress(25, 'Analyzing PDF images with Vision AI...');

    // Analyze each page with Vision API and combine results
    const pageResults = [];

    for (let i = 0; i < images.length; i++) {
        updateProgress(25 + Math.round((i / images.length) * 20), `Analyzing page ${i + 1}/${images.length} with Vision AI...`);

        const pageContent = await analyzeImageWithVision(images[i]);
        pageResults.push(`--- Page ${i + 1} ---\n${pageContent}`);
    }

    // If there are more pages than we analyzed, add a note
    let combinedText = pageResults.join('\n\n');
    if (totalPages > images.length) {
        combinedText += `\n\n[Note: Only the first ${images.length} of ${totalPages} pages were analyzed.]`;
    }

    return combinedText;
}

// ============================================
// Image Analysis with Vision API
// ============================================
async function analyzeImageWithVision(base64Image) {
    const response = await fetchOpenAI('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: GPT_52_MODEL,
            messages: [
                {
                    role: 'system',
                        content: PROMPTS.visionOcrSystem
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Please analyze this image and extract all text content and relevant visual information. This appears to be engineering or design code content that needs to be analyzed.'
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: base64Image,
                                detail: 'high'
                            }
                        }
                    ]
                }
            ],
            max_completion_tokens: 4000,
            temperature: 0.3
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `Vision API error: ${response.status}`);
    }

    const data = await response.json();

    // Track metrics
    if (data.usage) {
        currentMetrics.gptInputTokens += data.usage.prompt_tokens || 0;
        currentMetrics.gptOutputTokens += data.usage.completion_tokens || 0;
    }
    currentMetrics.apiCalls.push({
        endpoint: 'chat/completions (vision)',
        model: GPT_52_MODEL,
        tokens: data.usage?.total_tokens || 0
    });

    return data.choices[0]?.message?.content || '';
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
        } else if (state.inputMode === 'image' && state.selectedImageFile) {
            canAnalyze = true;
        } else if (state.inputMode === 'video' && state.selectedVideoFile) {
            canAnalyze = true;
        } else if (state.inputMode === 'text' && elements.textInput.value.trim()) {
            canAnalyze = true;
        } else if (state.inputMode === 'url' && state.urlContent) {
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
        chatInputTokens: 0,
        chatOutputTokens: 0,
        ttsCharacters: 0,
        imageInputTokens: 0,
        imageOutputTokens: 0,
        apiCalls: []
    };
    const analysisStartMs = performance.now();
    const analysisStartIso = new Date().toISOString();
    state.exportMeta.processing = {
        inputMode: state.inputMode,
        analysis: {
            startedAt: analysisStartIso,
            completedAt: null,
            durationMs: null,
            mode: null,
            usedFallback: false,
            jsonRecovered: false
        },
        transcriptionMethod: null,
        pdf: {
            totalPages: null,
            usedVisionOcr: false,
            ocrPagesAnalyzed: 0,
            ocrPageLimit: 0
        }
    };
    
    try {
        let transcriptionText;

        if (state.inputMode === 'audio') {
            state.exportMeta.processing.transcriptionMethod = 'whisper-1';
            updateProgress(5, 'Transcribing audio with Whisper...');
            transcriptionText = await transcribeAudio(state.selectedFile);
        } else if (state.inputMode === 'pdf') {
            state.exportMeta.processing.transcriptionMethod = 'pdf.js';
            updateProgress(5, 'Extracting text from PDF...');
            const pdfResult = await extractTextFromPdf(state.selectedPdfFile);

            // Check if PDF has meaningful text content
            if (!pdfResult.text || pdfResult.text.length < 50) {
                // PDF appears to be image-based, use Vision API
                state.exportMeta.processing.transcriptionMethod = 'vision-ocr';
                transcriptionText = await analyzeImageBasedPdf(pdfResult.pdf, pdfResult.totalPages);

                if (!transcriptionText || transcriptionText.length < 10) {
                    throw new Error('Could not extract content from PDF. The file may be empty or unreadable.');
                }
            } else {
                transcriptionText = pdfResult.text;
            }
        } else if (state.inputMode === 'image') {
            state.exportMeta.processing.transcriptionMethod = 'vision-ocr';
            updateProgress(5, 'Analyzing image with Vision AI...');
            transcriptionText = await analyzeImageWithVision(state.selectedImageBase64);

            if (!transcriptionText || transcriptionText.length < 10) {
                throw new Error('Could not extract meaningful content from the image.');
            }
        } else if (state.inputMode === 'video') {
            state.exportMeta.processing.transcriptionMethod = 'whisper-1';
            updateProgress(5, 'Transcribing video audio with Whisper...');
            transcriptionText = await transcribeAudio(state.selectedVideoFile);
        } else if (state.inputMode === 'url') {
            state.exportMeta.processing.transcriptionMethod = 'url-extract';
            transcriptionText = state.urlContent;

            if (!transcriptionText || transcriptionText.length < 10) {
                throw new Error('No content available from URL. Please fetch the URL first.');
            }
        } else {
            state.exportMeta.processing.transcriptionMethod = 'text-input';
            transcriptionText = elements.textInput.value.trim();
        }

        updateProgress(30, 'Analyzing design code content...');
        const analysis = await analyzeMeetingBatch(transcriptionText);
        const analysisMeta = analysis._meta || {};
        state.exportMeta.processing.analysis = {
            ...state.exportMeta.processing.analysis,
            ...analysisMeta,
            model: GPT_52_MODEL,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - analysisStartMs)
        };

        updateProgress(100, 'Complete!');
        
        // Calculate costs
        const metrics = calculateMetrics();
        
        state.results = {
            sourceText: analysis.sourceText || transcriptionText,
            codeOverview: analysis.codeOverview,
            requirements: analysis.requirements,
            designParameters: analysis.designParameters,
            crossReferences: analysis.crossReferences,
            complianceNotes: analysis.complianceNotes
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
// Response Caching
// ============================================

const responseCache = new Map();
const MAX_CACHE_SIZE = 50; // Limit cache size to prevent memory issues

function getCacheKey(systemPrompt, userContent) {
    // Create a hash-like key from the prompts
    const combined = systemPrompt + '::' + userContent;
    // Use a simple but effective cache key
    try {
        return btoa(encodeURIComponent(combined)).slice(0, 64);
    } catch (e) {
        // Fallback if btoa fails on large content
        return combined.substring(0, 100);
    }
}

function getCachedResponse(systemPrompt, userContent) {
    const key = getCacheKey(systemPrompt, userContent);
    return responseCache.get(key);
}

function cacheResponse(systemPrompt, userContent, response) {
    // Implement LRU-style caching - remove oldest if at capacity
    if (responseCache.size >= MAX_CACHE_SIZE) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
    }

    const key = getCacheKey(systemPrompt, userContent);
    responseCache.set(key, response);
}

// ============================================
// Error Handling & Retry Logic
// ============================================

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAPIWithRetry(fn, maxRetries = 3, operation = 'API call') {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Don't retry on client errors (4xx except 429)
            if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw error;
            }

            // For rate limits (429) or server errors (5xx), retry with exponential backoff
            if (attempt < maxRetries - 1) {
                const delay = Math.min(2000 * Math.pow(2, attempt), 16000); // Max 16 seconds
                console.warn(`${operation} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`, error.message);
                await sleep(delay);
            }
        }
    }

    // All retries exhausted
    throw new Error(`${operation} failed after ${maxRetries} attempts: ${lastError.message}`);
}

// ============================================
// OpenAI API Calls
// ============================================
async function transcribeAudio(file) {
    return await callAPIWithRetry(async () => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('model', 'whisper-1');

        const response = await fetchOpenAI('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${state.apiKey}`
            },
            body: formData
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const err = new Error(error.error?.message || `Transcription failed: ${response.status}`);
            err.status = response.status;
            throw err;
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
    }, 3, 'Audio transcription');
}

async function callChatAPI(systemPrompt, userContent, callName = 'API Call', useCache = true) {
    // Check cache first (only for deterministic calls with temperature=0)
    if (useCache) {
        const cached = getCachedResponse(systemPrompt, userContent);
        if (cached) {
            console.log(`[Cache Hit] ${callName}`);
            return cached;
        }
    }

    const result = await callAPIWithRetry(async () => {
        const response = await fetchOpenAI('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${state.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: GPT_52_MODEL,
                temperature: 0,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ]
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const err = new Error(error.error?.message || `API call failed: ${response.status}`);
            err.status = response.status;
            throw err;
        }

        const data = await response.json();

        // Track token usage
        if (data.usage) {
            currentMetrics.gptInputTokens += data.usage.prompt_tokens || 0;
            currentMetrics.gptOutputTokens += data.usage.completion_tokens || 0;
            currentMetrics.apiCalls.push({
                name: callName,
                model: GPT_52_MODEL,
                inputTokens: data.usage.prompt_tokens || 0,
                outputTokens: data.usage.completion_tokens || 0
            });
        }

        return data.choices[0].message.content;
    }, 3, callName);

    // Cache the result
    if (useCache) {
        cacheResponse(systemPrompt, userContent, result);
    }

    return result;
}

function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
}

async function analyzeMeetingBatch(text) {
    const meta = {
        mode: 'batch-json',
        jsonRecovered: false,
        usedFallback: false
    };
    const systemPrompt = PROMPTS.analysisBatchSystem;

    const response = await callChatAPI(systemPrompt, text, 'Code Analysis');

    try {
        // Try to parse the JSON response
        const parsed = JSON.parse(response);
        return {
            codeOverview: parsed.codeOverview || '',
            requirements: normalizeArray(parsed.requirements),
            designParameters: normalizeArray(parsed.designParameters),
            crossReferences: normalizeArray(parsed.crossReferences),
            complianceNotes: normalizeArray(parsed.complianceNotes),
            sourceText: parsed.sourceText || text,
            _meta: meta
        };
    } catch (error) {
        // Fallback: try to extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                meta.jsonRecovered = true;
                meta.mode = 'batch-json-extracted';
                return {
                    codeOverview: parsed.codeOverview || '',
                    requirements: normalizeArray(parsed.requirements),
                    designParameters: normalizeArray(parsed.designParameters),
                    crossReferences: normalizeArray(parsed.crossReferences),
                    complianceNotes: normalizeArray(parsed.complianceNotes),
                    sourceText: parsed.sourceText || text,
                    _meta: meta
                };
            } catch (e) {
                console.warn('Batch analysis failed, falling back to overview-only extraction');
                meta.usedFallback = true;
                meta.mode = 'fallback-overview';
                const codeOverview = await extractCodeOverview(text);
                return {
                    codeOverview,
                    requirements: [],
                    designParameters: [],
                    crossReferences: [],
                    complianceNotes: [],
                    sourceText: text,
                    _meta: meta
                };
            }
        }
        // Final fallback
        console.warn('JSON extraction failed, falling back to overview-only extraction');
        meta.usedFallback = true;
        meta.mode = 'fallback-overview';
        const codeOverview = await extractCodeOverview(text);
        return {
            codeOverview,
            requirements: [],
            designParameters: [],
            crossReferences: [],
            complianceNotes: [],
            sourceText: text,
            _meta: meta
        };
    }
}

async function extractCodeOverview(text) {
    const systemPrompt = PROMPTS.summarySystem;

    return await callChatAPI(systemPrompt, text, 'Code Overview');
}

// ============================================
// Metrics Calculation
// ============================================
function calculateMetrics() {
    const whisperCost = currentMetrics.whisperMinutes * PRICING['whisper-1'].perMinute;
    const gptInputCost = (currentMetrics.gptInputTokens / 1000000) * PRICING[GPT_52_MODEL].input;
    const gptOutputCost = (currentMetrics.gptOutputTokens / 1000000) * PRICING[GPT_52_MODEL].output;
    const ttsCost = (currentMetrics.ttsCharacters / 1000) * PRICING['gpt-4o-mini-tts'].perKChars;
    const imageInputCost = (currentMetrics.imageInputTokens / 1000000) * PRICING['gpt-image-1.5'].input;
    const imageOutputCost = (currentMetrics.imageOutputTokens / 1000000) * PRICING['gpt-image-1.5'].output;
    const imageCost = imageInputCost + imageOutputCost;
    const totalCost = whisperCost + gptInputCost + gptOutputCost + ttsCost + imageCost;
    
    return {
        whisperMinutes: currentMetrics.whisperMinutes,
        gptInputTokens: currentMetrics.gptInputTokens,
        gptOutputTokens: currentMetrics.gptOutputTokens,
        totalTokens: currentMetrics.gptInputTokens + currentMetrics.gptOutputTokens,
        ttsCharacters: currentMetrics.ttsCharacters,
        imageInputTokens: currentMetrics.imageInputTokens,
        imageOutputTokens: currentMetrics.imageOutputTokens,
        imageTotalTokens: currentMetrics.imageInputTokens + currentMetrics.imageOutputTokens,
        whisperCost,
        gptInputCost,
        gptOutputCost,
        ttsCost,
        imageInputCost,
        imageOutputCost,
        imageCost,
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
    
    // Collapse the setup section to focus on results
    const setupSection = document.getElementById('setup-section');
    if (setupSection) {
        setupSection.removeAttribute('open');
    }
    
    elements.resultsSection.classList.remove('hidden');
    
    // ========== KPI DASHBOARD ==========
    updateKPIDashboard();
    
    // Code Overview
    if (elements.resultOverview) {
        elements.resultOverview.innerHTML = `<p>${escapeHtml(state.results.codeOverview || '')}</p>`;
    }

    // Requirements
    if (elements.resultRequirements) {
        elements.resultRequirements.innerHTML = formatRequirements(state.results.requirements);
    }

    // Design Parameters
    if (elements.resultParameters) {
        elements.resultParameters.innerHTML = formatDesignParameters(state.results.designParameters);
    }

    // Cross-References
    if (elements.resultCrossrefs) {
        elements.resultCrossrefs.innerHTML = formatCrossReferences(state.results.crossReferences);
    }

    // Compliance Notes
    if (elements.resultCompliance) {
        elements.resultCompliance.innerHTML = formatComplianceNotes(state.results.complianceNotes);
    }

    // Source Text
    if (elements.resultSourceText) {
        elements.resultSourceText.innerHTML = formatSourceText(state.results.sourceText);
    }
    
    // Display metrics
    displayMetrics();
    
    // Scroll to results
    elements.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================
// KPI Dashboard
// ============================================
function updateKPIDashboard() {
    if (!state.results) return;

    const kpiCodeType = document.getElementById('kpi-code-type');
    if (kpiCodeType) {
        kpiCodeType.textContent = deriveCodeType(state.results);
    }

    const kpiRequirements = document.getElementById('kpi-requirements');
    if (kpiRequirements) {
        kpiRequirements.textContent = (state.results.requirements || []).length.toString();
    }

    const kpiParameters = document.getElementById('kpi-parameters');
    if (kpiParameters) {
        kpiParameters.textContent = (state.results.designParameters || []).length.toString();
    }

    const kpiCrossrefs = document.getElementById('kpi-crossrefs');
    if (kpiCrossrefs) {
        kpiCrossrefs.textContent = (state.results.crossReferences || []).length.toString();
    }

    const kpiCompliance = document.getElementById('kpi-compliance');
    if (kpiCompliance) {
        kpiCompliance.textContent = (state.results.complianceNotes || []).length.toString();
    }

    const kpiSections = document.getElementById('kpi-sections');
    if (kpiSections) {
        kpiSections.textContent = deriveSectionCount(state.results).toString();
    }
}

function deriveCodeType(results) {
    const candidates = [
        results.codeOverview || '',
        results.sourceText || '',
        ...(results.requirements || []).map(req => req.id || ''),
        ...(results.requirements || []).map(req => req.section || '')
    ].join(' ');
    const match = candidates.match(/\b(ASCE|AASHTO|ACI|AISC|IBC|ASME|IEEE|NFPA)\b/i);
    return match ? match[0].toUpperCase() : 'Unknown';
}

function deriveSectionCount(results) {
    const sections = new Set();
    (results.requirements || []).forEach(req => {
        if (req.section) sections.add(req.section);
    });
    (results.designParameters || []).forEach(param => {
        if (param.section) sections.add(param.section);
    });
    (results.crossReferences || []).forEach(ref => {
        if (ref.source) sections.add(ref.source);
        if (ref.target) sections.add(ref.target);
    });
    return sections.size;
}

// Format number with commas
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toLocaleString();
}

function displayMetrics() {
    const metrics = state.metrics;
    if (!metrics) return;
    
    const resultMetrics = document.getElementById('result-metrics');
    if (!resultMetrics) return;
    
    // Handle imported agents with a simpler display
    if (metrics.isImported) {
        resultMetrics.innerHTML = `
            <div class="metrics-imported">
                <div class="imported-badge">
                    <span>📥</span> Imported Agent
                </div>
                <p class="imported-note">
                    This session was loaded from an agent file.<br>
                    No API usage data available from the original analysis.
                </p>
                <p class="imported-hint">
                    Chat, audio, and infographic features will track new API calls.
                </p>
            </div>
        `;
        return;
    }
    
    let breakdownHtml = '';
    metrics.apiCalls.forEach(call => {
        if (call.model === 'whisper-1') {
            breakdownHtml += `
                <div class="metric-breakdown-item">
                    <span>${call.name}</span>
                    <span>${call.duration}</span>
                </div>`;
        } else if (call.model === 'gpt-4o-mini-tts') {
            breakdownHtml += `
                <div class="metric-breakdown-item">
                    <span>${call.name}</span>
                    <span>${call.characters.toLocaleString()} chars</span>
                </div>`;
        } else if (call.model === 'gpt-image-1.5') {
            breakdownHtml += `
                <div class="metric-breakdown-item">
                    <span>${call.name}</span>
                    <span>${formatTokens(call.inputTokens + call.outputTokens)} tokens</span>
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
            ${metrics.ttsCharacters > 0 ? `
            <div class="metric-breakdown-item">
                <span>TTS Audio</span>
                <span>${metrics.ttsCharacters.toLocaleString()} chars (${formatCost(metrics.ttsCost)})</span>
            </div>` : ''}
            ${metrics.imageTotalTokens > 0 ? `
            <div class="metric-breakdown-item">
                <span>GPT-Image Input</span>
                <span>${formatTokens(metrics.imageInputTokens)} tokens (${formatCost(metrics.imageInputCost)})</span>
            </div>
            <div class="metric-breakdown-item">
                <span>GPT-Image Output</span>
                <span>${formatTokens(metrics.imageOutputTokens)} tokens (${formatCost(metrics.imageOutputCost)})</span>
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

function formatListFromArray(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return '<p class="muted">No items available.</p>';
    }
    const listItems = items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
    return `<ul>${listItems}</ul>`;
}

function formatRequirements(requirements) {
    if (!Array.isArray(requirements) || requirements.length === 0) {
        return '<p class="muted">No requirements extracted.</p>';
    }
    const listItems = requirements.map(req => {
        const id = req.id ? `<strong>${escapeHtml(req.id)}</strong> ` : '';
        const text = req.text ? escapeHtml(req.text) : '';
        const metaParts = [];
        if (req.section) metaParts.push(`Section: ${escapeHtml(req.section)}`);
        if (req.type) metaParts.push(`Type: ${escapeHtml(req.type)}`);
        if (Array.isArray(req.keywords) && req.keywords.length > 0) {
            metaParts.push(`Keywords: ${escapeHtml(req.keywords.join(', '))}`);
        }
        const meta = metaParts.length > 0 ? `<br><span class="muted">${metaParts.join(' • ')}</span>` : '';
        return `<li>${id}${text}${meta}</li>`;
    }).join('');
    return `<ul>${listItems}</ul>`;
}

function formatDesignParameters(parameters) {
    if (!Array.isArray(parameters) || parameters.length === 0) {
        return '<p class="muted">No design parameters extracted.</p>';
    }
    const listItems = parameters.map(param => {
        const name = param.name ? `<strong>${escapeHtml(param.name)}</strong>` : '<strong>Parameter</strong>';
        const value = param.value ? `: ${escapeHtml(param.value)}` : '';
        const unit = param.unit ? ` ${escapeHtml(param.unit)}` : '';
        const metaParts = [];
        if (param.id) metaParts.push(`ID: ${escapeHtml(param.id)}`);
        if (param.section) metaParts.push(`Section: ${escapeHtml(param.section)}`);
        if (param.applicability) metaParts.push(`Applies: ${escapeHtml(param.applicability)}`);
        const meta = metaParts.length > 0 ? `<br><span class="muted">${metaParts.join(' • ')}</span>` : '';
        return `<li>${name}${value}${unit}${meta}</li>`;
    }).join('');
    return `<ul>${listItems}</ul>`;
}

function formatCrossReferences(crossReferences) {
    if (!Array.isArray(crossReferences) || crossReferences.length === 0) {
        return '<p class="muted">No cross-references extracted.</p>';
    }
    const listItems = crossReferences.map(ref => {
        const source = ref.source ? escapeHtml(ref.source) : 'Source';
        const target = ref.target ? escapeHtml(ref.target) : 'Target';
        const relationship = ref.relationship ? ` (${escapeHtml(ref.relationship)})` : '';
        const note = ref.note ? `<br><span class="muted">${escapeHtml(ref.note)}</span>` : '';
        return `<li><strong>${source}</strong> → ${target}${relationship}${note}</li>`;
    }).join('');
    return `<ul>${listItems}</ul>`;
}

function formatComplianceNotes(notes) {
    if (!Array.isArray(notes) || notes.length === 0) {
        return '<p class="muted">No compliance notes extracted.</p>';
    }
    return formatListFromArray(notes);
}

function formatSourceText(text) {
    if (!text) {
        return '<p class="muted">No source text available.</p>';
    }
    return `<pre>${escapeHtml(text)}</pre>`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function formatTokens(tokens) {
    return tokens.toLocaleString();
}

function formatCost(cost) {
    return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(4)}`;
}

// ============================================
// DOCX Generation - Professional Export
// ============================================
async function downloadDocx() {
    if (!state.results) return;
    
    const { 
        Document, Paragraph, TextRun, HeadingLevel, Packer, ImageRun, 
        Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
        ShadingType, PageBreak, Header, Footer, TableOfContents,
        LevelFormat, convertInchesToTwip, ExternalHyperlink, NumberFormat,
        PageNumber, TextWrappingType, TextWrappingSide
    } = docx;
    
    const currentDate = new Date().toLocaleDateString('en-US', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });
    const shortDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
    const codeType = deriveCodeType(state.results);
    const codeTitle = codeType === 'Unknown' ? 'Design Code Analysis' : `${codeType} Standard`;
    
    // ========== COLOR PALETTE ==========
    const colors = {
        primary: "1a365d",      // Deep navy
        secondary: "2d3748",    // Dark gray
        accent: "d4a853",       // Gold
        muted: "718096",        // Gray
        light: "e2e8f0",        // Light gray
        success: "22c55e",      // Green
        white: "ffffff",
        black: "000000"
    };
    
    // ========== HELPER FUNCTIONS ==========
    
    // Create a styled section heading (for TOC)
    const createHeading = (text, level = HeadingLevel.HEADING_1) => {
        return new Paragraph({
            text: text,
            heading: level,
            spacing: { before: 400, after: 200 },
            border: level === HeadingLevel.HEADING_1 ? {
                bottom: { color: colors.accent, size: 6, style: BorderStyle.SINGLE }
            } : undefined
        });
    };
    
    // Create a section heading with icon
    const createSectionHeading = (text, emoji = '') => {
        return new Paragraph({
            children: [
                new TextRun({
                    text: emoji ? `${emoji}  ` : '',
                    size: 28
                }),
                new TextRun({
                    text: text,
                    bold: true,
                    size: 28,
                    color: colors.primary,
                    font: "Calibri Light"
                })
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 400, after: 200 },
            border: {
                bottom: { color: colors.accent, size: 6, style: BorderStyle.SINGLE }
            }
        });
    };
    
    // Create subsection heading
    const createSubHeading = (text) => {
        return new Paragraph({
            children: [
                new TextRun({
                    text: text,
                    bold: true,
                    size: 24,
                    color: colors.secondary,
                    font: "Calibri"
                })
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 300, after: 150 }
        });
    };
    
    // Create proper bullet point using Word's native list
    const createBulletItem = (text, level = 0) => {
        return new Paragraph({
            children: [
                new TextRun({
                    text: text.replace(/^[-•*▸☐✓]\s*/, '').trim(),
                    size: 22,
                    font: "Calibri"
                })
            ],
            bullet: { level: level },
            spacing: { after: 100, line: 276 }
        });
    };
    
    // Create numbered list item
    const createNumberedItem = (text, level = 0) => {
        return new Paragraph({
            children: [
                new TextRun({
                    text: text.replace(/^\d+[.)]\s*/, '').replace(/^[-•*▸☐✓]\s*/, '').trim(),
                    size: 22,
                    font: "Calibri"
                })
            ],
            numbering: { reference: "actionItems", level: level },
            spacing: { after: 100, line: 276 }
        });
    };
    
    // Create a styled table
    const createStyledTable = (headers, rows) => {
        const headerCells = headers.map(h => new TableCell({
            children: [new Paragraph({
                children: [new TextRun({ text: h, bold: true, size: 20, color: colors.white, font: "Calibri" })],
                alignment: AlignmentType.CENTER
            })],
            shading: { fill: colors.primary, type: ShadingType.SOLID },
            margins: { top: 100, bottom: 100, left: 150, right: 150 }
        }));
        
        const dataRows = rows.map((row, idx) => new TableRow({
            children: row.map(cell => new TableCell({
                children: [new Paragraph({
                    children: [new TextRun({ text: String(cell), size: 20, font: "Calibri" })],
                    alignment: AlignmentType.LEFT
                })],
                shading: { fill: idx % 2 === 0 ? colors.light : colors.white, type: ShadingType.SOLID },
                margins: { top: 80, bottom: 80, left: 150, right: 150 }
            }))
        }));
        
        return new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
                new TableRow({ children: headerCells, tableHeader: true }),
                ...dataRows
            ],
            borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
                left: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
                right: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
                insideVertical: { style: BorderStyle.SINGLE, size: 1, color: colors.light }
            }
        });
    };
    
    // Create info box with shading
    const createInfoBox = (text, bgColor = "f7fafc") => {
        return new Paragraph({
            children: [
                new TextRun({
                    text: text,
                    size: 22,
                    font: "Calibri"
                })
            ],
            shading: { fill: bgColor, type: ShadingType.SOLID },
            border: {
                left: { color: colors.accent, size: 24, style: BorderStyle.SINGLE }
            },
            spacing: { before: 100, after: 200 },
            indent: { left: 200, right: 200 }
        });
    };
    
    // ========== BUILD DOCUMENT CONTENT ==========
    const children = [];
    
    // ========== COVER PAGE ==========
    // Spacer for visual balance
    children.push(new Paragraph({ spacing: { before: 1000 } }));
    
    // Decorative top border
    children.push(new Paragraph({
        border: {
            top: { color: colors.accent, size: 24, style: BorderStyle.SINGLE }
        },
        spacing: { after: 600 }
    }));
    
    // Main Title
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "DESIGN CODE",
                bold: true,
                size: 72,
                color: colors.primary,
                font: "Calibri Light"
            })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 }
    }));
    
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "INSIGHTS REPORT",
                bold: true,
                size: 72,
                color: colors.accent,
                font: "Calibri Light"
            })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 }
    }));
    
    // Decorative line
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                color: colors.accent,
                size: 24
            })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 }
    }));
    
    // Date
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: currentDate,
                size: 28,
                color: colors.secondary,
                font: "Calibri"
            })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 }
    }));
    
    // ========== CODE DETAILS BOX ==========
    children.push(new Paragraph({ spacing: { before: 600 } }));
    
    // Code details table
    const codeDetailsTable = new Table({
        width: { size: 60, type: WidthType.PERCENTAGE },
        alignment: AlignmentType.CENTER,
        rows: [
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({
                            children: [new TextRun({ text: "Code Standard:", bold: true, size: 22, font: "Calibri" })]
                        })],
                        width: { size: 30, type: WidthType.PERCENTAGE },
                        margins: { top: 100, bottom: 100, left: 200, right: 100 }
                    }),
                    new TableCell({
                        children: [new Paragraph({
                            children: [new TextRun({
                                text: codeTitle,
                                size: 22,
                                font: "Calibri"
                            })]
                        })],
                        margins: { top: 100, bottom: 100, left: 100, right: 200 }
                    })
                ]
            }),
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({
                            children: [new TextRun({ text: "Date:", bold: true, size: 22, font: "Calibri" })]
                        })],
                        margins: { top: 100, bottom: 100, left: 200, right: 100 }
                    }),
                    new TableCell({
                        children: [new Paragraph({
                            children: [new TextRun({
                                text: shortDate,
                                size: 22,
                                font: "Calibri"
                            })]
                        })],
                        margins: { top: 100, bottom: 100, left: 100, right: 200 }
                    })
                ]
            }),
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({
                            children: [new TextRun({ text: "Source:", bold: true, size: 22, font: "Calibri" })]
                        })],
                        margins: { top: 100, bottom: 100, left: 200, right: 100 }
                    }),
                    new TableCell({
                        children: [new Paragraph({
                            children: [new TextRun({ 
                                text: state.selectedFile ? `Audio: ${state.selectedFile.name}` : 
                                      state.selectedPdfFile ? `PDF: ${state.selectedPdfFile.name}` :
                                      state.urlContent ? 'URL Import' : 'Text Input',
                                size: 22, 
                                font: "Calibri",
                                italics: true
                            })]
                        })],
                        margins: { top: 100, bottom: 100, left: 100, right: 200 }
                    })
                ]
            })
        ],
        borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
            left: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
            right: { style: BorderStyle.SINGLE, size: 1, color: colors.light },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: colors.light }
        }
    });
    children.push(codeDetailsTable);
    
    // Branding at bottom of cover
    children.push(new Paragraph({ spacing: { before: 1200 } }));
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "Generated by ",
                size: 20,
                color: colors.muted,
                font: "Calibri"
            }),
            new TextRun({
                text: "northstar.LM",
                size: 20,
                color: colors.accent,
                bold: true,
                font: "Calibri"
            }),
            new TextRun({
                text: " • AI-Powered Design Code Analysis",
                size: 20,
                color: colors.muted,
                font: "Calibri"
            })
        ],
        alignment: AlignmentType.CENTER
    }));
    
    // Page break after cover
    children.push(new Paragraph({ children: [new PageBreak()] }));
    
    // ========== TABLE OF CONTENTS ==========
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "Table of Contents",
                bold: true,
                size: 32,
                color: colors.primary,
                font: "Calibri Light"
            })
        ],
        spacing: { after: 400 }
    }));
    
    children.push(new TableOfContents("Table of Contents", {
        hyperlink: true,
        headingStyleRange: "1-3"
    }));
    
    children.push(new Paragraph({ spacing: { after: 200 } }));
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "Note: Update this table by right-clicking and selecting 'Update Field' in Microsoft Word.",
                italics: true,
                size: 18,
                color: colors.muted
            })
        ],
        spacing: { after: 400 }
    }));
    
    // Page break after TOC
    children.push(new Paragraph({ children: [new PageBreak()] }));
    
    // ========== CODE OVERVIEW ==========
    children.push(createSectionHeading("Code Overview", "📋"));
    children.push(createInfoBox(state.results.codeOverview || '', "f0f9ff"));
    children.push(new Paragraph({ spacing: { after: 300 } }));
    
    // ========== REQUIREMENTS ==========
    children.push(createSectionHeading("Requirements", "📌"));
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "The following requirements were identified from the code:",
                size: 22,
                color: colors.muted,
                italics: true,
                font: "Calibri"
            })
        ],
        spacing: { after: 200 }
    }));
    
    if (Array.isArray(state.results.requirements) && state.results.requirements.length > 0) {
        state.results.requirements.forEach(req => {
            const line = `${req.id ? `${req.id}: ` : ''}${req.text || ''}`.trim();
            if (line) {
                children.push(createBulletItem(line));
            }
        });
    } else {
        children.push(createBulletItem("No requirements extracted."));
    }
    children.push(new Paragraph({ spacing: { after: 300 } }));
    
    // ========== DESIGN PARAMETERS ==========
    children.push(createSectionHeading("Design Parameters", "🔢"));
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "The following design parameters and formulas were extracted:",
                size: 22,
                color: colors.muted,
                italics: true,
                font: "Calibri"
            })
        ],
        spacing: { after: 200 }
    }));
    
    if (Array.isArray(state.results.designParameters) && state.results.designParameters.length > 0) {
        state.results.designParameters.forEach(param => {
            const value = [param.value, param.unit].filter(Boolean).join(' ').trim();
            const line = `${param.name || 'Parameter'}${value ? `: ${value}` : ''}${param.section ? ` (Section: ${param.section})` : ''}`;
            children.push(createBulletItem(line));
        });
    } else {
        children.push(createBulletItem("No design parameters extracted."));
    }
    children.push(new Paragraph({ spacing: { after: 300 } }));
    
    // ========== COMPLIANCE NOTES ==========
    children.push(createSectionHeading("Compliance Notes", "⚠️"));
    if (Array.isArray(state.results.complianceNotes) && state.results.complianceNotes.length > 0) {
        state.results.complianceNotes.forEach(note => {
            children.push(createBulletItem(note));
        });
    } else {
        children.push(createBulletItem("No compliance notes extracted."));
    }
    
    // ========== CHAT Q&A (if present) ==========
    const chatMessages = document.querySelectorAll('#chat-messages .chat-message');
    if (chatMessages && chatMessages.length > 1) {
        children.push(createSectionHeading("Questions & Answers", "💬"));
        children.push(new Paragraph({
            children: [
                new TextRun({
                    text: "The following questions were asked about the code content:",
                    size: 22,
                    color: colors.muted,
                    italics: true,
                    font: "Calibri"
                })
            ],
            spacing: { after: 200 }
        }));
        
        chatMessages.forEach(msg => {
            const isUser = msg.classList.contains('user');
            const content = msg.querySelector('.chat-message-content')?.textContent?.trim();
            if (content && !msg.querySelector('.chat-welcome')) {
                children.push(new Paragraph({
                    children: [
                        new TextRun({
                            text: isUser ? "Q: " : "A: ",
                            bold: true,
                            size: 22,
                            color: isUser ? colors.accent : colors.primary,
                            font: "Calibri"
                        }),
                        new TextRun({
                            text: content,
                            size: 22,
                            font: "Calibri",
                            italics: isUser
                        })
                    ],
                    shading: { fill: isUser ? "fffbeb" : "f0f9ff", type: ShadingType.SOLID },
                    spacing: { after: 100 },
                    indent: { left: 200, right: 200 }
                }));
            }
        });
        children.push(new Paragraph({ spacing: { after: 300 } }));
    }
    
    // ========== AUDIO BRIEFING (if generated) ==========
    if (generatedAudioUrl) {
        children.push(createSectionHeading("Audio Briefing", "🎧"));
        children.push(new Paragraph({
            children: [
                new TextRun({
                    text: "✓ AUDIO GENERATED",
                    bold: true,
                    size: 26,
                    color: colors.success,
                    font: "Calibri"
                })
            ],
            spacing: { after: 150 }
        }));
        children.push(new Paragraph({
            children: [
                new TextRun({
                    text: "An engineering audio briefing (~2 minutes) has been generated for this code analysis.",
                    size: 22,
                    font: "Calibri"
                })
            ],
            spacing: { after: 100 }
        }));
        children.push(new Paragraph({
            children: [
                new TextRun({
                    text: "📎 Attachment: ",
                    size: 22,
                    bold: true,
                    font: "Calibri"
                }),
                new TextRun({
                    text: `code-briefing-${new Date().toISOString().slice(0, 10)}.mp3`,
                    size: 22,
                    color: "2563eb",
                    font: "Calibri"
                })
            ],
            spacing: { after: 100 }
        }));
        children.push(new Paragraph({
            children: [
                new TextRun({
                    text: "Note: Download the MP3 file separately from northstar.LM. DOCX does not support embedded audio.",
                    size: 18,
                    italics: true,
                    color: colors.muted,
                    font: "Calibri"
                })
            ],
            spacing: { after: 400 }
        }));
    }
    
    // ========== INFOGRAPHIC (if generated) ==========
    if (generatedImageBase64) {
        try {
            const binaryString = atob(generatedImageBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const imageArrayBuffer = bytes.buffer;
            
            children.push(createSectionHeading("Code Infographic", "🎨"));
            children.push(new Paragraph({
                children: [
                    new ImageRun({
                        data: imageArrayBuffer,
                        transformation: {
                            width: 500,
                            height: 500
                        },
                        type: 'png'
                    })
                ],
                alignment: AlignmentType.CENTER,
                spacing: { after: 150 }
            }));
            children.push(new Paragraph({
                children: [
                    new TextRun({
                        text: "AI-generated infographic visualizing key code insights",
                        italics: true,
                        size: 18,
                        color: colors.muted,
                        font: "Calibri"
                    })
                ],
                alignment: AlignmentType.CENTER,
                spacing: { after: 400 }
            }));
        } catch (error) {
            console.error('Failed to embed infographic:', error);
        }
    }
    
    // ========== PROCESSING STATISTICS (as table) ==========
    if (state.metrics) {
        const metrics = state.metrics;
        children.push(createSectionHeading("Processing Statistics", "⚡"));
        
        // Build stats rows
        const statsRows = [];
        
        if (metrics.whisperMinutes > 0) {
            statsRows.push(["Audio Transcription", `${metrics.whisperMinutes.toFixed(2)} minutes`, "Whisper"]);
        }
        
        statsRows.push(["Text Analysis", formatTokens(metrics.totalTokens) + " tokens", "GPT-5.2"]);
        
        if (metrics.ttsCharacters > 0) {
            statsRows.push(["Audio Generation", metrics.ttsCharacters.toLocaleString() + " characters", "GPT-4o-mini-TTS"]);
        }
        
        if (metrics.imageTotalTokens > 0) {
            statsRows.push(["Image Generation", formatTokens(metrics.imageTotalTokens) + " tokens", "GPT-Image-1.5"]);
        }
        
        children.push(createStyledTable(["Operation", "Usage", "Model"], statsRows));
        children.push(new Paragraph({ spacing: { after: 200 } }));
        
        // Total cost in highlighted box
        children.push(new Paragraph({
            children: [
                new TextRun({
                    text: "Total Estimated Cost: ",
                    size: 24,
                    font: "Calibri"
                }),
                new TextRun({
                    text: formatCost(metrics.totalCost),
                    size: 28,
                    bold: true,
                    color: colors.accent,
                    font: "Calibri"
                })
            ],
            shading: { fill: "fffbeb", type: ShadingType.SOLID },
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 400 },
            border: {
                top: { style: BorderStyle.SINGLE, size: 1, color: colors.accent },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: colors.accent },
                left: { style: BorderStyle.SINGLE, size: 1, color: colors.accent },
                right: { style: BorderStyle.SINGLE, size: 1, color: colors.accent }
            }
        }));
        
        // API calls breakdown table
        if (metrics.apiCalls && metrics.apiCalls.length > 0) {
            children.push(createSubHeading("API Calls Breakdown"));
            
            const apiRows = metrics.apiCalls.map(call => {
                let detail = '';
                if (call.model === 'gpt-4o-mini-tts') {
                    detail = `${call.characters.toLocaleString()} chars`;
                } else if (call.model === 'gpt-image-1.5') {
                    detail = `${formatTokens(call.inputTokens + call.outputTokens)} tokens`;
                } else if (call.duration) {
                    detail = call.duration;
                } else {
                    detail = `${formatTokens((call.inputTokens || 0) + (call.outputTokens || 0))} tokens`;
                }
                return [call.name, call.model, detail];
            });
            
            children.push(createStyledTable(["API Call", "Model", "Usage"], apiRows));
            children.push(new Paragraph({ spacing: { after: 400 } }));
        }
    }
    
    // ========== APPENDIX: FULL TRANSCRIPT ==========
    children.push(new Paragraph({ children: [new PageBreak()] }));
    
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "APPENDIX",
                bold: true,
                size: 36,
                color: colors.muted,
                font: "Calibri Light"
            })
        ],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 }
    }));
    
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "Full Source Text",
                size: 28,
                color: colors.secondary,
                font: "Calibri Light"
            })
        ],
        heading: HeadingLevel.HEADING_2,
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 }
    }));
    
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: "The following is the complete source text for reference.",
                italics: true,
                size: 18,
                color: colors.muted,
                font: "Calibri"
            })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 }
    }));
    
    children.push(new Paragraph({
        border: { bottom: { color: colors.light, size: 1, style: BorderStyle.SINGLE } },
        spacing: { after: 300 }
    }));
    
    // Source text content
    children.push(new Paragraph({
        children: [
            new TextRun({
                text: state.results.sourceText || '',
                size: 20,
                color: colors.secondary,
                font: "Calibri"
            })
        ],
        spacing: { after: 400, line: 320 }
    }));
    
    // ========== CREATE DOCUMENT WITH ALL FEATURES ==========
    const doc = new Document({
        creator: "northstar.LM",
        title: "Design Code Insights Report",
        subject: "AI-Generated Design Code Analysis",
        keywords: "design code, analysis, requirements, parameters, compliance, source text",
        description: "Design code insights report generated by northstar.LM",
        lastModifiedBy: "northstar.LM",
        styles: {
            default: {
                document: {
                    run: {
                        font: "Calibri",
                        size: 22
                    }
                },
                heading1: {
                    run: {
                        font: "Calibri Light",
                        size: 32,
                        bold: true,
                        color: colors.primary
                    },
                    paragraph: {
                        spacing: { before: 400, after: 200 }
                    }
                },
                heading2: {
                    run: {
                        font: "Calibri",
                        size: 26,
                        bold: true,
                        color: colors.secondary
                    },
                    paragraph: {
                        spacing: { before: 300, after: 150 }
                    }
                }
            },
            paragraphStyles: [
                {
                    id: "Normal",
                    name: "Normal",
                    run: {
                        font: "Calibri",
                        size: 22
                    },
                    paragraph: {
                        spacing: { line: 276 }
                    }
                }
            ]
        },
        numbering: {
            config: [
                {
                    reference: "actionItems",
                    levels: [
                        {
                            level: 0,
                            format: LevelFormat.DECIMAL,
                            text: "%1.",
                            alignment: AlignmentType.LEFT,
                            style: {
                                paragraph: {
                                    indent: { left: 720, hanging: 360 }
                                }
                            }
                        }
                    ]
                }
            ]
        },
        sections: [{
            properties: {
                page: {
                    margin: {
                        top: convertInchesToTwip(1),
                        right: convertInchesToTwip(1),
                        bottom: convertInchesToTwip(1),
                        left: convertInchesToTwip(1)
                    }
                }
            },
            headers: {
                default: new Header({
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: "Design Code Insights Report",
                                    size: 18,
                                    color: colors.muted,
                                    font: "Calibri"
                                }),
                                new TextRun({
                                    text: "  •  ",
                                    size: 18,
                                    color: colors.light
                                }),
                                new TextRun({
                                    text: shortDate,
                                    size: 18,
                                    color: colors.muted,
                                    font: "Calibri"
                                })
                            ],
                            alignment: AlignmentType.RIGHT,
                            border: {
                                bottom: { color: colors.light, size: 1, style: BorderStyle.SINGLE }
                            }
                        })
                    ]
                })
            },
            footers: {
                default: new Footer({
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: "Generated by northstar.LM",
                                    size: 16,
                                    color: colors.muted,
                                    font: "Calibri"
                                }),
                                new TextRun({
                                    text: "  |  Page ",
                                    size: 16,
                                    color: colors.light
                                }),
                                new TextRun({
                                    children: [PageNumber.CURRENT],
                                    size: 16,
                                    color: colors.muted
                                }),
                                new TextRun({
                                    text: " of ",
                                    size: 16,
                                    color: colors.light
                                }),
                                new TextRun({
                                    children: [PageNumber.TOTAL_PAGES],
                                    size: 16,
                                    color: colors.muted
                                })
                            ],
                            alignment: AlignmentType.CENTER,
                            border: {
                                top: { color: colors.light, size: 1, style: BorderStyle.SINGLE }
                            }
                        })
                    ]
                })
            },
            children: children
        }]
    });
    
    // Generate and download
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code-insights-${new Date().toISOString().slice(0, 10)}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================
// Reset / New Analysis
// ============================================
function resetForNewAnalysis() {
    console.log('[resetForNewAnalysis] Starting full reset...');
    
    // Reset all state
    state.results = null;
    state.metrics = null;
    state.selectedFile = null;
    state.selectedPdfFile = null;
    state.selectedImageFile = null;
    state.selectedImageBase64 = null;
    state.selectedVideoFile = null;
    state.urlContent = null;
    state.sourceUrl = null;
    resetExportMeta();
    
    // Reset metrics tracking
    currentMetrics = {
        whisperMinutes: 0,
        gptInputTokens: 0,
        gptOutputTokens: 0,
        chatInputTokens: 0,
        chatOutputTokens: 0,
        ttsCharacters: 0,
        imageInputTokens: 0,
        imageOutputTokens: 0,
        apiCalls: []
    };
    
    // Reset chat history
    resetChatHistory();
    
    // Clean up generated audio/image URLs
    if (generatedAudioUrl) {
        URL.revokeObjectURL(generatedAudioUrl);
        generatedAudioUrl = null;
    }
    generatedAudioBase64 = null;
    generatedImageUrl = null;
    generatedImageBase64 = null;
    
    // Reset all file inputs
    elements.audioFileInput.value = '';
    elements.pdfFileInput.value = '';
    elements.imageFileInput.value = '';
    elements.videoFileInput.value = '';
    elements.textInput.value = '';
    elements.urlInput.value = '';
    
    // Reset audio file UI
    elements.fileInfo.classList.add('hidden');
    elements.dropZone.style.display = 'block';
    
    // Reset PDF file UI
    elements.pdfFileInfo.classList.add('hidden');
    elements.pdfDropZone.style.display = 'block';
    
    // Reset image file UI
    elements.imageFileInfo.classList.add('hidden');
    elements.imagePreview.classList.add('hidden');
    elements.imagePreviewImg.src = '';
    elements.imageDropZone.style.display = 'block';
    
    // Reset video file UI
    elements.videoFileInfo.classList.add('hidden');
    elements.videoDropZone.style.display = 'block';
    
    // Reset URL preview
    elements.urlPreview.classList.add('hidden');
    elements.urlPreviewContent.textContent = '';
    
    // Clear results content (not just hide)
    if (elements.resultOverview) elements.resultOverview.innerHTML = '';
    if (elements.resultRequirements) elements.resultRequirements.innerHTML = '';
    if (elements.resultParameters) elements.resultParameters.innerHTML = '';
    if (elements.resultCrossrefs) elements.resultCrossrefs.innerHTML = '';
    if (elements.resultCompliance) elements.resultCompliance.innerHTML = '';
    if (elements.resultSourceText) elements.resultSourceText.innerHTML = '';
    
    // Reset KPI dashboard values
    const kpiCodeType = document.getElementById('kpi-code-type');
    const kpiRequirements = document.getElementById('kpi-requirements');
    const kpiParameters = document.getElementById('kpi-parameters');
    const kpiCrossrefs = document.getElementById('kpi-crossrefs');
    const kpiCompliance = document.getElementById('kpi-compliance');
    const kpiSections = document.getElementById('kpi-sections');
    if (kpiCodeType) kpiCodeType.textContent = '-';
    if (kpiRequirements) kpiRequirements.textContent = '-';
    if (kpiParameters) kpiParameters.textContent = '-';
    if (kpiCrossrefs) kpiCrossrefs.textContent = '-';
    if (kpiCompliance) kpiCompliance.textContent = '-';
    if (kpiSections) kpiSections.textContent = '-';
    
    // Hide results section
    elements.resultsSection.classList.add('hidden');
    
    // Reset audio briefing section
    elements.audioPlayerContainer.classList.add('hidden');
    elements.audioPlayer.src = '';
    elements.audioPrompt.value = '';
    
    // Reset infographic section
    elements.infographicContainer.classList.add('hidden');
    elements.infographicImage.src = '';
    elements.infographicPrompt.value = '';
    
    updateAnalyzeButton();
    
    // Reopen the setup section
    const setupSection = document.getElementById('setup-section');
    if (setupSection) {
        setupSection.setAttribute('open', '');
    }
    
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    console.log('[resetForNewAnalysis] Reset complete. State:', {
        results: state.results,
        selectedFile: state.selectedFile,
        selectedPdfFile: state.selectedPdfFile,
        selectedImageFile: state.selectedImageFile,
        selectedVideoFile: state.selectedVideoFile,
        urlContent: state.urlContent
    });
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
// Audio Briefing (TTS)
// ============================================
async function generateAudioBriefing() {
    if (!state.results) return;
    
    const btn = elements.generateAudioBtn;
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    
    // Show loading state
    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');
    btn.disabled = true;
    
    try {
        // Step 1: Generate executive briefing script using GPT
        const customStyle = elements.audioPrompt?.value?.trim();
        const styleInstruction = customStyle 
            ? `\n\nIMPORTANT: Use this style/tone: "${customStyle}"`
            : '';
        
        const scriptPrompt = `You are an expert at creating concise engineering code briefings.
Based on the following design code analysis, create a 2-minute audio script (approximately 300 words) that:
- Opens with a brief greeting and code context
- Summarizes the code overview and scope
- Highlights the most critical requirements and parameters
- Notes any key compliance warnings or exceptions
- Closes with recommended next steps for the design team

Keep the tone professional but conversational, suitable for audio playback.
Do not include any stage directions or speaker notes - just the spoken text.${styleInstruction}

Code Overview:
${state.results.codeOverview}

Top Requirements:
${(state.results.requirements || []).slice(0, 6).map(req => `- ${req.id ? `${req.id}: ` : ''}${req.text || ''}`).join('\n')}

Design Parameters:
${(state.results.designParameters || []).slice(0, 6).map(param => `- ${param.name || 'Parameter'}: ${param.value || ''} ${param.unit || ''}`.trim()).join('\n')}

Compliance Notes:
${(state.results.complianceNotes || []).join('\n')}`;

        const script = await callChatAPI(
            PROMPTS.audioBriefingSystem,
            scriptPrompt,
            'Audio Script'
        );
        
        // Step 2: Convert script to speech using TTS API
        const selectedVoice = elements.voiceSelect.value;
        const audioBlob = await textToSpeech(script, selectedVoice);
        const audioDataUrl = await fileToBase64(audioBlob);
        const audioParts = splitDataUrl(audioDataUrl);
        generatedAudioBase64 = audioParts.base64 || null;
        state.exportMeta.artifacts.audioBriefing = {
            promptStyle: customStyle || '',
            voice: selectedVoice,
            script,
            scriptPrompt,
            audioMimeType: audioParts.mimeType || 'audio/mpeg',
            generatedAt: new Date().toISOString()
        };
        
        // Step 3: Create audio URL and display player
        if (generatedAudioUrl) {
            URL.revokeObjectURL(generatedAudioUrl);
        }
        generatedAudioUrl = URL.createObjectURL(audioBlob);
        
        elements.audioPlayer.src = generatedAudioUrl;
        elements.audioPlayerContainer.classList.remove('hidden');
        
        // Update metrics display
        displayMetrics();
        
    } catch (error) {
        console.error('Audio generation error:', error);
        showError(error.message || 'Failed to generate audio briefing.');
    } finally {
        btnText.classList.remove('hidden');
        btnLoader.classList.add('hidden');
        btn.disabled = false;
    }
}

async function textToSpeech(text, voice = 'nova') {
    const response = await fetchOpenAI('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini-tts',
            input: text,
            voice: voice
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `TTS failed: ${response.status}`);
    }
    
    // Track metrics
    currentMetrics.ttsCharacters += text.length;
    currentMetrics.apiCalls.push({
        name: 'Text-to-Speech',
        model: 'gpt-4o-mini-tts',
        characters: text.length
    });
    
    // Recalculate and update metrics
    state.metrics = calculateMetrics();
    
    return await response.blob();
}

function downloadAudio() {
    if (!generatedAudioUrl) return;
    
    const a = document.createElement('a');
    a.href = generatedAudioUrl;
    a.download = `code-briefing-${new Date().toISOString().slice(0, 10)}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ============================================
// Infographic Generation (DALL-E 3)
// ============================================
async function generateInfographic() {
    if (!state.results) return;

    const userStyle = elements.infographicPrompt.value.trim() || 'professional corporate infographic with icons';

    const btn = elements.generateInfographicBtn;
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');

    // Show loading state
    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');
    btn.disabled = true;

    try {
        // Create a detailed prompt for DALL-E with safe margin instructions
        const dallePrompt = `Create a professional engineering code infographic with the following style: ${userStyle}.

The infographic should visualize these code insights:

CODE OVERVIEW: ${state.results.codeOverview.substring(0, 200)}...

REQUIREMENTS (show as visual elements):
${(state.results.requirements || []).slice(0, 4).map(req => `- ${req.id ? `${req.id}: ` : ''}${req.text || ''}`).join('\n')}

DESIGN PARAMETERS (show as callouts):
${(state.results.designParameters || []).slice(0, 4).map(param => `- ${param.name || 'Parameter'}: ${param.value || ''} ${param.unit || ''}`.trim()).join('\n')}

COMPLIANCE NOTES:
${(state.results.complianceNotes || []).slice(0, 3).map(note => `- ${note}`).join('\n')}

CRITICAL DESIGN REQUIREMENTS:
- Keep ALL content well within the image boundaries with generous padding (at least 50px from all edges)
- Do NOT place any text, icons, or visual elements near the edges that might get cut off
- Center the composition with clear margins on all sides
- Clean, professional layout with good whitespace
- Use icons and visual hierarchy
- Include a centered title "Design Code Insights" at the top
- Use a cohesive color scheme
- Make text readable and fully visible
- Horizontal/landscape layout`;

        const imageUrl = await generateImage(dallePrompt);

        // Display the image
        elements.infographicImage.src = imageUrl;
        elements.infographicContainer.classList.remove('hidden');

        // Store URL for download
        generatedImageUrl = imageUrl;
        state.exportMeta.artifacts.infographic = {
            userStyle,
            prompt: dallePrompt,
            size: '1536x1024',
            generatedAt: new Date().toISOString()
        };

        // Update metrics display
        displayMetrics();

    } catch (error) {
        console.error('Infographic generation error:', error);
        showError(error.message || 'Failed to generate infographic.');
    } finally {
        btnText.classList.remove('hidden');
        btnLoader.classList.add('hidden');
        btn.disabled = false;
    }
}

async function generateImage(prompt) {
    const response = await fetchOpenAI('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-image-1.5',
            prompt: prompt,
            n: 1,
            size: '1536x1024' // Landscape format for infographics
        })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Image generation failed: ${response.status}`);
    }

    const data = await response.json();

    // Track metrics from usage data
    const usage = data.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;

    currentMetrics.imageInputTokens += inputTokens;
    currentMetrics.imageOutputTokens += outputTokens;
    currentMetrics.apiCalls.push({
        name: 'Infographic',
        model: 'gpt-image-1.5',
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        size: '1536x1024'
    });
    
    // Recalculate and update metrics
    state.metrics = calculateMetrics();
    
    // Store base64 data for DOCX embedding
    const base64Data = data.data[0].b64_json;
    generatedImageBase64 = base64Data;
    
    // Return a data URL for display
    return `data:image/png;base64,${base64Data}`;
}

async function downloadInfographic() {
    if (!generatedImageBase64) return;
    
    try {
        // Convert base64 to blob for download
        const binaryString = atob(generatedImageBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `code-infographic-${new Date().toISOString().slice(0, 10)}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Download error:', error);
        showError('Failed to download infographic. Try right-clicking the image and saving.');
    }
}

// ============================================
// URL Content Fetching
// ============================================
async function fetchUrlContent() {
    const url = elements.urlInput.value.trim();
    
    if (!url) {
        showError('Please enter a URL');
        return;
    }
    
    // Basic URL validation
    try {
        new URL(url);
    } catch {
        showError('Please enter a valid URL (e.g., https://example.com)');
        return;
    }
    
    const btn = elements.fetchUrlBtn;
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    
    btn.disabled = true;
    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');
    
    // CORS proxies to try (in order)
    const corsProxies = [
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
        (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
    ];
    
    let html = null;
    let lastError = null;
    
    for (const proxyFn of corsProxies) {
        try {
            const proxyUrl = proxyFn(url);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
            
            const response = await fetch(proxyUrl, {
                signal: controller.signal,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });
            
            clearTimeout(timeoutId);
            
            if (response.ok) {
                html = await response.text();
                break;
            }
        } catch (e) {
            lastError = e;
            // Try next proxy
            continue;
        }
    }
    
    try {
        if (!html) {
            throw new Error(lastError?.name === 'AbortError' 
                ? 'Request timed out. Please check your connection and try again.'
                : 'Could not fetch the URL. The site may block external access or your connection may be unstable.');
        }
        
        // Extract text content from HTML
        const textContent = extractTextFromHtml(html);
        
        if (!textContent || textContent.length < 20) {
            throw new Error('Could not extract meaningful text from the webpage. The page may be empty or require JavaScript to load content.');
        }
        
        // Store the content
        state.urlContent = textContent;
        state.sourceUrl = url;
        state.exportMeta.source.url = url;
        
        // Show preview
        elements.urlPreviewContent.textContent = textContent.substring(0, 2000) + 
            (textContent.length > 2000 ? '\n\n... (content truncated for preview)' : '');
        elements.urlPreview.classList.remove('hidden');
        
        updateAnalyzeButton();
        
    } catch (error) {
        console.error('URL fetch error:', error);
        showError(error.message || 'Failed to fetch content from URL.');
    } finally {
        btn.disabled = false;
        btnText.classList.remove('hidden');
        btnLoader.classList.add('hidden');
    }
}

function extractTextFromHtml(html) {
    // Create a temporary DOM element to parse HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Remove unwanted elements (more comprehensive list for better extraction)
    const unwantedSelectors = 'script, style, noscript, iframe, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navigation, .menu, .sidebar, .advertisement, .ad';
    doc.querySelectorAll(unwantedSelectors).forEach(el => el.remove());
    
    // Get text content from body
    const body = doc.body;
    if (!body) return '';
    
    // Use textContent (more reliable across browsers including mobile)
    let text = body.textContent || '';
    
    // Clean up whitespace more aggressively for consistent results
    text = text
        .replace(/[\t\r]+/g, ' ')       // Replace tabs and carriage returns with spaces
        .replace(/\n{3,}/g, '\n\n')     // Limit consecutive newlines to 2
        .replace(/ {2,}/g, ' ')         // Collapse multiple spaces
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');
    
    return text.trim();
}

function clearUrlContent() {
    state.urlContent = null;
    state.sourceUrl = null;
    state.exportMeta.source.url = null;
    elements.urlInput.value = '';
    elements.urlPreview.classList.add('hidden');
    elements.urlPreviewContent.textContent = '';
    updateAnalyzeButton();
}

// ============================================
// Chat with Data
// ============================================
async function sendChatMessage() {
    const message = elements.chatInput.value.trim();
    if (!message || !state.results) return;
    
    // Disable input while processing
    elements.chatInput.disabled = true;
    elements.chatSendBtn.disabled = true;
    elements.chatInput.value = '';
    
    // Add user message to UI
    appendChatMessage('user', message);
    
    // Add to chat history
    state.chatHistory.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });
    
    // Show thinking indicator with train of thought
    const thinkingId = showThinkingIndicator();
    
    try {
        // Step 1: Understanding the question
        updateThinkingStatus(thinkingId, 'Understanding your question...');
        await sleep(300); // Brief pause for UX
        
        // Step 2: Building context
        updateThinkingStatus(thinkingId, 'Searching code data...');
        const context = buildChatContext();
        await sleep(200);
        
        // Step 3: Calling AI
        updateThinkingStatus(thinkingId, 'Analyzing with AI...');
        const response = await chatWithData(context, state.chatHistory);
        
        // Step 4: Processing response
        updateThinkingStatus(thinkingId, 'Preparing response...');
        await sleep(150);
        
        // Remove thinking indicator
        removeTypingIndicator(thinkingId);
        
        // Add assistant response to UI and history
        appendChatMessage('assistant', response);
        state.chatHistory.push({
            role: 'assistant',
            content: response,
            model: GPT_52_MODEL,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Chat error:', error);
        removeTypingIndicator(thinkingId);
        appendChatMessage('assistant', 'Sorry, I encountered an error processing your request. Please try again.');
    } finally {
        elements.chatInput.disabled = false;
        elements.chatSendBtn.disabled = false;
        elements.chatInput.focus();
    }
}

function buildChatContext() {
    const results = state.results;
    return `You have access to the following design code analysis data. Use this information to answer the user's questions accurately and helpfully.

=== SOURCE TEXT ===
${results.sourceText}

=== ANALYSIS RESULTS ===

CODE OVERVIEW:
${results.codeOverview}

REQUIREMENTS (JSON):
${JSON.stringify(results.requirements || [], null, 2)}

DESIGN PARAMETERS (JSON):
${JSON.stringify(results.designParameters || [], null, 2)}

CROSS REFERENCES (JSON):
${JSON.stringify(results.crossReferences || [], null, 2)}

COMPLIANCE NOTES:
${(results.complianceNotes || []).join('\n')}

=== END OF CODE DATA ===

Instructions:
- Answer questions based on the code data above
- Be concise but thorough
- If something isn't mentioned in the code data, say so
- Include section references when citing requirements
- Format responses clearly with bullet points when listing multiple items`;
}

async function chatWithData(context, history) {
    // Build messages array with system context and conversation history
    const messages = [
        {
            role: 'system',
            content: context
        },
        ...history.slice(-10).map(entry => ({
            role: entry.role,
            content: entry.content
        })) // Keep last 10 messages to avoid token limits
    ];
    
    const response = await fetchOpenAI('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: GPT_52_MODEL,
            messages: messages,
            max_completion_tokens: 1000,
            temperature: 0.7
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Chat failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Track metrics (uses same GPT-5.2 as analysis)
    const usage = data.usage || {};
    currentMetrics.gptInputTokens += usage.prompt_tokens || 0;
    currentMetrics.gptOutputTokens += usage.completion_tokens || 0;
    currentMetrics.apiCalls.push({
        name: 'Chat Query',
        model: GPT_52_MODEL,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0
    });
    
    // Update metrics display
    state.metrics = calculateMetrics();
    displayMetrics();
    
    return data.choices[0].message.content;
}

function appendChatMessage(role, content) {
    // Remove welcome message if it exists
    const welcome = elements.chatMessages.querySelector('.chat-welcome');
    if (welcome) {
        welcome.remove();
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'chat-message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    
    // Convert markdown-style formatting to HTML
    const formattedContent = formatChatContent(content);
    contentDiv.innerHTML = formattedContent;
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    elements.chatMessages.appendChild(messageDiv);
    
    // Scroll to bottom
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function formatChatContent(content) {
    // Use marked.js for proper markdown rendering if available
    if (typeof marked !== 'undefined') {
        return marked.parse(content);
    }
    
    // Fallback: basic formatting if marked.js not loaded
    let formatted = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^\s*[-•]\s+/gm, '▸ ')
        .replace(/\n/g, '<br>');
    
    return `<p>${formatted}</p>`;
}

function showThinkingIndicator() {
    const id = 'thinking-' + Date.now();
    const thinkingDiv = document.createElement('div');
    thinkingDiv.id = id;
    thinkingDiv.className = 'chat-message assistant';
    thinkingDiv.innerHTML = `
        <div class="chat-message-avatar">🤖</div>
        <div class="chat-thinking">
            <div class="thinking-spinner"></div>
            <span class="thinking-text">Thinking...</span>
        </div>
    `;
    elements.chatMessages.appendChild(thinkingDiv);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    return id;
}

function updateThinkingStatus(id, status) {
    const thinkingDiv = document.getElementById(id);
    if (thinkingDiv) {
        const textSpan = thinkingDiv.querySelector('.thinking-text');
        if (textSpan) {
            textSpan.textContent = status;
        }
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }
}

// Keep legacy function for compatibility
function showTypingIndicator() {
    return showThinkingIndicator();
}

function removeTypingIndicator(id) {
    const typingDiv = document.getElementById(id);
    if (typingDiv) {
        typingDiv.remove();
    }
}

function resetChatHistory() {
    state.chatHistory = [];
    if (elements.chatMessages) {
        elements.chatMessages.innerHTML = `
            <div class="chat-welcome">
                <div class="chat-welcome-icon">🤖</div>
                <div class="chat-welcome-text">
                    <strong>Design Code Assistant</strong>
                    <p>I have access to the code text and extracted requirements. Ask about specific clauses, parameters, cross-references, or compliance notes.</p>
                </div>
            </div>
        `;
    }
}

function restoreChatHistoryUI() {
    if (!elements.chatMessages || state.chatHistory.length === 0) return;
    elements.chatMessages.innerHTML = '';
    state.chatHistory.forEach(message => {
        appendChatMessage(message.role, message.content);
    });
}

// ============================================
// Agent Export/Import
// ============================================

function generateSuggestedAgentName() {
    if (!state.results) return 'Code Agent';
    
    const overview = state.results.codeOverview || '';
    let title = overview.split('.')[0].trim();
    
    // Capitalize first letter
    if (title.length > 0) {
        title = title.charAt(0).toUpperCase() + title.slice(1);
    }
    
    // Limit length and clean up
    if (title.length > 60) {
        title = title.substring(0, 57) + '...';
    }
    
    // Fallback if title is too short or empty
    if (title.length < 5) {
        const codeType = deriveCodeType(state.results);
        const now = new Date();
        title = codeType === 'Unknown'
            ? `Code ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            : `${codeType} ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    
    return title;
}

function showAgentNameModal() {
    if (!state.results) {
        showError('No analysis results to export. Please analyze content first.');
        return;
    }
    
    // Generate and pre-populate suggested name
    const suggestedName = generateSuggestedAgentName();
    elements.agentNameInput.value = suggestedName;
    
    // Show modal
    elements.agentNameModal.classList.remove('hidden');
    
    // Focus and select the input
    setTimeout(() => {
        elements.agentNameInput.focus();
        elements.agentNameInput.select();
    }, 100);
}

function hideAgentNameModal() {
    elements.agentNameModal.classList.add('hidden');
    elements.agentNameInput.value = '';
}

function showHelpModal() {
    elements.helpModal.classList.remove('hidden');
}

function hideHelpModal() {
    elements.helpModal.classList.add('hidden');
}

function toggleAboutDropdown() {
    elements.aboutDropdown.classList.toggle('hidden');
}

// ============================================
// Wearable Modal (Coming Soon)
// ============================================
function showWearableModal() {
    const modal = document.getElementById('wearable-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function hideWearableModal() {
    const modal = document.getElementById('wearable-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// Initialize wearable modal event listeners
function initWearableModal() {
    const modal = document.getElementById('wearable-modal');
    const closeBtn = document.getElementById('wearable-modal-close');
    const gotItBtn = document.getElementById('wearable-modal-close-btn');
    
    if (closeBtn) {
        closeBtn.addEventListener('click', hideWearableModal);
    }
    if (gotItBtn) {
        gotItBtn.addEventListener('click', hideWearableModal);
    }
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hideWearableModal();
        });
    }
}

function confirmExportAgent() {
    const agentName = elements.agentNameInput.value.trim();
    
    if (!agentName) {
        elements.agentNameInput.focus();
        elements.agentNameInput.style.borderColor = 'var(--error)';
        setTimeout(() => {
            elements.agentNameInput.style.borderColor = '';
        }, 2000);
        return;
    }
    
    // Hide modal
    hideAgentNameModal();
    
    // Proceed with export
    exportAgentWithName(agentName);
}

function createExportMeta() {
    return {
        agentId: null,
        source: {
            audio: null,
            pdf: null,
            image: null,
            video: null,
            url: null
        },
        processing: {
            inputMode: null,
            analysis: null,
            transcriptionMethod: null,
            pdf: {
                totalPages: null,
                usedVisionOcr: false,
                ocrPagesAnalyzed: 0,
                ocrPageLimit: 0
            }
        },
        artifacts: {
            audioBriefing: null,
            infographic: null
        }
    };
}

function resetExportMeta() {
    state.exportMeta = createExportMeta();
}

function getFileMeta(file) {
    if (!file) return null;
    return {
        name: file.name,
        sizeBytes: file.size,
        type: file.type || '',
        lastModified: file.lastModified || null,
        lastModifiedIso: file.lastModified ? new Date(file.lastModified).toISOString() : null
    };
}

function splitDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return { mimeType: '', base64: '' };
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return { mimeType: '', base64: '' };
    return { mimeType: match[1], base64: match[2] };
}

function getAgentId() {
    if (!state.exportMeta.agentId) {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            state.exportMeta.agentId = crypto.randomUUID();
        } else {
            state.exportMeta.agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }
    }
    return state.exportMeta.agentId;
}

function getWordCount(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(word => word.length > 0).length;
}

function escapeYamlValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/"/g, '\\"');
}

function buildExportPayload(agentName, now, readableDate) {
    const results = state.results || {};
    const sourceText = results.sourceText || '';
    const requirementsCount = (results.requirements || []).length;
    const parametersCount = (results.designParameters || []).length;
    const crossRefsCount = (results.crossReferences || []).length;
    const complianceNotesCount = (results.complianceNotes || []).length;

    const imageInput = splitDataUrl(state.selectedImageBase64);

    const audioBriefingMeta = state.exportMeta.artifacts.audioBriefing
        ? { ...state.exportMeta.artifacts.audioBriefing }
        : null;

    const infographicMeta = state.exportMeta.artifacts.infographic
        ? { ...state.exportMeta.artifacts.infographic }
        : null;

    const attachments = {
        sourceImage: imageInput.base64
            ? { mimeType: imageInput.mimeType, base64: imageInput.base64 }
            : null,
        audioBriefing: generatedAudioBase64
            ? { mimeType: audioBriefingMeta?.audioMimeType || 'audio/mpeg', base64: generatedAudioBase64 }
            : null,
        infographic: generatedImageBase64
            ? { mimeType: 'image/png', base64: generatedImageBase64 }
            : null
    };

    return {
        schema: 'northstar-agent-md',
        schemaVersion: 2,
        exportedAt: now.toISOString(),
        agent: {
            id: getAgentId(),
            name: agentName,
            created: now.toISOString(),
            readableDate,
            sourceType: state.inputMode,
            sourceLabel: getSourceTypeLabel(state.inputMode),
            app: 'northstar.LM'
        },
        source: {
            inputMode: state.inputMode,
            sourceLabel: getSourceTypeLabel(state.inputMode),
            url: state.sourceUrl || state.exportMeta.source.url || null,
            audioFile: state.exportMeta.source.audio,
            pdfFile: state.exportMeta.source.pdf,
            imageFile: state.exportMeta.source.image,
            videoFile: state.exportMeta.source.video
        },
        processing: {
            inputMode: state.exportMeta.processing.inputMode || state.inputMode,
            analysis: state.exportMeta.processing.analysis,
            transcriptionMethod: state.exportMeta.processing.transcriptionMethod || null,
            pdf: state.exportMeta.processing.pdf
        },
        analysis: {
            codeOverview: results.codeOverview || '',
            requirements: results.requirements || [],
            designParameters: results.designParameters || [],
            crossReferences: results.crossReferences || [],
            complianceNotes: results.complianceNotes || [],
            sourceText,
            model: GPT_52_MODEL
        },
        kpis: {
            requirementsCount,
            parametersCount,
            crossRefsCount,
            complianceNotesCount
        },
        metrics: state.metrics || null,
        currentMetrics: currentMetrics || null,
        apiCalls: currentMetrics?.apiCalls || [],
        chatHistory: state.chatHistory || [],
        prompts: {
            analysisBatchSystem: PROMPTS.analysisBatchSystem,
            summarySystem: PROMPTS.summarySystem,
            visionOcrSystem: PROMPTS.visionOcrSystem,
            audioBriefingSystem: PROMPTS.audioBriefingSystem,
            audioBriefingScriptPrompt: audioBriefingMeta?.scriptPrompt || null,
            infographicPrompt: infographicMeta?.prompt || null,
            chatContext: buildChatContext()
        },
        artifacts: {
            audioBriefing: audioBriefingMeta,
            infographic: infographicMeta,
            sourceImage: imageInput.base64 ? { mimeType: imageInput.mimeType } : null
        },
        attachments
    };
}

function exportAgentWithName(agentName) {
    if (!state.results) {
        showError('No analysis results to export. Please analyze content first.');
        return;
    }
    
    const now = new Date();
    const dateStr = now.toISOString();
    const readableDate = now.toLocaleDateString('en-US', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });
    const codeStandard = deriveCodeType(state.results);
    const exportPayload = buildExportPayload(agentName, now, readableDate);
    const agentId = exportPayload.agent.id;
    const exportJson = JSON.stringify(exportPayload, null, 2);
    
    // Build the markdown content with YAML frontmatter
    const markdown = `---
agent_type: northstar-code-agent
version: 2.0
created: ${dateStr}
source_type: ${state.inputMode}
agent_name: "${escapeYamlValue(agentName)}"
code_standard: "${escapeYamlValue(codeStandard)}"
agent_id: "${agentId}"
export_format: northstar-agent-md
---

# Code Agent: ${agentName}

## Metadata
- **Created**: ${readableDate}
- **Source**: ${getSourceTypeLabel(state.inputMode)}
- **Agent ID**: ${agentId}
- **Export Format**: northstar-agent-md v2
- **Exported At**: ${now.toLocaleString('en-US')}
- **Powered by**: northstar.LM
- **API Key Included**: No

---

## Source Details (JSON)

\`\`\`json
${JSON.stringify(exportPayload.source, null, 2)}
\`\`\`

---

## Processing Details (JSON)

\`\`\`json
${JSON.stringify(exportPayload.processing, null, 2)}
\`\`\`

---

## KPI Dashboard (JSON)

\`\`\`json
${JSON.stringify(exportPayload.kpis, null, 2)}
\`\`\`

---

## Metrics (JSON)

\`\`\`json
${JSON.stringify(exportPayload.metrics, null, 2)}
\`\`\`

---

## Code Overview

${state.results.codeOverview || ''}

---

## Requirements

${formatRequirementsMarkdown(state.results.requirements)}

---

## Design Parameters

${formatDesignParametersMarkdown(state.results.designParameters)}

---

## Cross References

${formatCrossReferencesMarkdown(state.results.crossReferences)}

---

## Compliance Notes

${formatAsMarkdownList(state.results.complianceNotes || [])}

---

## Source Text

\`\`\`
${state.results.sourceText || ''}
\`\`\`

---

## Chat History (JSON)

\`\`\`json
${JSON.stringify(exportPayload.chatHistory, null, 2)}
\`\`\`

---

## Artifacts (JSON)

\`\`\`json
${JSON.stringify(exportPayload.artifacts, null, 2)}
\`\`\`

---

## API Calls (JSON)

\`\`\`json
${JSON.stringify(exportPayload.apiCalls, null, 2)}
\`\`\`

---

## Prompts (JSON)

\`\`\`json
${JSON.stringify(exportPayload.prompts, null, 2)}
\`\`\`

---

## Current Metrics (JSON)

\`\`\`json
${JSON.stringify(exportPayload.currentMetrics, null, 2)}
\`\`\`

---

## Export Payload (JSON)

\`\`\`json
${exportJson}
\`\`\`
`;

    // Create filename from agent name (sanitized)
    const safeFileName = agentName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);
    
    // Create and download the file
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName}-${now.toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function getSourceTypeLabel(inputMode) {
    const labels = {
        'audio': 'Audio Transcription',
        'pdf': 'PDF Document',
        'image': 'Image (Vision OCR)',
        'video': 'Video Transcription',
        'text': 'Text Input',
        'url': 'Web Page',
        'agent': 'Imported Agent'
    };
    return labels[inputMode] || 'Unknown';
}

function formatAsMarkdownList(input) {
    if (Array.isArray(input)) {
        return input
            .map(item => String(item || '').trim())
            .filter(line => line.length > 0)
            .map(line => `- ${line}`)
            .join('\n');
    }
    const text = input || '';
    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
            const cleanLine = line.replace(/^[-•*▸]\s*/, '');
            return `- ${cleanLine}`;
        })
        .join('\n');
}

function formatAsCheckboxList(text) {
    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
            // Remove existing bullets/dashes and add markdown checkbox
            const cleanLine = line.replace(/^[-•*▸☐]\s*/, '');
            return `- [ ] ${cleanLine}`;
        })
        .join('\n');
}

function formatRequirementsMarkdown(requirements) {
    if (!Array.isArray(requirements) || requirements.length === 0) {
        return '- No requirements extracted.';
    }
    return requirements
        .map(req => {
            const id = req.id ? `${req.id}: ` : '';
            const text = req.text || '';
            return `- ${id}${text}`.trim();
        })
        .join('\n');
}

function formatDesignParametersMarkdown(parameters) {
    if (!Array.isArray(parameters) || parameters.length === 0) {
        return '- No design parameters extracted.';
    }
    return parameters
        .map(param => {
            const value = [param.value, param.unit].filter(Boolean).join(' ').trim();
            const name = param.name || 'Parameter';
            const section = param.section ? ` (Section: ${param.section})` : '';
            return `- ${name}${value ? `: ${value}` : ''}${section}`.trim();
        })
        .join('\n');
}

function formatCrossReferencesMarkdown(crossReferences) {
    if (!Array.isArray(crossReferences) || crossReferences.length === 0) {
        return '- No cross-references extracted.';
    }
    return crossReferences
        .map(ref => {
            const source = ref.source || 'Source';
            const target = ref.target || 'Target';
            const relationship = ref.relationship ? ` (${ref.relationship})` : '';
            return `- ${source} -> ${target}${relationship}`.trim();
        })
        .join('\n');
}

async function handleAgentFileSelect(e) {
    if (e.target.files.length === 0) return;
    
    const file = e.target.files[0];
    
    // Validate file type
    if (!file.name.endsWith('.md')) {
        showError('Please select a valid .md agent file.');
        e.target.value = '';
        return;
    }
    
    try {
        const content = await file.text();
        const agentData = parseAgentFile(content);
        
        if (!agentData) {
            throw new Error('Could not parse agent file. Please ensure it is a valid northstar.LM agent.');
        }
        
        // Restore the session from the agent data
        importAgentSession(agentData);
        
    } catch (error) {
        console.error('Agent import error:', error);
        showError(error.message || 'Failed to import agent file.');
    } finally {
        e.target.value = ''; // Reset file input
    }
}

function parseAgentFile(content) {
    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    
    if (!frontmatterMatch) {
        // Try to parse as a legacy or simple format
        return parseLegacyAgentFile(content);
    }
    
    // Parse frontmatter
    const frontmatter = {};
    frontmatterMatch[1].split('\n').forEach(line => {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length) {
            frontmatter[key.trim()] = valueParts.join(':').trim();
        }
    });
    
    // Validate it's a northstar agent
    const isCodeAgent = frontmatter.agent_type === 'northstar-code-agent';
    const isMeetingAgent = frontmatter.agent_type === 'northstar-meeting-agent';
    if (!isCodeAgent && !isMeetingAgent) {
        return null;
    }
    
    // Extract sections from markdown
    const bodyContent = content.substring(frontmatterMatch[0].length);
    
    const payload = extractJsonSection(bodyContent, 'Export Payload (JSON)');
    const payloadAnalysis = payload?.analysis || null;

    if (isCodeAgent) {
        const codeOverview = payloadAnalysis?.codeOverview || extractSection(bodyContent, 'Code Overview') || '';
        const requirements = payloadAnalysis?.requirements || parseRequirementsFromMarkdown(extractSection(bodyContent, 'Requirements'));
        const designParameters = payloadAnalysis?.designParameters || parseDesignParametersFromMarkdown(extractSection(bodyContent, 'Design Parameters'));
        const crossReferences = payloadAnalysis?.crossReferences || parseCrossReferencesFromMarkdown(extractSection(bodyContent, 'Cross References'));
        const complianceNotes = payloadAnalysis?.complianceNotes || parseMarkdownList(extractSection(bodyContent, 'Compliance Notes'));
        const sourceText = payloadAnalysis?.sourceText || extractSourceText(bodyContent) || '';

        if (!codeOverview && !sourceText && !payloadAnalysis?.codeOverview && !payloadAnalysis?.sourceText) {
            return null;
        }

        return {
            frontmatter,
            codeOverview,
            requirements,
            designParameters,
            crossReferences,
            complianceNotes,
            sourceText,
            payload
        };
    }

    const summary = extractSection(bodyContent, 'Executive Summary');
    const keyPoints = extractSection(bodyContent, 'Key Points');
    const actionItems = extractSection(bodyContent, 'Action Items');
    const sentiment = extractSentimentFromSection(bodyContent);
    const transcription = extractTranscript(bodyContent);

    if (!summary && !transcription && !payloadAnalysis?.summary && !payloadAnalysis?.transcript) {
        return null;
    }

    return {
        frontmatter,
        summary: summary || payloadAnalysis?.summary || '',
        keyPoints: keyPoints || payloadAnalysis?.keyPoints || '',
        actionItems: actionItems || payloadAnalysis?.actionItems || '',
        sentiment: sentiment || payloadAnalysis?.sentiment || 'Neutral',
        transcription: transcription || payloadAnalysis?.transcript || '',
        payload
    };
}

function parseLegacyAgentFile(content) {
    // Attempt to parse content that might not have proper frontmatter
    // Look for key sections
    const codeOverview = extractSection(content, 'Code Overview');
    const requirements = parseRequirementsFromMarkdown(extractSection(content, 'Requirements'));
    const designParameters = parseDesignParametersFromMarkdown(extractSection(content, 'Design Parameters'));
    const crossReferences = parseCrossReferencesFromMarkdown(extractSection(content, 'Cross References'));
    const complianceNotes = parseMarkdownList(extractSection(content, 'Compliance Notes'));
    const sourceText = extractSourceText(content);

    const summary = extractSection(content, 'Executive Summary') ||
                    extractSection(content, 'Summary');
    const keyPoints = extractSection(content, 'Key Points');
    const actionItems = extractSection(content, 'Action Items');
    const sentiment = extractSentimentFromSection(content);
    const transcription = extractTranscript(content) ||
                          extractSection(content, 'Transcript');
    const payload = extractJsonSection(content, 'Export Payload (JSON)');
    const payloadAnalysis = payload?.analysis || null;

    if (codeOverview || sourceText || payloadAnalysis?.codeOverview || payloadAnalysis?.sourceText) {
        return {
            frontmatter: { source_type: 'agent', agent_type: 'northstar-code-agent' },
            codeOverview: codeOverview || payloadAnalysis?.codeOverview || '',
            requirements: payloadAnalysis?.requirements || requirements,
            designParameters: payloadAnalysis?.designParameters || designParameters,
            crossReferences: payloadAnalysis?.crossReferences || crossReferences,
            complianceNotes: payloadAnalysis?.complianceNotes || complianceNotes,
            sourceText: sourceText || payloadAnalysis?.sourceText || '',
            payload
        };
    }

    if (!summary && !transcription && !payloadAnalysis?.summary && !payloadAnalysis?.transcript) {
        return null;
    }

    return {
        frontmatter: { source_type: 'agent' },
        summary: summary || payloadAnalysis?.summary || '',
        keyPoints: keyPoints || payloadAnalysis?.keyPoints || '',
        actionItems: actionItems || payloadAnalysis?.actionItems || '',
        sentiment: sentiment || payloadAnalysis?.sentiment || 'Neutral',
        transcription: transcription || payloadAnalysis?.transcript || '',
        payload
    };
}

function extractSection(content, sectionName) {
    // Match section header (## Section Name) and capture until next ## or ---
    const regex = new RegExp(`## ${sectionName}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n---\\n|\\n## |$)`, 'i');
    const match = content.match(regex);
    
    if (match && match[1]) {
        return match[1].trim();
    }
    return null;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractJsonSection(content, sectionName) {
    const safeName = escapeRegex(sectionName);
    const regex = new RegExp(`## ${safeName}[\\s\\S]*?\\n\`\`\`json\\s*\\n([\\s\\S]*?)\\n\`\`\``, 'i');
    const match = content.match(regex);
    if (!match || !match[1]) return null;
    try {
        return JSON.parse(match[1].trim());
    } catch (error) {
        console.warn('Failed to parse JSON section:', sectionName, error);
        return null;
    }
}

function extractSentimentFromSection(content) {
    const section = extractSection(content, 'Sentiment Analysis');
    if (section) {
        // Look for "Overall Sentiment: X" pattern
        const match = section.match(/\*\*Overall Sentiment\*\*:\s*(.+)/i) ||
                      section.match(/Overall Sentiment:\s*(.+)/i);
        if (match) {
            return match[1].trim();
        }
        // Just return the section content if no pattern found
        return section.split('\n')[0].trim();
    }
    return null;
}

function extractTranscript(content) {
    const codeBlockMatch = content.match(/## (Full Transcript|Source Text)[\s\S]*?```[\s\S]*?\n([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[2]) {
        return codeBlockMatch[2].trim();
    }

    const section = extractSection(content, 'Full Transcript') || extractSection(content, 'Source Text');
    return section;
}

function extractSourceText(content) {
    return extractSection(content, 'Source Text') || extractTranscript(content);
}

function parseMarkdownList(sectionText) {
    if (!sectionText) return [];
    return sectionText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.replace(/^[-•*▸]\s*/, '').trim())
        .filter(line => line.length > 0);
}

function parseRequirementsFromMarkdown(sectionText) {
    return parseMarkdownList(sectionText).map(line => {
        const parts = line.split(':');
        if (parts.length > 1) {
            return { id: parts.shift().trim(), text: parts.join(':').trim() };
        }
        return { id: '', text: line };
    });
}

function parseDesignParametersFromMarkdown(sectionText) {
    return parseMarkdownList(sectionText).map(line => {
        const match = line.match(/^(.+?):\s*(.+)$/);
        const name = match ? match[1].trim() : line;
        let value = match ? match[2].trim() : '';
        let section = '';
        const sectionMatch = value.match(/\(Section:\s*([^)]+)\)$/i);
        if (sectionMatch) {
            section = sectionMatch[1].trim();
            value = value.replace(/\(Section:\s*([^)]+)\)$/i, '').trim();
        }
        return { name, value, section };
    });
}

function parseCrossReferencesFromMarkdown(sectionText) {
    return parseMarkdownList(sectionText).map(line => {
        const match = line.match(/(.+?)\s*->\s*(.+?)(?:\s*\((.+)\))?$/);
        if (match) {
            return {
                source: match[1].trim(),
                target: match[2].trim(),
                relationship: match[3]?.trim() || ''
            };
        }
        return { source: line, target: '', relationship: '' };
    });
}

function importAgentSession(agentData) {
    // Reset any existing state
    resetChatHistory();
    
    // Clean up any generated audio/image URLs
    if (generatedAudioUrl) {
        URL.revokeObjectURL(generatedAudioUrl);
        generatedAudioUrl = null;
    }
    generatedAudioBase64 = null;
    generatedImageUrl = null;
    generatedImageBase64 = null;
    
    const hasCodeSchema = Boolean(agentData.codeOverview || agentData.sourceText || agentData.requirements);
    if (hasCodeSchema) {
        state.results = {
            sourceText: agentData.sourceText || '',
            codeOverview: agentData.codeOverview || '',
            requirements: agentData.requirements || [],
            designParameters: agentData.designParameters || [],
            crossReferences: agentData.crossReferences || [],
            complianceNotes: agentData.complianceNotes || []
        };
    } else {
        const keyPointsList = parseMarkdownList(agentData.keyPoints || '');
        const actionItemsList = parseMarkdownList(agentData.actionItems || '');
        state.results = {
            sourceText: agentData.transcription || '',
            codeOverview: agentData.summary || '',
            requirements: keyPointsList.map(text => ({ id: '', text })),
            designParameters: actionItemsList.map(text => ({ name: text, value: '', unit: '', section: '', applicability: '' })),
            crossReferences: [],
            complianceNotes: agentData.sentiment ? [agentData.sentiment] : []
        };
    }
    
    // Set input mode to indicate this is from an agent
    state.inputMode = agentData.frontmatter?.source_type || 'agent';
    const payload = agentData.payload || null;
    resetExportMeta();
    if (payload) {
        state.exportMeta.agentId = payload.agent?.id || null;
        state.exportMeta.source = {
            audio: payload.source?.audioFile || null,
            pdf: payload.source?.pdfFile || null,
            image: payload.source?.imageFile || null,
            video: payload.source?.videoFile || null,
            url: payload.source?.url || null
        };
        state.exportMeta.processing = payload.processing || state.exportMeta.processing;
        state.exportMeta.artifacts = {
            audioBriefing: payload.artifacts?.audioBriefing || null,
            infographic: payload.artifacts?.infographic || null
        };
        state.sourceUrl = payload.source?.url || null;
    } else {
        state.sourceUrl = null;
    }
    
    if (payload?.currentMetrics) {
        currentMetrics = {
            whisperMinutes: payload.currentMetrics.whisperMinutes || 0,
            gptInputTokens: payload.currentMetrics.gptInputTokens || 0,
            gptOutputTokens: payload.currentMetrics.gptOutputTokens || 0,
            chatInputTokens: payload.currentMetrics.chatInputTokens || 0,
            chatOutputTokens: payload.currentMetrics.chatOutputTokens || 0,
            ttsCharacters: payload.currentMetrics.ttsCharacters || 0,
            imageInputTokens: payload.currentMetrics.imageInputTokens || 0,
            imageOutputTokens: payload.currentMetrics.imageOutputTokens || 0,
            apiCalls: payload.apiCalls || payload.currentMetrics.apiCalls || []
        };
        state.metrics = calculateMetrics();
    } else if (payload?.metrics) {
        currentMetrics = {
            whisperMinutes: payload.metrics.whisperMinutes || 0,
            gptInputTokens: payload.metrics.gptInputTokens || 0,
            gptOutputTokens: payload.metrics.gptOutputTokens || 0,
            chatInputTokens: payload.metrics.chatInputTokens || 0,
            chatOutputTokens: payload.metrics.chatOutputTokens || 0,
            ttsCharacters: payload.metrics.ttsCharacters || 0,
            imageInputTokens: payload.metrics.imageInputTokens || 0,
            imageOutputTokens: payload.metrics.imageOutputTokens || 0,
            apiCalls: payload.apiCalls || []
        };
        state.metrics = { ...payload.metrics, apiCalls: payload.apiCalls || payload.metrics.apiCalls || [] };
    } else {
        // Reset metrics (no API calls were made for import)
        currentMetrics = {
            whisperMinutes: 0,
            gptInputTokens: 0,
            gptOutputTokens: 0,
            chatInputTokens: 0,
            chatOutputTokens: 0,
            ttsCharacters: 0,
            imageInputTokens: 0,
            imageOutputTokens: 0,
            apiCalls: []
        };
        // Provide all expected metric fields for displayMetrics
        state.metrics = {
            whisperMinutes: 0,
            gptInputTokens: 0,
            gptOutputTokens: 0,
            totalTokens: 0,
            ttsCharacters: 0,
            imageInputTokens: 0,
            imageOutputTokens: 0,
            imageTotalTokens: 0,
            whisperCost: 0,
            gptInputCost: 0,
            gptOutputCost: 0,
            ttsCost: 0,
            imageInputCost: 0,
            imageOutputCost: 0,
            imageCost: 0,
            totalCost: 0,
            apiCalls: [],
            isImported: true  // Flag to indicate this is an imported agent
        };
    }

    if (payload?.chatHistory && Array.isArray(payload.chatHistory)) {
        state.chatHistory = payload.chatHistory;
        restoreChatHistoryUI();
    }

    const audioAttachment = payload?.attachments?.audioBriefing;
    if (audioAttachment?.base64) {
        generatedAudioBase64 = audioAttachment.base64;
        const audioBlob = base64ToBlob(audioAttachment.base64, audioAttachment.mimeType || 'audio/mpeg');
        if (audioBlob) {
            generatedAudioUrl = URL.createObjectURL(audioBlob);
            elements.audioPlayer.src = generatedAudioUrl;
            elements.audioPlayerContainer.classList.remove('hidden');
        }
    }

    const infographicAttachment = payload?.attachments?.infographic;
    if (infographicAttachment?.base64) {
        generatedImageBase64 = infographicAttachment.base64;
        const imageMime = infographicAttachment.mimeType || 'image/png';
        elements.infographicImage.src = `data:${imageMime};base64,${infographicAttachment.base64}`;
        elements.infographicContainer.classList.remove('hidden');
    }

    const sourceImageAttachment = payload?.attachments?.sourceImage;
    if (sourceImageAttachment?.base64) {
        const sourceImageUrl = `data:${sourceImageAttachment.mimeType || 'image/png'};base64,${sourceImageAttachment.base64}`;
        state.selectedImageBase64 = sourceImageUrl;
        elements.imagePreviewImg.src = sourceImageUrl;
        elements.imagePreview.classList.remove('hidden');
    }
    
    // Hide progress if visible
    hideProgress();
    
    // Display the results
    displayResults();
    
    // Show a success message
    showTemporaryMessage(elements.importAgentBtn, 'Loaded!', '📥 Import Agent');
    
    // Scroll to results
    elements.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
