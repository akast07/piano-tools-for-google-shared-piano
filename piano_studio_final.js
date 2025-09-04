// ==UserScript==
// @name         Chrome Music Lab Shared Piano Studio
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Metronome and MIDI recorder for Chrome Music Lab Shared Piano
// @author       You
// @match        https://musiclab.chromeexperiments.com/Shared-Piano/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    let metronome = {
        isRunning: false, bpm: 120, intervalId: null, audioContext: null,
        clickBuffer: null, accentBuffer: null, currentBeat: 0, beatsPerMeasure: 4,
        beatUnit: 4, accentFirstBeat: true, isMuted: false, volume: 0.7,
        currentMeasure: 1, tapTimes: [], audioReady: false
    };

    let midiRecorder = { isRecording: false, startTime: null, notes: [], midiAccess: null };
    let dragState = { isDragging: false, offset: { x: 0, y: 0 } };
    let theme = { current: 'dark', backgroundImage: null };
    let settings = { shortcutsEnabled: true, sectionsCollapsed: { metronome: false, midi: false, theme: true } };
    
    // Cleanup tracking
    let eventListeners = [];
    let intervals = [];
    let timeouts = [];

    function addEventListenerTracked(element, event, handler, options) {
        element.addEventListener(event, handler, options);
        eventListeners.push({ element, event, handler, options });
    }

    function setIntervalTracked(callback, delay) {
        const id = setInterval(callback, delay);
        intervals.push(id);
        return id;
    }

    function setTimeoutTracked(callback, delay) {
        const id = setTimeout(callback, delay);
        timeouts.push(id);
        return id;
    }

    function cleanup() {
        eventListeners.forEach(({ element, event, handler, options }) => {
            element.removeEventListener(event, handler, options);
        });
        eventListeners = [];

        intervals.forEach(clearInterval);
        timeouts.forEach(clearTimeout);
        intervals = [];
        timeouts = [];

        if (metronome.isRunning) {
            stopMetronome();
        }

        if (metronome.audioContext && metronome.audioContext.state !== 'closed') {
            metronome.audioContext.close();
        }
    }

    function waitForLoad() {
        if (document.readyState === 'loading') {
            addEventListenerTracked(document, 'DOMContentLoaded', initStudio);
        } else { 
            initStudio(); 
        }
        
        addEventListenerTracked(window, 'beforeunload', cleanup);
    }

    async function createClickSounds() {
        try {
            // Only create audio context after user interaction
            if (!metronome.audioContext) {
                metronome.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (metronome.audioContext.state === 'suspended') {
                await metronome.audioContext.resume();
            }

            const sampleRate = metronome.audioContext.sampleRate;
            const clickLength = 0.1;
            const frameCount = sampleRate * clickLength;
            
            metronome.clickBuffer = metronome.audioContext.createBuffer(1, frameCount, sampleRate);
            metronome.accentBuffer = metronome.audioContext.createBuffer(1, frameCount, sampleRate);
            const clickData = metronome.clickBuffer.getChannelData(0);
            const accentData = metronome.accentBuffer.getChannelData(0);
            
            for (let i = 0; i < frameCount; i++) {
                clickData[i] = Math.sin(2 * Math.PI * 600 * i / sampleRate) * Math.exp(-i / (sampleRate * 0.05));
                accentData[i] = Math.sin(2 * Math.PI * 1000 * i / sampleRate) * Math.exp(-i / (sampleRate * 0.08)) * 1.2;
            }
            
            metronome.audioReady = true;
            return true;
        } catch (error) {
            console.warn('Audio context creation failed:', error);
            metronome.audioReady = false;
            return false;
        }
    }
    function playClick() {
        if (!metronome.audioContext || metronome.isMuted || !metronome.audioReady) return;
    
        const beatInMeasure = (metronome.currentBeat % metronome.beatsPerMeasure) + 1;
        const isAccentBeat = (beatInMeasure === 1); // Accent only on first beat of measure
    
        const buffer = (metronome.accentFirstBeat && isAccentBeat) ? metronome.accentBuffer : metronome.clickBuffer;
        if (!buffer) return;
    
        try {
            const source = metronome.audioContext.createBufferSource();
            const gainNode = metronome.audioContext.createGain();
            source.buffer = buffer;
            gainNode.gain.value = metronome.volume;
            source.connect(gainNode);
            gainNode.connect(metronome.audioContext.destination);
            source.start();
        } catch (error) {
            console.warn('Audio playback failed:', error);
        }
    
        updateBeatIndicator(beatInMeasure);
        metronome.currentBeat++;
    }
    function updateBeatIndicator(beatInMeasure) {
        const indicator = document.getElementById('metronome-beat-indicator');
        const measureDisplay = document.getElementById('measure-display');
    
        if (indicator) {
            indicator.textContent = `${beatInMeasure}/${metronome.beatsPerMeasure}`;
        }
    
        if (beatInMeasure === 1 && metronome.currentBeat > 0) {
            metronome.currentMeasure++;
            if (measureDisplay) measureDisplay.textContent = metronome.currentMeasure;
        }
    
        if (beatInMeasure === 1) {
            indicator.style.color = '#ff4444';
            indicator.style.transform = 'scale(1.1)';
            setTimeoutTracked(() => {
                indicator.style.color = '#667eea';
                indicator.style.transform = 'scale(1)';
            }, 150);
        }
    }
    
    //
    async function startMetronome() {
        
        if (metronome.intervalId) {
            clearInterval(metronome.intervalId);
            intervals = intervals.filter(id => id !== metronome.intervalId);
            metronome.intervalId = null;
        }
        if (metronome.isRunning) return;
        
        updateTimeSignature();

        // Initialize audio on first user interaction
        if (!metronome.audioReady) {
            const audioInitialized = await createClickSounds();
            if (!audioInitialized) {
                console.log('Audio initialization failed. Metronome will run silently.');
            }
        }
        
        if (metronome.audioContext && metronome.audioContext.state === 'suspended') {
            await metronome.audioContext.resume();
        }
        
        metronome.intervalId = setIntervalTracked(playClick, 60000 / metronome.bpm);
        metronome.isRunning = true;
        metronome.currentBeat = 0;
        metronome.currentMeasure = 1;
        
        updateMetronomeButtonUI(); //start/stop metronome button

        //measure display update        
        const measureDisplay = document.getElementById('measure-display');
        if (measureDisplay) measureDisplay.textContent = '1';
    }

    function stopMetronome() {
        if (!metronome.isRunning) return;
        
        metronome.isRunning = false;
        metronome.currentBeat = 0;
        metronome.currentMeasure = 1;

        if (metronome.intervalId) {
            clearInterval(metronome.intervalId);
            const index = intervals.indexOf(metronome.intervalId);
            if (index > -1) intervals.splice(index, 1);
            metronome.intervalId = null;
        }
        
        
        updateMetronomeButtonUI();
        
        document.getElementById('metronome-beat-indicator').textContent = `0/${metronome.beatsPerMeasure}`;
        const measureDisplay = document.getElementById('measure-display');
        if (measureDisplay) measureDisplay.textContent = '1';
    }

    function createStudioUI() {
        const container = document.createElement('div');
        container.id = 'piano-studio-container';
        container.style.cssText = `position: fixed; top: 20px; right: 20px; border-radius: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 10000; font-family: Arial, sans-serif;
            font-size: 14px; min-width: 220px; cursor: move; user-select: none;`;

        container.innerHTML = `
            <div id="studio-header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white; padding: 8px 12px; border-radius: 10px 10px 0 0; cursor: move;
                display: flex; justify-content: space-between; align-items: center;">
                <strong>Piano Studio</strong>
                <button id="main-collapse-btn" style="background: rgba(255,255,255,0.2); border: none;
                    color: white; width: 24px; height: 24px; border-radius: 50%; cursor: pointer; font-size: 12px;">−</button>
            </div>
            
            <div id="studio-content" style="padding: 15px;">
                <div class="section-header" data-section="metronome" style="display: flex; justify-content: space-between;
                    align-items: center; cursor: pointer; margin-bottom: 10px; padding: 6px; background: rgba(255,255,255,0.1);
                    border-radius: 6px;"><strong>Metronome</strong><span class="collapse-icon">−</span></div>
                
                <div class="section-content" data-section="metronome">
                    <div style="margin-bottom: 10px;">
                        <label>BPM: <span id="bpm-display">${metronome.bpm}</span></label>
                        <div style="display: flex; gap: 6px; align-items: center; margin-top: 5px;">
                            <input type="range" id="bpm-slider" min="20" max="300" value="${metronome.bpm}" style="flex: 1;">
                            <input type="number" id="bpm-input" min="20" max="300" value="${metronome.bpm}"
                                style="width: 50px; padding: 3px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;">
                            <button id="tap-tempo" style="background: linear-gradient(135deg, #fd79a8, #e84393);
                                color: white; border: none; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 10px;">TAP</button>
                        </div>
                    </div>

                    <div style="margin-bottom: 10px;">
                        <label>Time Signature:</label>
                        <div style="display: flex; gap: 6px; align-items: center; margin-top: 5px;">
                        <input type="number" id="beats-per-measure" min="1" max="32" value="${metronome.beatsPerMeasure}"
                            style="width: 40px; padding: 3px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;" title="Beats per measure">
                            <span>/</span>
                            <input type="number" id="beat-unit" value="${metronome.beatUnit}" min="1" max="64" step="1" list="valid=beats"
                            style="width: 40px; padding: 3px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;" title="Beat unit">
                            <datalist id="valid-beats">
                                <option value="1">
                                <option value="2">
                                <option value="4">
                                <option value="8">
                                <option value="16">
                                <option value="32">
                                <option value="64">
                                </datalist>
                        </div>
                    </div>
                    
                    <div style="display: flex; gap: 8px; margin-bottom: 10px; align-items: center; font-size: 12px;">
                        <label style="display: flex; align-items: center; gap: 4px;">
                            <input type="checkbox" id="accent-toggle" checked>Accent 1st
                        </label>
                        <button id="mute-toggle" style="background: linear-gradient(135deg, #74b9ff, #0984e3);
                            color: white; border: none; padding: 4px 8px; border-radius: 12px; cursor: pointer; font-size: 10px;">VOL</button>
                    </div>

                    <div style="margin-bottom: 10px;">
                        <label style="font-size: 12px;">Vol: <span id="volume-display">70%</span></label>
                        <input type="range" id="volume-slider" min="0" max="100" value="70" style="width: 100%; margin-top: 2px;">
                    </div>

                    <div style="text-align: center; margin-bottom: 10px;">
                        <div style="font-size: 16px; font-weight: bold; color: #667eea; margin-bottom: 3px;">
                            Measure <span id="measure-display">1</span>
                        </div>
                        <div id="metronome-beat-indicator">0/${metronome.beatsPerMeasure}</div>
                    </div>

                    <div style="text-align: center; margin-bottom: 10px;">
                        <button id="metronome-start" style="background: linear-gradient(135deg, #4CAF50, #45a049);
                            color: white; border: none; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 14px;">Start</button>
                    </div>
                </div>

                <div class="section-header" data-section="midi" style="display: flex; justify-content: space-between;
                    align-items: center; cursor: pointer; margin-bottom: 10px; padding: 6px; background: rgba(255,255,255,0.1);
                    border-radius: 6px;"><strong>MIDI Recorder</strong><span class="collapse-icon">−</span></div>
                
                <div class="section-content" data-section="midi">
                    <div style="display: flex; gap: 6px; margin-bottom: 8px;">
                        <button id="midi-record" style="background: linear-gradient(135deg, #ff4757, #ff3838);
                            color: white; border: none; padding: 6px 12px; border-radius: 15px; cursor: pointer; flex: 1; font-size: 12px;">Record</button>
                        <button id="midi-clear" style="background: linear-gradient(135deg, #ffa502, #ff6348);
                            color: white; border: none; padding: 6px 12px; border-radius: 15px; cursor: pointer; flex: 1; font-size: 12px;">Clear</button>
                        <button id="midi-export" style="background: linear-gradient(135deg, #3742fa, #2f3542);
                            color: white; border: none; padding: 6px 12px; border-radius: 15px; cursor: pointer; flex: 1; font-size: 12px;">Export</button>
                    </div>
                    <div style="font-size: 11px; color: #666; text-align: center;">
                        <div id="midi-status">Connect MIDI device</div>
                        <div>Notes: <span id="note-count">0</span></div>
                    </div>
                </div>

                <div class="section-header" data-section="theme" style="display: flex; justify-content: space-between;
                    align-items: center; cursor: pointer; margin-bottom: 10px; padding: 6px; background: rgba(255,255,255,0.1);
                    border-radius: 6px;"><strong>Theme</strong><span class="collapse-icon">+</span></div>
                
                <div class="section-content" data-section="theme" style="display: none;">
                    <div style="display: flex; gap: 4px; margin-bottom: 8px; justify-content: center;">
                        <button id="theme-dark" class="theme-btn" style="background: linear-gradient(135deg, #2d3436, #636e72);
                            color: white; border: 2px solid #667eea; padding: 4px 8px; border-radius: 12px; cursor: pointer; font-size: 10px;">Dark</button>
                        <button id="theme-light" class="theme-btn" style="background: linear-gradient(135deg, #ddd, #fff);
                            color: #333; border: 2px solid transparent; padding: 4px 8px; border-radius: 12px; cursor: pointer; font-size: 10px;">Light</button>
                        <button id="theme-neon" class="theme-btn" style="background: linear-gradient(135deg, #00cec9, #6c5ce7);
                            color: white; border: 2px solid transparent; padding: 4px 8px; border-radius: 12px; cursor: pointer; font-size: 10px;">Neon</button>
                            
                        <button id="theme-reset-btn" class="theme-btn" title="Clear background image and restore default theme"
                            style="background: linear-gradient(135deg, #636e72, #2d3436);
                            color: white; border: 2px solid transparent; padding: 4px 8px; border-radius: 12px; cursor: pointer; font-size: 10px;">
                            Reset Theme
                        </button>
                                            
                            
                            </div>
                    <div style="text-align: center; margin-bottom: 8px;">
                        <input type="file" id="bg-upload" accept="image/*" style="display: none;">
                        <button id="bg-upload-btn" style="background: linear-gradient(135deg, #a29bfe, #6c5ce7);
                            color: white; border: none; padding: 4px 8px; border-radius: 12px; cursor: pointer; font-size: 10px;">Custom BG</button>
                    </div>
                    <div style="text-align: center;">
                        <label style="display: flex; align-items: center; gap: 5px; font-size: 11px; justify-content: center;">
                            <input type="checkbox" id="shortcuts-toggle" checked>Enable shortcuts
                        </label>
                    </div>
                </div>
                
                <div id="shortcuts-help" style="margin-top: 10px; font-size: 10px; color: #666; line-height: 1.4;">
                    <div><strong>Ctrl+Space</strong>: Toggle Metronome</div>
                    <div><strong>Ctrl+R</strong>: Start/Stop Recording</div>
                    <div><strong>T</strong>: Tap Tempo</div>
                    <div><strong>Ctrl+Del</strong>: Clear Notes</div>
                </div>
            
            </div>
        `;
        document.body.appendChild(container);
        return container;
    }

    function setupDragAndDrop(container) {
        const header = document.getElementById('studio-header');
        
        function handleMouseDown(e) {
            if (e.target.id === 'main-collapse-btn') return;
            dragState.isDragging = true;
            const rect = container.getBoundingClientRect();
            dragState.offset.x = e.clientX - rect.left;
            dragState.offset.y = e.clientY - rect.top;
            addEventListenerTracked(document, 'mousemove', handleDrag);
            addEventListenerTracked(document, 'mouseup', stopDrag);
            e.preventDefault();
        }
        
        function handleDrag(e) {
            if (!dragState.isDragging) return;
            const x = Math.max(0, Math.min(e.clientX - dragState.offset.x, window.innerWidth - container.offsetWidth));
            const y = Math.max(0, Math.min(e.clientY - dragState.offset.y, window.innerHeight - container.offsetHeight));
            container.style.left = x + 'px';
            container.style.top = y + 'px';
            container.style.right = 'auto';
        }
        
        function stopDrag() {
            dragState.isDragging = false;
            document.removeEventListener('mousemove', handleDrag);
            document.removeEventListener('mouseup', stopDrag);
        }
        
        addEventListenerTracked(header, 'mousedown', handleMouseDown);
    }

    function setupCollapses() {
        addEventListenerTracked(document.getElementById('main-collapse-btn'), 'click', () => {
            const content = document.getElementById('studio-content');
            const btn = document.getElementById('main-collapse-btn');
            const isCollapsed = content.style.display === 'none';
            content.style.display = isCollapsed ? 'block' : 'none';
            btn.textContent = isCollapsed ? '−' : '+';

            saveStudioSettings();
        });

        document.querySelectorAll('.section-header').forEach(header => {
            addEventListenerTracked(header, 'click', () => {
                const section = header.dataset.section;
                const content = document.querySelector(`.section-content[data-section="${section}"]`);
                const icon = header.querySelector('.collapse-icon');
                const isCollapsed = content.style.display === 'none';
                content.style.display = isCollapsed ? 'block' : 'none';
                icon.textContent = isCollapsed ? '−' : '+';
                settings.sectionsCollapsed[section] = !isCollapsed;
                
                saveStudioSettings();
            });
        });

        Object.entries(settings.sectionsCollapsed).forEach(([section, isCollapsed]) => {
        const content = document.querySelector(`.section-content[data-section="${section}"]`);
        const icon = document.querySelector(`.section-header[data-section="${section}"] .collapse-icon`);
        if (content && icon) {
            content.style.display = isCollapsed ? 'none' : 'block';
            icon.textContent = isCollapsed ? '+' : '−';
        }
        });
    }
    //helper function for bpm playback
    function updateMetronomeButtonUI() {
        const btn = document.getElementById('metronome-start');
        if (!btn) return;
    
        if (metronome.isRunning) {
            btn.textContent = 'Stop';
            btn.style.background = 'linear-gradient(135deg, #ff6b6b, #ee5a52)';
        } else {
            btn.textContent = 'Start';
            btn.style.background = 'linear-gradient(135deg, #4CAF50, #45a049)';
        }
    }
    
    //setup metronome 
    function setupMetronomeControls() {
        const bpmSlider = document.getElementById('bpm-slider');
        const bpmInput = document.getElementById('bpm-input');
        const bpmDisplay = document.getElementById('bpm-display');
        
        function updateBPM(value, restart = true) {
            const newBPM = Math.max(20, Math.min(300, parseInt(value) || 120));
            if (newBPM === metronome.bpm) return;
            
            metronome.bpm = newBPM;
            bpmDisplay.textContent = metronome.bpm;
            bpmSlider.value = metronome.bpm;
            bpmInput.value = metronome.bpm;
            
            saveStudioSettings();

            if (restart && metronome.isRunning) {
                stopMetronome();
                setTimeoutTracked(() => {startMetronome(); updateMetronomeButtonUI();}, 100);
            }
        }
        
        addEventListenerTracked(bpmSlider, 'input', (e) => updateBPM(e.target.value));
        addEventListenerTracked(bpmInput, 'change', (e) => updateBPM(e.target.value));
        
        // Improved tap tempo with edge case handling
        addEventListenerTracked(document.getElementById('tap-tempo'), 'click', () => {
            const now = performance.now();
            metronome.tapTimes.push(now);
            
            if (metronome.tapTimes.length > 8) {
                metronome.tapTimes.shift();
            }
            
            if (metronome.tapTimes.length >= 2) {
                const intervals = metronome.tapTimes.slice(1).map((time, i) => time - metronome.tapTimes[i]);
                
                // Filter realistic intervals: 200ms (300 BPM) to 2000ms (30 BPM)
                // const validIntervals = intervals.filter(interval => interval >= 200 && interval <= 2000);
                // Filter realistic intervals: 100ms (600 BPM) to 3000ms (20 BPM)
                const validIntervals = intervals.filter(interval => interval >= 100 && interval <= 3000);

                if (validIntervals.length > 0) {
                    const avgInterval = validIntervals.reduce((a, b) => a + b) / validIntervals.length;
                    const newBPM = Math.round(60000 / avgInterval);
                    
                    if (newBPM >= 20 && newBPM <= 300) {
                        updateBPM(newBPM);
                    }
                    
                }
            }
            
            // Clear old taps after 3 seconds
            setTimeoutTracked(() => {
                const lastTap = metronome.tapTimes[metronome.tapTimes.length - 1];
                if (lastTap && (performance.now() - lastTap) >= 3000) {
                    metronome.tapTimes = [];
                }
            }, 3000);
        });

        addEventListenerTracked(document.getElementById('beat-unit'), 'input', updateTimeSignature);
        addEventListenerTracked(document.getElementById('beats-per-measure'), 'input', updateTimeSignature);

        addEventListenerTracked(document.getElementById('accent-toggle'), 'change', (e) => {
            metronome.accentFirstBeat = e.target.checked;
        });
        
        addEventListenerTracked(document.getElementById('volume-slider'), 'input', (e) => {
            metronome.volume = parseFloat(e.target.value) / 100;
            document.getElementById('volume-display').textContent = Math.round(metronome.volume * 100) + '%';
            
            saveStudioSettings();
        });

        addEventListenerTracked(document.getElementById('mute-toggle'), 'click', (e) => {
            metronome.isMuted = !metronome.isMuted;
            e.target.textContent = metronome.isMuted ? 'MUTE' : 'VOL';
            e.target.style.background = metronome.isMuted ? 
                'linear-gradient(135deg, #636e72, #2d3436)' : 
                'linear-gradient(135deg, #74b9ff, #0984e3)';
        });

        addEventListenerTracked(document.getElementById('metronome-start'), 'click', () =>{
            metronome.isRunning ? stopMetronome() : startMetronome();
            } );
        }
        function updateTimeSignature() {
            const beatsInput = document.getElementById('beats-per-measure'); // top input
            const beatUnitInput = document.getElementById('beat-unit'); // bottom input
        
            const newBeats = Math.max(1, Math.min(32, parseInt(beatsInput.value) || 4));
            let newBeatUnit = Math.max(1, Math.min(32, parseInt(beatUnitInput.value) || 4));
            
            const validUnits = [1, 2, 4, 8, 16, 32, 64];
            if (!validUnits.includes(newBeatUnit)) {
                newBeatUnit = 4; // fallback
            }

            metronome.beatsPerMeasure = newBeats;
            metronome.beatUnit = newBeatUnit;
        
            beatsInput.value = metronome.beatsPerMeasure;
            beatUnitInput.value = metronome.beatUnit;
        
            const indicator = document.getElementById('metronome-beat-indicator');
            if (indicator) {
                indicator.textContent = `0/${metronome.beatsPerMeasure}`;
            }
        
            if (metronome.isRunning) {
                metronome.currentBeat = 0;
                metronome.currentMeasure = 1;
                document.getElementById('measure-display').textContent = '1';
            }
            
            //console.log("Raw input values:", beatsInput.value, "/", beatUnitInput.value);

            saveStudioSettings();
        }
        
    async function setupMidiControls() {
        try {
            if (navigator.requestMIDIAccess) {
                midiRecorder.midiAccess = await navigator.requestMIDIAccess();
                document.getElementById('midi-status').textContent = 'MIDI ready';
                document.getElementById('midi-status').style.color = '#4CAF50';
                
                // midiRecorder.midiAccess.inputs.forEach(input => {
                //     input.onmidimessage = handleMidiMessage;
                // });

                midiRecorder.midiAccess.inputs.forEach(input => {
                    if (!input._boundToStudio) {
                        input.onmidimessage = handleMidiMessage;
                        input._boundToStudio = true;
                    }
                });
                

            } else {
                throw new Error('MIDI not supported');
            }
        } catch (err) {
            document.getElementById('midi-status').textContent = 'No MIDI support';
            document.getElementById('midi-status').style.color = '#ff4757';
            console.warn('MIDI setup failed:', err);
        }

        addEventListenerTracked(document.getElementById('midi-record'), 'click', () => {
            if (!midiRecorder.isRecording) {
                midiRecorder.isRecording = true;
                //midiRecorder.startTime = performance.now();
                midiRecorder.startTime = metronome.startTime || performance.now();
                midiRecorder.notes = [];
                document.getElementById('midi-record').textContent = 'Stop';
                document.getElementById('midi-record').style.background = 'linear-gradient(135deg, #ff6b6b, #ee5a52)';
            } else {
                midiRecorder.isRecording = false;
                document.getElementById('midi-record').textContent = 'Record';
                document.getElementById('midi-record').style.background = 'linear-gradient(135deg, #ff4757, #ff3838)';
            }
        });

        addEventListenerTracked(document.getElementById('midi-clear'), 'click', () => {
            midiRecorder.notes = [];
            midiRecorder.isRecording = false;
            document.getElementById('midi-record').textContent = 'Record';
            document.getElementById('midi-record').style.background = 'linear-gradient(135deg, #ff4757, #ff3838)';
            document.getElementById('note-count').textContent = '0';
        });

        addEventListenerTracked(document.getElementById('midi-export'), 'click', () => {
            if (midiRecorder.notes.length === 0) {
                console.log('No notes recorded!');
                return;
            }
            try {

                //stop performance
                midiRecorder.isRecording = false;
                document.getElementById('midi-record').textContent = 'Record';
                document.getElementById('midi-record').style.background = 'linear-gradient(135deg, #ff4757, #ff3838)';
                //
                const midiData = createMidiFile(midiRecorder.notes);
                downloadMidi(midiData, `piano-recording-${Date.now()}.mid`);
            } catch (error) {
                console.error('MIDI export failed:', error);
                console.log('Failed to export MIDI file');
            }
        });
    }

    function handleMidiMessage(event) {
        if (!midiRecorder.isRecording) return;
        const [status, d1, d2] = event.data;
        const type    = status & 0xF0;
        const channel = status & 0x0F;
        const time    = performance.now() - midiRecorder.startTime;

  // note events (keep as-is) …
        if (type === 0x90 || type === 0x80) {
            midiRecorder.notes.push({
                type: 'note', isNoteOn: type===0x90 && d2>0,
                note: d1, velocity: d2, time, channel
              });
        }
        else if (type === 0xB0) {
            // control change: sustain, mod, expression
            if ([64, 1, 7, 11].includes(d1)) {
              midiRecorder.notes.push({
                type: 'control',
                controller: d1,
                value: d2,
                time, channel
              });
            }
          }
          else if (type === 0xA0) {
            // polyphonic aftertouch
            midiRecorder.notes.push({
              type: 'aftertouch',
              note: d1,
              pressure: d2,
              time, channel
            });
          }
          else if (type === 0xD0) {
            // channel pressure
            midiRecorder.notes.push({
              type: 'channelPressure',
              pressure: d1,
              time, channel
            });
          }

        // Optional: update UI
        const noteOnCount = midiRecorder.notes.filter(n => n.type === 'note' && n.isNoteOn).length;
        document.getElementById('note-count').textContent = noteOnCount;
    }
    

    function setupThemeControls() {
        const container = document.getElementById('piano-studio-container');

        //theme setup
        addEventListenerTracked(document.getElementById('theme-dark'), 'click', () =>{
            theme.backgroundImage = null;
            applyTheme('dark');
            saveStudioSettings();
        });
        addEventListenerTracked(document.getElementById('theme-light'), 'click', () => {
            theme.backgroundImage = null;   
            applyTheme('light'); 
            saveStudioSettings();
        });
        addEventListenerTracked(document.getElementById('theme-neon'), 'click', () => {
            theme.backgroundImage = null;   
            applyTheme('neon');
            saveStudioSettings();
        });
        
        //reset img
        addEventListenerTracked(document.getElementById('theme-reset-btn'), 'click', () => {
            theme.backgroundImage = null;
            applyTheme(theme.current); // Reapply current theme without image
            saveStudioSettings();
        });
        
        //added img bttn
        addEventListenerTracked(document.getElementById('bg-upload-btn'), 'click', () => {
            document.getElementById('bg-upload').click();
        });
        
        addEventListenerTracked(document.getElementById('bg-upload'), 'change', (e) => {
            const file = e.target.files[0];
            if (file && file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    theme.backgroundImage = event.target.result;
                    container.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url(${theme.backgroundImage})`;
                    container.style.backgroundSize = 'cover';
                    container.style.color = '#fff';
                    container.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
                    console.log("Background image saved:", theme.backgroundImage);

                    saveStudioSettings();
                };
                reader.readAsDataURL(file);

            }
        });

        //shortcuts toggles
        const shortcutToggle = document.getElementById('shortcuts-toggle');
        const helpDiv = document.getElementById('shortcuts-help');

        if (shortcutToggle) {
            shortcutToggle.checked = settings.shortcutsEnabled;
        }
        if (helpDiv) {
            helpDiv.style.opacity = settings.shortcutsEnabled ? '1' : '0.5';
        }


        addEventListenerTracked(document.getElementById('shortcuts-toggle'), 'change', (e) => {
            settings.shortcutsEnabled = e.target.checked;
            document.getElementById('shortcuts-help').style.opacity = settings.shortcutsEnabled ? '1' : '0.5';
            
            saveStudioSettings();
        });
        
        function applyTheme(themeName) {
            theme.current = themeName;
            // Only clear background if switching themes and no saved image
            if (!theme.backgroundImage) {
                container.style.backgroundImage = 'none';
                container.style.textShadow = 'none';
            }

            document.querySelectorAll('.theme-btn').forEach(btn => {
                btn.style.border = '2px solid transparent';
            });
            document.getElementById(`theme-${themeName}`).style.border = '2px solid #667eea';
            
            switch(themeName) {
                case 'dark':
                    container.style.background = 'rgba(45, 52, 54, 0.95)';
                    container.style.color = '#ddd';
                    break;
                case 'light':
                    container.style.background = 'rgba(255, 255, 255, 0.95)';
                    container.style.color = '#333';
                    break;
                case 'neon':
                    container.style.background = 'rgba(0, 0, 0, 0.9)';
                    container.style.color = '#00cec9';
                    container.style.boxShadow = '0 0 20px rgba(0, 206, 201, 0.5)';
                    break;
            }

            if (theme.backgroundImage) {
                container.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.6)), url(${theme.backgroundImage})`;
                container.style.backgroundSize = 'cover';
                container.style.color = '#fff';
                container.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
            } else {
                container.style.backgroundImage = 'none';
                container.style.textShadow = 'none';
            }
            
            
            saveStudioSettings();
        }
        
        applyTheme(theme.current);
        
    }

    function setupKeyboardShortcuts() {
        function handleKeyDown(e) {
            if (!settings.shortcutsEnabled) return;
            if (e.target.matches('input, textarea, select')) return;
            
            if (e.ctrlKey && e.code === 'Space') {
                e.preventDefault();
                metronome.isRunning ? stopMetronome() : startMetronome();
            }
            if (e.ctrlKey && e.code === 'KeyR') {
                e.preventDefault();
                document.getElementById('midi-record').click();
            }
            if (e.ctrlKey && e.code === 'Delete') {
                e.preventDefault();
                document.getElementById('midi-clear').click();
            }
            if (e.code === 'KeyT' && !e.ctrlKey) {
                e.preventDefault();
                document.getElementById('tap-tempo').click();
            }
        }
        
        addEventListenerTracked(document, 'keydown', handleKeyDown);
    }
    // VLQ helper (always emits at least one byte)
function encodeVariableLength(value) {
    let buffer = [];
    let val = value & 0x7F;
    while ((value >>= 7) > 0) {
      buffer.unshift((value & 0x7F) | 0x80);
    }
    buffer.push(val);
    return buffer;
  }
  
  // 32-bit BE helper
  function encodeUint32(v) {
    return [
      (v >>> 24) & 0xFF,
      (v >>> 16) & 0xFF,
      (v >>>  8) & 0xFF,
       v         & 0xFF
    ];
  }
  
  function createMidiFile(notes) {
    // 1) CONFIG
    const ticksPerQuarter  = 480;
    const bpm              = metronome.bpm;
    const beatsPerMeasure  = metronome.beatsPerMeasure;
    let   beatUnit         = metronome.beatUnit;
    if (![1,2,4,8,16,32,64].includes(beatUnit)) beatUnit = 4;
    const beatUnitValue = Math.log2(beatUnit) | 0;
  
    // 2) HEADER CHUNK (MThd + division)
    const header = [
      0x4D,0x54,0x68,0x64,        // "MThd"
      0x00,0x00,0x00,0x06,        // 6 bytes follow
      0x00,0x01,                  // format 1
      0x00,0x02,                  // two tracks
      (ticksPerQuarter >>> 8) & 0xFF, // division hi
      ticksPerQuarter & 0xFF         // division lo
    ];
  
    // 3) META TRACK
    const meta = [];
    // 3a) time signature
    meta.push(
      0x00, 0xFF, 0x58, 0x04,
      beatsPerMeasure,
      beatUnitValue,
      0x18, 0x08
    );
    // 3b) tempo
    const usPerQuarter = Math.floor(60_000_000 / bpm);
    meta.push(
      0x00, 0xFF, 0x51, 0x03,
      (usPerQuarter >>> 16) & 0xFF,
      (usPerQuarter >>>  8) & 0xFF,
       usPerQuarter         & 0xFF
    );
    // 3c) end-of-track
    meta.push(0x00, 0xFF, 0x2F, 0x00);
  
    const metaHeader = [0x4D,0x54,0x72,0x6B]; // "MTrk"
    const metaLength = encodeUint32(meta.length);
  
    // 4) SORT & PREPARE ALL EVENTS
    const sortedEvents = notes
      .map(e => ({ ...e, time: Math.max(0, e.time) }))
      .sort((a, b) => a.time - b.time);
  
    // helper: ms → ticks
    const msToTicks = ms =>
      Math.floor((ms * ticksPerQuarter * bpm) / (60 * 1000));
  
    // 5) NOTE & CC ENCODING
    const trackData = [];
    let lastTick = 0;
  
    sortedEvents.forEach(ev => {
      // Δ-time
      const ticks = msToTicks(ev.time);
      const delta = Math.max(0, ticks - lastTick);
      lastTick    = ticks;
      const vlq   = encodeVariableLength(delta);
      const ch = ev.channel & 0x0F;
  
      switch(ev.type) {
        case 'note':
          const status = ev.isNoteOn ? 0x90|ch : 0x80|ch;
          const note   = clamp(ev.note, 0, 127);
          const vel    = ev.isNoteOn
                         ? clamp(ev.velocity, 1, 127)
                         : 0x40;
          trackData.push(...vlq, status, note, vel);
          break;
    
        case 'control':
          // CC #64 sustain, #1 mod wheel, #7 volume, #11 expression
          trackData.push(
            ...vlq,
            0xB0|ch,
            clamp(ev.controller, 0, 127),
            clamp(ev.value, 0, 127)
          );
          break;
    
        case 'aftertouch':
          // poly aftertouch: status 0xA0, data1=note, data2=pressure
          trackData.push(
            ...vlq,
            0xA0|ch,
            clamp(ev.note, 0, 127),
            clamp(ev.pressure, 0, 127)
          );
          break;
    
        case 'channelPressure':
          // channel pressure: status 0xD0, data1=pressure
          trackData.push(
            ...vlq,
            0xD0|ch,
            clamp(ev.pressure, 0, 127)
          );
          break;
      }
    });
  
    // utility
    function clamp(v,min,max) { return v<min?min:v>max?max:v; }

    // end-of-track
    trackData.push(...encodeVariableLength(0), 0xFF, 0x2F, 0x00);
  
    const noteHeader   = [0x4D,0x54,0x72,0x6B]; // "MTrk"
    const noteLength   = encodeUint32(trackData.length);
  
    // 6) ASSEMBLE & RETURN
    const bytes = [
      ...header,
      ...metaHeader, ...metaLength, ...meta,
      ...noteHeader, ...noteLength, ...trackData
    ];
  
    // console.log(
    //   "Raw track bytes (first 10):",
    //   trackData.slice(0,10).map(b=>b.toString(16).padStart(2,'0'))
    // );
  
    return new Uint8Array(bytes);
  }
  
    function downloadMidi(data, filename) {
        try {
            const blob = new Blob([data], { type: 'audio/midi' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log(`Exported: ${filename} (${metronome.beatsPerMeasure}/${metronome.beatUnit}, ${metronome.bpm} BPM)`);
        } catch (error) {
            console.error('Download failed:', error);
            console.log('Failed to download MIDI file');
        }
    }

    //save settings
    function saveStudioSettings() {
        const settingsSnapshot = {
            bpm: metronome.bpm,
            volume: metronome.volume,
            beatsPerMeasure: metronome.beatsPerMeasure,
            beatUnit: metronome.beatUnit,
            shortcutsEnabled: settings.shortcutsEnabled,
            sectionsCollapsed: settings.sectionsCollapsed,
            theme: theme.current,
            backgroundImage: theme.backgroundImage || null
        };
        localStorage.setItem('pianoStudioSettings', JSON.stringify(settingsSnapshot));
        
        //console.log('Settings saved:', settingsSnapshot);

    }
    //load settings
    function loadStudioSettings() {
        const saved = localStorage.getItem('pianoStudioSettings');
        if (!saved) return;
    
        try {
            const parsed = JSON.parse(saved);
            metronome.bpm = parsed.bpm || 120;
            metronome.volume = parsed.volume ?? 0.7;
            metronome.beatsPerMeasure = parsed.beatsPerMeasure || 4;
            metronome.beatUnit = parsed.beatUnit || 4;
            settings.shortcutsEnabled = parsed.shortcutsEnabled ?? true;
            settings.sectionsCollapsed = parsed.sectionsCollapsed || { metronome: false, midi: false, theme: true };
            theme.current = parsed.theme || 'dark';
            theme.backgroundImage = parsed.backgroundImage || null;
            //console.log('settings loaded ', parsed);
        } catch (err) {
            console.warn('Failed to load saved settings:', err);
        }
    }

    async function initStudio() {
        //console.log('Initializing Piano Studio...');
        
        if (document.readyState === 'loading') {
            await new Promise(resolve => {
                addEventListenerTracked(document, 'DOMContentLoaded', resolve);
            });
        }
        
        // Wait for Chrome Music Lab to load
        await new Promise(resolve => setTimeoutTracked(resolve, 1500));
        loadStudioSettings(); //settings. 
        try {
            // Create UI first (audio context will be created on first user interaction)
            const container = createStudioUI();
            updateMetronomeButtonUI();
            setupDragAndDrop(container);
            setupCollapses();
            setupMetronomeControls();
            await setupMidiControls();
            setupThemeControls();
            setupKeyboardShortcuts();
            //console.log('Piano Studio ready!');
        
            //volume updates on loaded data. 
            const volumeSlider = document.getElementById('volume-slider');
            const volumeDisplay = document.getElementById('volume-display');

            if (volumeSlider) {
                volumeSlider.value = Math.round(metronome.volume * 100);
            }
            if (volumeDisplay) {
                volumeDisplay.textContent = `${Math.round(metronome.volume * 100)}%`;
            }

        } 
        catch (error) {
            console.error('Piano Studio initialization failed:', error);
            try {
                const container = createStudioUI();
                setupDragAndDrop(container);
                setupCollapses();
                console.log('Piano Studio loaded with limited functionality');
            } catch (fallbackError) {
                console.error('Complete initialization failure:', fallbackError);
            }
        }
    }

    waitForLoad();
})();