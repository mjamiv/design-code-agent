/**
 * KBCanvas - Knowledge Base 3D Canvas Module
 *
 * Provides an immersive 3D canvas with mind-map style node connections,
 * drag-and-drop positioning, and animated SVG connections.
 */

class KBCanvas {
    constructor(containerId) {
        this.space = document.getElementById('kb-3d-space');
        this.svg = document.getElementById('kb-connections-svg');
        this.emptyState = document.getElementById('chain-empty-state');
        this.nodes = new Map(); // agentId -> { element, position }
        this.isDragging = false;
        this.dragTarget = null;
        this.dragOffset = { x: 0, y: 0 };
        this.onPositionChange = null;
        this.onToggle = null;
        this.onRemove = null;
        this.onRename = null;
        this.layoutTimer = null;

        if (this.space && this.svg) {
            this.init();
        }
    }

    init() {
        // Mouse event handlers for drag
        this.space.addEventListener('mousedown', this.onMouseDown.bind(this));
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));

        // Touch support
        this.space.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        document.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        document.addEventListener('touchend', this.onTouchEnd.bind(this));

        // Control buttons
        document.getElementById('kb-auto-layout')?.addEventListener('click', () => this.autoLayout());

        // Resize observer to update connections
        this.resizeObserver = new ResizeObserver(() => this.updateConnections());
        this.resizeObserver.observe(this.space);
    }

    /**
     * Add a new node to the canvas
     */
    addNode(agent, position = null) {
        if (this.nodes.has(agent.id)) {
            this.updateNode(agent);
            return;
        }

        // Calculate initial position if not provided
        const pos = position || agent.position || this.calculateInitialPosition(agent.index || this.nodes.size);

        // Create node element
        const nodeEl = document.createElement('div');
        nodeEl.className = `agent-node-3d ${agent.enabled ? '' : 'disabled'}`;
        nodeEl.dataset.id = agent.id;
        nodeEl.dataset.index = agent.index;
        nodeEl.style.left = `${pos.x}px`;
        nodeEl.style.top = `${pos.y}px`;

        nodeEl.innerHTML = `
            <div class="node-port node-port-in"></div>
            <div class="node-card">
                <span class="node-icon">${agent.enabled ? '📋' : '📄'}</span>
                <input type="text"
                       class="node-name"
                       value="${this.escapeHtml(agent.displayName)}"
                       title="Click to edit name" />
                <div class="node-controls">
                    <button class="node-control-btn toggle-btn ${agent.enabled ? 'active' : ''}"
                            title="${agent.enabled ? 'Disable' : 'Enable'}">
                        ${agent.enabled ? '●' : '○'}
                    </button>
                    <button class="node-control-btn remove-btn" title="Remove">✕</button>
                </div>
            </div>
            <div class="node-port node-port-out"></div>
        `;

        // Add event listeners
        this.setupNodeEvents(nodeEl, agent);

        // Add to DOM and map
        this.space.appendChild(nodeEl);
        this.nodes.set(agent.id, { element: nodeEl, position: pos });

        // Update empty state
        if (this.emptyState) {
            this.emptyState.style.display = 'none';
        }

        // Schedule auto-layout (debounced to handle batch adds)
        this.scheduleAutoLayout();
    }

    /**
     * Schedule auto-layout with debounce for batch operations
     */
    scheduleAutoLayout() {
        // Clear any pending layout
        if (this.layoutTimer) {
            clearTimeout(this.layoutTimer);
        }

        // Debounce: wait for batch adds to complete
        this.layoutTimer = setTimeout(() => {
            this.layoutTimer = null;
            this.autoLayout();
        }, 150); // Wait 150ms for batch operations to complete
    }

    setupNodeEvents(nodeEl, agent) {
        const card = nodeEl.querySelector('.node-card');
        const toggleBtn = nodeEl.querySelector('.toggle-btn');
        const removeBtn = nodeEl.querySelector('.remove-btn');
        const nameInput = nodeEl.querySelector('.node-name');

        // Toggle button
        toggleBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onToggle) {
                this.onToggle(agent.id, parseInt(nodeEl.dataset.index));
            }
        });

        // Remove button
        removeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onRemove) {
                this.onRemove(agent.id, parseInt(nodeEl.dataset.index));
            }
        });

        // Name input
        nameInput?.addEventListener('change', (e) => {
            if (this.onRename) {
                this.onRename(agent.id, parseInt(nodeEl.dataset.index), e.target.value);
            }
        });
        nameInput?.addEventListener('blur', (e) => {
            if (this.onRename) {
                this.onRename(agent.id, parseInt(nodeEl.dataset.index), e.target.value);
            }
        });
        nameInput?.addEventListener('mousedown', (e) => e.stopPropagation());
        nameInput?.addEventListener('touchstart', (e) => e.stopPropagation());
    }

    /**
     * Update an existing node's state
     */
    updateNode(agent) {
        const nodeData = this.nodes.get(agent.id);
        if (!nodeData) return;

        const nodeEl = nodeData.element;
        nodeEl.className = `agent-node-3d ${agent.enabled ? '' : 'disabled'}`;
        nodeEl.dataset.index = agent.index;

        const statusRing = nodeEl.querySelector('.node-status-ring');
        const toggleBtn = nodeEl.querySelector('.toggle-btn');
        const nameInput = nodeEl.querySelector('.node-name');

        if (statusRing) {
            statusRing.classList.toggle('active', agent.enabled);
        }

        if (toggleBtn) {
            toggleBtn.classList.toggle('active', agent.enabled);
            toggleBtn.innerHTML = agent.enabled ? '●' : '○';
            toggleBtn.title = agent.enabled ? 'Disable agent' : 'Enable agent';
        }

        if (nameInput && nameInput.value !== agent.displayName) {
            nameInput.value = agent.displayName;
        }

        this.updateConnections();
    }

    /**
     * Remove a node from the canvas
     */
    removeNode(agentId) {
        const nodeData = this.nodes.get(agentId);
        if (!nodeData) return;

        // Animate out
        nodeData.element.style.transition = 'all 0.3s ease-out';
        nodeData.element.style.opacity = '0';
        nodeData.element.style.transform = 'scale(0.8)';

        setTimeout(() => {
            nodeData.element.remove();
            this.nodes.delete(agentId);
            this.autoResizeCanvas();
            this.updateConnections();

            // Show empty state if no nodes
            if (this.nodes.size === 0 && this.emptyState) {
                this.emptyState.style.display = 'flex';
            }
        }, 300);
    }

    /**
     * Calculate initial position for a new node using snake layout
     * Odd rows go left-to-right, even rows go right-to-left
     */
    calculateInitialPosition(index, totalNodes = null) {
        const containerRect = this.space.getBoundingClientRect();
        const nodeWidth = 130;  // Readable node width
        const nodeHeight = 40;  // Comfortable height
        const padding = 20;
        const gapX = 40;        // Space for horizontal connectors
        const gapY = 30;        // Space for vertical connectors

        // Calculate how many nodes fit per row
        const availableWidth = containerRect.width - (padding * 2);
        const nodesPerRow = Math.max(1, Math.floor(availableWidth / (nodeWidth + gapX)));

        const row = Math.floor(index / nodesPerRow);
        let col = index % nodesPerRow;

        // Snake pattern: reverse column order on odd rows
        const isOddRow = row % 2 === 1;
        if (isOddRow) {
            col = nodesPerRow - 1 - col;
        }

        // Calculate row width for centering
        const total = totalNodes || this.nodes.size + 1;
        const nodesInThisRow = Math.min(nodesPerRow, total - row * nodesPerRow);
        const totalRowWidth = nodesInThisRow * (nodeWidth + gapX) - gapX;
        const rowOffset = (availableWidth - totalRowWidth) / 2;

        // For odd rows, we need to adjust the offset since we're filling from right
        let x;
        if (isOddRow) {
            // Position from the right side of the row
            const rightEdge = padding + rowOffset + totalRowWidth;
            x = rightEdge - (nodeWidth + gapX) * (nodesPerRow - 1 - col) - nodeWidth;
            // Simpler: just use same logic but col is already reversed
            x = padding + rowOffset + col * (nodeWidth + gapX);
        } else {
            x = padding + rowOffset + col * (nodeWidth + gapX);
        }

        return {
            x: x,
            y: padding + row * (nodeHeight + gapY)
        };
    }

    /**
     * Auto-resize the canvas to fit all nodes
     */
    autoResizeCanvas() {
        if (this.nodes.size === 0) {
            this.space.style.minHeight = '200px';
            return;
        }

        const nodeHeight = 40;
        const padding = 20;
        let maxY = 0;

        // Find the lowest node position
        this.nodes.forEach(nodeData => {
            const bottom = nodeData.position.y + nodeHeight;
            if (bottom > maxY) {
                maxY = bottom;
            }
        });

        // Set min-height to accommodate all nodes plus padding
        const requiredHeight = maxY + padding + 40; // Extra padding for controls
        const minHeight = Math.max(280, requiredHeight);
        this.space.style.minHeight = `${minHeight}px`;
    }

    /**
     * Update SVG connections between nodes
     */
    updateConnections() {
        if (!this.svg) return;

        // Clear existing paths (keep defs)
        const paths = this.svg.querySelectorAll('path, circle.particle');
        paths.forEach(p => p.remove());

        // Get ordered nodes
        const orderedNodes = Array.from(this.nodes.entries())
            .sort((a, b) => {
                const indexA = parseInt(a[1].element.dataset.index) || 0;
                const indexB = parseInt(b[1].element.dataset.index) || 0;
                return indexA - indexB;
            });

        if (orderedNodes.length < 2) return;

        // Calculate nodes per row for snake detection
        const containerRect = this.space.getBoundingClientRect();
        const nodeWidth = 130;
        const padding = 20;
        const gapX = 40;
        const availableWidth = containerRect.width - (padding * 2);
        const nodesPerRow = Math.max(1, Math.floor(availableWidth / (nodeWidth + gapX)));

        // Draw connections between sequential nodes
        for (let i = 0; i < orderedNodes.length - 1; i++) {
            const fromNode = orderedNodes[i][1];
            const toNode = orderedNodes[i + 1][1];

            // Determine if this is a row-end connection (vertical)
            const fromRow = Math.floor(i / nodesPerRow);
            const toRow = Math.floor((i + 1) / nodesPerRow);
            const isRowChange = fromRow !== toRow;

            this.drawConnection(fromNode, toNode, isRowChange);
        }
    }

    /**
     * Draw a Bezier connection between two nodes
     * @param {boolean} isVertical - True if this is a row-change connection
     */
    drawConnection(fromNode, toNode, isVertical = false) {
        const fromEl = fromNode.element;
        const toEl = toNode.element;

        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        const svgRect = this.svg.getBoundingClientRect();

        let fromX, fromY, toX, toY, cp1x, cp1y, cp2x, cp2y;

        if (isVertical) {
            // Vertical connection: bottom of from node to top of to node
            fromX = fromRect.left + fromRect.width / 2 - svgRect.left;
            fromY = fromRect.bottom - svgRect.top;
            toX = toRect.left + toRect.width / 2 - svgRect.left;
            toY = toRect.top - svgRect.top;

            // Vertical bezier control points
            const dy = Math.abs(toY - fromY);
            const controlOffset = Math.min(dy * 0.5, 40);
            cp1x = fromX;
            cp1y = fromY + controlOffset;
            cp2x = toX;
            cp2y = toY - controlOffset;
        } else {
            // Horizontal connection: determine direction based on positions
            const goingRight = toRect.left > fromRect.left;

            if (goingRight) {
                // Left to right: right port of from, left port of to
                fromX = fromRect.right - svgRect.left;
                toX = toRect.left - svgRect.left;
            } else {
                // Right to left: left port of from, right port of to
                fromX = fromRect.left - svgRect.left;
                toX = toRect.right - svgRect.left;
            }
            fromY = fromRect.top + fromRect.height / 2 - svgRect.top;
            toY = toRect.top + toRect.height / 2 - svgRect.top;

            // Horizontal bezier control points
            const dx = Math.abs(toX - fromX);
            const controlOffset = Math.min(dx * 0.5, 80);
            if (goingRight) {
                cp1x = fromX + controlOffset;
                cp2x = toX - controlOffset;
            } else {
                cp1x = fromX - controlOffset;
                cp2x = toX + controlOffset;
            }
            cp1y = fromY;
            cp2y = toY;
        }

        // Determine if both nodes are enabled
        const fromEnabled = !fromEl.classList.contains('disabled');
        const toEnabled = !toEl.classList.contains('disabled');
        const bothEnabled = fromEnabled && toEnabled;

        // Create path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${fromX} ${fromY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', bothEnabled ? 'url(#conn-gradient)' : 'rgba(107,122,143,0.3)');
        path.setAttribute('stroke-width', bothEnabled ? '2' : '1.5');
        path.setAttribute('filter', bothEnabled ? 'url(#conn-glow)' : '');
        path.classList.add('connection-path');

        if (!bothEnabled) {
            path.setAttribute('stroke-dasharray', '5,5');
        }

        this.svg.appendChild(path);

        // Add animated particle for active connections
        if (bothEnabled) {
            this.addParticle(path, fromX, fromY, toX, toY, cp1x, cp1y, cp2x, cp2y);
        }
    }

    /**
     * Add animated particle along connection path
     */
    addParticle(path, x1, y1, x2, y2, cp1x, cp1y, cp2x, cp2y) {
        const particle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        particle.setAttribute('r', '3');
        particle.setAttribute('fill', '#d4a853');
        particle.classList.add('particle');

        // Create animation
        const animate = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
        animate.setAttribute('dur', '2s');
        animate.setAttribute('repeatCount', 'indefinite');
        animate.setAttribute('path', `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`);

        particle.appendChild(animate);
        this.svg.appendChild(particle);
    }

    /**
     * Auto-arrange nodes in a grid layout
     */
    autoLayout() {
        const nodeArray = Array.from(this.nodes.entries());
        if (nodeArray.length === 0) return;

        // Sort by index
        nodeArray.sort((a, b) => {
            const indexA = parseInt(a[1].element.dataset.index) || 0;
            const indexB = parseInt(b[1].element.dataset.index) || 0;
            return indexA - indexB;
        });

        // Pre-calculate positions and required height
        const totalNodes = nodeArray.length;
        const newPositions = nodeArray.map(([id, nodeData], i) => ({
            id,
            position: this.calculateInitialPosition(i, totalNodes)
        }));

        // Pre-expand canvas to fit all nodes
        const nodeHeight = 40;
        const padding = 20;
        const maxY = Math.max(...newPositions.map(p => p.position.y));
        const requiredHeight = maxY + nodeHeight + padding + 30;
        this.space.style.minHeight = `${Math.max(200, requiredHeight)}px`;

        // Animate nodes to new positions
        newPositions.forEach(({ id, position }) => {
            this.animateNodeTo(id, position);
        });
    }

    /**
     * Animate a node to a target position
     */
    animateNodeTo(agentId, targetPos) {
        const nodeData = this.nodes.get(agentId);
        if (!nodeData) return;

        const el = nodeData.element;
        el.style.transition = 'left 0.4s cubic-bezier(0.34,1.56,0.64,1), top 0.4s cubic-bezier(0.34,1.56,0.64,1)';
        el.style.left = `${targetPos.x}px`;
        el.style.top = `${targetPos.y}px`;

        nodeData.position = targetPos;

        // Update connections during animation
        const updateInterval = setInterval(() => this.updateConnections(), 16);
        setTimeout(() => {
            clearInterval(updateInterval);
            el.style.transition = '';
            this.updateConnections();

            if (this.onPositionChange) {
                this.onPositionChange(agentId, targetPos);
            }
        }, 400);
    }

    // Mouse event handlers
    onMouseDown(e) {
        const nodeEl = e.target.closest('.agent-node-3d');
        if (!nodeEl) return;

        // Don't start drag if clicking on input or buttons
        if (e.target.matches('input, button')) return;

        this.startDrag(nodeEl, e.clientX, e.clientY);
    }

    onMouseMove(e) {
        if (!this.isDragging || !this.dragTarget) return;
        this.moveDrag(e.clientX, e.clientY);
    }

    onMouseUp(e) {
        this.endDrag();
    }

    // Touch event handlers
    onTouchStart(e) {
        const nodeEl = e.target.closest('.agent-node-3d');
        if (!nodeEl) return;

        // Don't start drag if touching input or buttons
        if (e.target.matches('input, button')) return;

        e.preventDefault();
        const touch = e.touches[0];
        this.startDrag(nodeEl, touch.clientX, touch.clientY);
    }

    onTouchMove(e) {
        if (!this.isDragging || !this.dragTarget) return;
        e.preventDefault();
        const touch = e.touches[0];
        this.moveDrag(touch.clientX, touch.clientY);
    }

    onTouchEnd(e) {
        this.endDrag();
    }

    // Drag helper methods
    startDrag(nodeEl, clientX, clientY) {
        this.isDragging = true;
        this.dragTarget = nodeEl;

        const rect = nodeEl.getBoundingClientRect();
        const spaceRect = this.space.getBoundingClientRect();

        this.dragOffset = {
            x: clientX - rect.left,
            y: clientY - rect.top
        };

        nodeEl.classList.add('dragging');
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
    }

    moveDrag(clientX, clientY) {
        if (!this.dragTarget) return;

        const spaceRect = this.space.getBoundingClientRect();
        const nodeRect = this.dragTarget.getBoundingClientRect();

        let x = clientX - spaceRect.left - this.dragOffset.x;
        let y = clientY - spaceRect.top - this.dragOffset.y;

        // Constrain to container
        const padding = 10;
        x = Math.max(padding, Math.min(x, spaceRect.width - nodeRect.width - padding));
        y = Math.max(padding, Math.min(y, spaceRect.height - nodeRect.height - padding));

        this.dragTarget.style.left = `${x}px`;
        this.dragTarget.style.top = `${y}px`;

        // Update node position in map
        const agentId = this.dragTarget.dataset.id;
        if (this.nodes.has(agentId)) {
            this.nodes.get(agentId).position = { x, y };
        }

        this.updateConnections();
    }

    endDrag() {
        if (!this.isDragging) return;

        if (this.dragTarget) {
            this.dragTarget.classList.remove('dragging');

            const agentId = this.dragTarget.dataset.id;
            const nodeData = this.nodes.get(agentId);

            if (nodeData && this.onPositionChange) {
                this.onPositionChange(agentId, nodeData.position);
            }

            // Resize canvas in case node was dragged to new position
            this.autoResizeCanvas();
        }

        this.isDragging = false;
        this.dragTarget = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }

    /**
     * Clear all nodes
     */
    clear() {
        this.nodes.forEach((nodeData, id) => {
            nodeData.element.remove();
        });
        this.nodes.clear();
        this.autoResizeCanvas();
        this.updateConnections();

        if (this.emptyState) {
            this.emptyState.style.display = 'flex';
        }
    }

    /**
     * Escape HTML for safe rendering
     */
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Destroy the canvas instance
     */
    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        this.clear();
    }
}

export { KBCanvas };
