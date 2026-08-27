// ==UserScript==
// @name         CSTracker Chat Inspector
// @namespace    https://github.com/tomini
// @version      1.1.2
// @description  Tactical search, regex, copying, and exporting for CSTracker.gg chat logs.
// @author       Tomini
// @match        *://cstracker.gg/*
// @icon         https://cstracker.gg/favicon.svg
// @license      none
// @downloadURL  https://raw.githubusercontent.com/tomini/CSTracker-Chat-Inspector/main/CSTracker_Chat_Inspector.js
// @updateURL    https://raw.githubusercontent.com/tomini/CSTracker-Chat-Inspector/main/CSTracker_Chat_Inspector.js
// @supportURL   https://github.com/tomini/CSTracker-Chat-Inspector/issues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    const DEFAULT_SHOW_BUTTON = true; 
    let showScrollBtn = GM_getValue('csti_show_scroll_btn', DEFAULT_SHOW_BUTTON);
    const monoFont = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

    const defaultPresets = {
        "N-word": "\\b(nigg[ea]r?s?)\\b",
        "Slurs & Hate Speech": "\\b(nigg[ea]r?s?|fag(got)?s?|retard(ed)?|kys)\\b",
        "General Toxicity": "\\b(trash|dogshit|cunt|bitch|whore|stfu|idiot)\\b",
        "Hack Accusations": "\\b(aimbots?|wallhack(er|ing)?s*|wh|cheat(er|ing)?s*|hack(er|ing)?s*|toggled?)\\b",
        "Links/IPs": "(https?:\\/\\/\\S+|\\b([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}\\b|\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b)",
        "Excuses & Salt": "\\b(lag(ging)?|lucky?|subtick|rng|bs|bullshit|mad|cry(ing)?)\\b",
        "Classic BM": "\\b((ur|your) (mom|mum)|gg\\s*ez|ez\\s*gg|ez|who asked|tutorial|bot|uninstall)\\b",
        "Sportsmanship": "(?<!\\bez\\W*)\\b(gg(wp)?|gl(hf)?|gh|ns|nt|wp|mb)\\b(?!\\W*ez\\b)"
    };

    let customPresets = JSON.parse(localStorage.getItem('cstracker_custom_presets')) || {};
    let allPresets = { ...defaultPresets, ...customPresets };
    
    let exportConfig = JSON.parse(localStorage.getItem('csti_export_config')) || { 
        scope: 'messages', 
        groupByMatch: true,
        copyFormat: 'txt',
        date: true, 
        map: true, 
        round: true, 
        time: true 
    };
    
    if (exportConfig.copyFormat === 'png') exportConfig.copyFormat = 'txt';

    let matchedNodes = [];
    let currentMatchIdx = -1;
    let isFetching = false;

    GM_registerMenuCommand(`Toggle "Jump to Chat" Button`, () => {
        showScrollBtn = !showScrollBtn;
        GM_setValue('csti_show_scroll_btn', showScrollBtn);
        manageScrollButton(); 
    });

    function findChatHeader() {
        const section = document.getElementById('player-chat-section');
        return section ? section.querySelector('header') : null;
    }

    function manageScrollButton() {
        const btnId = 'csti-scroll-btn';
        let btn = document.getElementById(btnId);
        const isPlayerPage = window.location.href.includes('/players/');

        if (showScrollBtn && isPlayerPage) {
            if (!btn) {
                btn = document.createElement('button');
                btn.id = btnId;
                btn.textContent = 'JUMP TO CHAT';
                btn.style.cssText = `
                    position: fixed; top: 100px; right: 24px; z-index: 99999; 
                    background-color: rgba(56, 189, 248, 0.1); color: #e0f2fe; 
                    padding: 12px 24px; font-family: ${monoFont}; font-size: 12px; 
                    font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em;
                    border: 1px solid rgba(56, 189, 248, 0.5); cursor: pointer; 
                    transition: all 0.2s; backdrop-filter: blur(4px);
                `;
                btn.onmouseover = () => { btn.style.backgroundColor = 'rgba(56, 189, 248, 0.2)'; btn.style.borderColor = 'rgba(56, 189, 248, 0.8)'; };
                btn.onmouseout = () => { btn.style.backgroundColor = 'rgba(56, 189, 248, 0.1)'; btn.style.borderColor = 'rgba(56, 189, 248, 0.5)'; };
                
                btn.onclick = () => {
                    const header = findChatHeader();
                    if (header) {
                        const yOffset = header.getBoundingClientRect().top + window.scrollY - 100;
                        window.scrollTo({ top: yOffset, behavior: 'smooth' });
                    } else {
                        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                    }
                };
                
                document.body.appendChild(btn);
            }
        } else {
            if (btn) btn.remove();
        }
    }

    function showToast(msg) {
        let toast = document.getElementById('csti-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'csti-toast';
            toast.style.cssText = `
                position: fixed; bottom: 30px; right: 30px; z-index: 100000;
                background-color: rgba(15, 23, 42, 0.95); color: #e0f2fe; border: 1px solid rgba(56, 189, 248, 0.5);
                padding: 10px 18px; font-family: ${monoFont}; font-size: 10px; text-transform: uppercase; 
                letter-spacing: 0.12em; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); 
                transition: opacity 0.3s; pointer-events: none; backdrop-filter: blur(4px);
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    }

    function init() {
        setInterval(() => {
            manageScrollButton();
            if (!window.location.href.includes('/players/')) return;
            const chatSection = document.getElementById('player-chat-section');
            if (chatSection && !document.getElementById('csti-panel')) {
                buildUI(chatSection);
                injectQuickCopyButtons();
                performSearch('', false, false);
            }
        }, 1000);
    }

    function buildUI(chatSection) {
        const panel = document.createElement('div');
        panel.id = 'csti-panel';
        panel.style.cssText = 'background-color: rgba(15, 23, 42, 0.6); border: 1px solid rgba(30, 41, 59, 0.8); color: #f1f5f9; padding: 16px; margin-top: 24px; margin-bottom: 24px; font-size: 14px;';
        
        panel.innerHTML = `
            <div style="margin-bottom: 14px; display: flex; align-items: center; gap: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3em; color: #64748b; font-family: ${monoFont};">
                <span style="color: rgba(251, 191, 36, 0.8);">// chat · inspector</span>
                <div style="height: 1px; flex: 1; background: linear-gradient(to right, #1e293b, #334155, transparent);"></div>
            </div>

            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <input type="text" id="csti-search-input" placeholder="Search chat..." style="flex: 1; min-width: 150px; background-color: rgba(2, 6, 23, 0.5); border: 1px solid rgba(30, 41, 59, 0.8); color: #f8fafc; padding: 6px 12px; outline: none; border-radius: 0;">
                
                <select id="csti-presets" style="background-color: rgba(2, 6, 23, 0.5); border: 1px solid rgba(30, 41, 59, 0.8); color: #f8fafc; padding: 6px 10px; outline: none; max-width: 180px; border-radius: 0;">
                    <option value="" style="background-color: #0f172a; color: #f8fafc;">-- Load Preset --</option>
                </select>

                <div style="display: flex; align-items: center; gap: 4px;">
                    <div id="csti-stats" style="font-family: ${monoFont}; color: #fbbf24; font-size: 12px; white-space: nowrap; padding: 0 4px;"></div>
                    <div id="csti-nav-btns" style="display: none; gap: 2px;">
                        <button id="csti-btn-prev" title="Previous Match" style="background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(56, 189, 248, 0.4); color: #38bdf8; padding: 3px 6px; cursor: pointer; font-size: 10px; line-height: 1; transition: 0.2s;">▲</button>
                        <button id="csti-btn-next" title="Next Match" style="background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(56, 189, 248, 0.4); color: #38bdf8; padding: 3px 6px; cursor: pointer; font-size: 10px; line-height: 1; transition: 0.2s;">▼</button>
                    </div>
                </div>
                
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-left: auto; font-family: ${monoFont}; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: #94a3b8;">
                    <input type="checkbox" id="csti-use-regex" style="accent-color: #38bdf8;"> Regex
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-family: ${monoFont}; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: #94a3b8;">
                    <input type="checkbox" id="csti-filter-only" style="accent-color: #38bdf8;"> Filter Matches
                </label>

                <button id="csti-btn-save" style="background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.5); color: #e0f2fe; padding: 6px 14px; font-family: ${monoFont}; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; cursor: pointer; transition: 0.2s;">Save</button>
                <button id="csti-btn-clear" style="background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(30, 41, 59, 0.8); color: #cbd5e1; padding: 6px 14px; font-family: ${monoFont}; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; cursor: pointer; transition: 0.2s;">Clear</button>
                <button id="csti-btn-fetchall" style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.5); color: #a7f3d0; padding: 6px 14px; font-family: ${monoFont}; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; cursor: pointer; transition: 0.2s;">Fetch All Pages</button>
                
                <div style="position: relative;">
                    <button id="csti-btn-export-toggle" style="background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(30, 41, 59, 0.8); color: #cbd5e1; padding: 6px 14px; font-family: ${monoFont}; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; cursor: pointer; transition: 0.2s; display: flex; align-items: center; gap: 6px;">
                        Export ⏷
                    </button>
                    
                    <div id="csti-export-menu" style="display: none; position: absolute; right: 0; margin-top: 8px; width: 300px; background-color: #0f172a; border: 1px solid rgba(56, 189, 248, 0.4); box-shadow: 0 20px 25px -5px rgba(0,0,0,0.7); z-index: 1000; padding: 14px; font-size: 13px;">
                        
                        <div style="font-family: ${monoFont}; font-size: 9px; text-transform: uppercase; letter-spacing: 0.22em; color: #64748b; margin-bottom: 6px;">Search Scope</div>
                        <select id="csti-exp-scope" style="width: 100%; background-color: rgba(2, 6, 23, 0.5); border: 1px solid rgba(30, 41, 59, 0.8); color: #f8fafc; padding: 6px; border-radius: 0; margin-bottom: 12px; outline: none;">
                            <option value="all" ${exportConfig.scope === 'all' ? 'selected' : ''} style="background-color: #0f172a;">All Messages</option>
                            <option value="sessions" ${exportConfig.scope === 'sessions' ? 'selected' : ''} style="background-color: #0f172a;">Matched Sessions</option>
                            <option value="messages" ${exportConfig.scope === 'messages' ? 'selected' : ''} style="background-color: #0f172a;">Matched Messages Only</option>
                        </select>

                        <div style="font-family: ${monoFont}; font-size: 9px; text-transform: uppercase; letter-spacing: 0.22em; color: #64748b; margin-bottom: 6px;">Formatting</div>
                        <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;">
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #cbd5e1;"><input type="checkbox" id="csti-exp-group" style="accent-color: #38bdf8;" ${exportConfig.groupByMatch ? 'checked' : ''}> Separate table/block per game</label>
                        </div>

                        <div style="font-family: ${monoFont}; font-size: 9px; text-transform: uppercase; letter-spacing: 0.22em; color: #64748b; margin-bottom: 6px;">Include Metadata</div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 16px; color: #cbd5e1;">
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="checkbox" id="csti-exp-date" style="accent-color: #38bdf8;" ${exportConfig.date ? 'checked' : ''}> Date</label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="checkbox" id="csti-exp-map" style="accent-color: #38bdf8;" ${exportConfig.map ? 'checked' : ''}> Map</label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="checkbox" id="csti-exp-round" style="accent-color: #38bdf8;" ${exportConfig.round ? 'checked' : ''}> Round</label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="checkbox" id="csti-exp-time" style="accent-color: #38bdf8;" ${exportConfig.time ? 'checked' : ''}> Time</label>
                        </div>

                        <div style="font-family: ${monoFont}; font-size: 9px; text-transform: uppercase; letter-spacing: 0.22em; color: #64748b; margin-bottom: 6px;">1-Click Copy Mode</div>
                        <select id="csti-exp-copy-fmt" style="width: 100%; background-color: rgba(2, 6, 23, 0.5); border: 1px solid rgba(30, 41, 59, 0.8); color: #f8fafc; padding: 6px; border-radius: 0; margin-bottom: 16px; outline: none;">
                            <option value="txt" ${exportConfig.copyFormat === 'txt' ? 'selected' : ''} style="background-color: #0f172a;">Copy as Plain Text</option>
                            <option value="md" ${exportConfig.copyFormat === 'md' ? 'selected' : ''} style="background-color: #0f172a;">Copy as Markdown</option>
                        </select>

                        <div style="font-family: ${monoFont}; font-size: 9px; text-transform: uppercase; letter-spacing: 0.22em; color: #64748b; margin-bottom: 6px;">Download Full Export</div>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                            <button class="csti-export-action" style="background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.5); color: #e0f2fe; font-family: ${monoFont}; font-size: 10px; font-weight: 600; padding: 6px 0; cursor: pointer; transition: 0.2s;" data-format="txt">TXT</button>
                            <button class="csti-export-action" style="background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.5); color: #e0f2fe; font-family: ${monoFont}; font-size: 10px; font-weight: 600; padding: 6px 0; cursor: pointer; transition: 0.2s;" data-format="md">MD</button>
                            <button class="csti-export-action" style="background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.5); color: #e0f2fe; font-family: ${monoFont}; font-size: 10px; font-weight: 600; padding: 6px 0; cursor: pointer; transition: 0.2s;" data-format="csv">CSV</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // v1.1.2 Fix: Insert the panel BEFORE the HTMX swapping zone so it survives pagination clicks
        chatSection.insertAdjacentElement('beforebegin', panel);
        updatePresetDropdown();
        attachEventListeners();
    }

    function updatePresetDropdown() {
        const select = document.getElementById('csti-presets');
        select.innerHTML = '<option value="" style="background-color: #0f172a; color: #f8fafc;">-- Load Preset --</option>';
        for (const [name, query] of Object.entries(allPresets)) {
            const option = document.createElement('option');
            option.value = query;
            option.textContent = name;
            option.style.backgroundColor = '#0f172a';
            option.style.color = '#f8fafc';
            select.appendChild(option);
        }
    }

    function injectQuickCopyButtons() {
        const chatContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        if (!chatContainer) return;

        chatContainer.querySelectorAll('section').forEach(section => {
            const headerDiv = section.querySelector('.border-b');
            if (headerDiv && !headerDiv.querySelector('.csti-session-copy-btn')) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'csti-session-copy-btn';
                copyBtn.textContent = 'COPY MATCH';
                copyBtn.style.cssText = `
                    margin-left: 12px; background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(30, 41, 59, 0.8); 
                    color: #94a3b8; font-family: ${monoFont}; font-size: 9px; font-weight: 600; 
                    text-transform: uppercase; letter-spacing: 0.12em; padding: 3px 8px; cursor: pointer; transition: all 0.2s;
                `;
                copyBtn.onmouseover = () => { copyBtn.style.color = '#e0f2fe'; copyBtn.style.borderColor = 'rgba(56, 189, 248, 0.5)'; copyBtn.style.background = 'rgba(56, 189, 248, 0.1)'; };
                copyBtn.onmouseout = () => { copyBtn.style.color = '#94a3b8'; copyBtn.style.borderColor = 'rgba(30, 41, 59, 0.8)'; copyBtn.style.background = 'rgba(15, 23, 42, 0.8)'; };
                copyBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    copySessionData(section);
                };
                headerDiv.appendChild(copyBtn);
            }

            section.querySelectorAll('a.grid').forEach(msg => {
                if (!msg.querySelector('.csti-msg-copy-btn')) {
                    msg.style.position = 'relative';

                    const rowCopy = document.createElement('button');
                    rowCopy.className = 'csti-msg-copy-btn';
                    rowCopy.title = 'Copy message';
                    rowCopy.textContent = 'COPY';
                    
                    rowCopy.style.cssText = `
                        position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
                        background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(56, 189, 248, 0.4); 
                        color: #e0f2fe; font-family: ${monoFont}; font-size: 9px; font-weight: 600; 
                        text-transform: uppercase; letter-spacing: 0.12em; cursor: pointer; padding: 4px 10px; 
                        opacity: 0; transition: opacity 0.2s, background 0.2s; z-index: 10;
                    `;
                    
                    rowCopy.onmouseover = () => { rowCopy.style.background = 'rgba(56, 189, 248, 0.2)'; };
                    rowCopy.onmouseout = () => { rowCopy.style.background = 'rgba(15, 23, 42, 0.95)'; };
                    rowCopy.onclick = (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        copySingleMessage(section, msg);
                    };

                    msg.onmouseover = () => { rowCopy.style.opacity = '1'; };
                    msg.onmouseout = () => { rowCopy.style.opacity = '0'; };

                    msg.appendChild(rowCopy);
                }
            });
        });
    }

    async function fetchAllPages() {
        if (isFetching) return;
        const fetchBtn = document.getElementById('csti-btn-fetchall');
        const targetContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        
        if (!targetContainer || !fetchBtn) return;

        isFetching = true;
        fetchBtn.style.opacity = '0.5';
        fetchBtn.style.cursor = 'not-allowed';

        let currentDoc = document;
        let pageCount = 1;

        while (true) {
            // Find the HTMX button on the document we are currently parsing
            const nextBtn = currentDoc.querySelector('button[hx-get*="sections/chat?page="]');
            if (!nextBtn) break;

            const nextUrl = nextBtn.getAttribute('hx-get');
            pageCount++;
            fetchBtn.textContent = `FETCHING P${pageCount}...`;

            try {
                // Politeness delay to avoid hitting rate limits
                await new Promise(r => setTimeout(r, 250));
                
                const response = await fetch(nextUrl);
                const html = await response.text();
                
                const parser = new DOMParser();
                currentDoc = parser.parseFromString(html, 'text/html');

                const newContainer = currentDoc.querySelector('.overflow-y-auto');
                if (newContainer) {
                    // Extract all new match sections and seamlessly inject them into our live view
                    const sections = newContainer.querySelectorAll('section');
                    sections.forEach(sec => targetContainer.appendChild(sec));
                }
            } catch (err) {
                console.error("CSTI: Failed to fetch pagination.", err);
                break;
            }
        }

        // Clean up: Remove the original pagination nav block so the user can't click it anymore
        const liveNav = document.querySelector('#player-chat-section nav');
        if (liveNav) liveNav.remove();

        fetchBtn.textContent = 'ALL PAGES LOADED';
        fetchBtn.style.opacity = '1';
        fetchBtn.style.background = 'rgba(16, 185, 129, 0.2)'; // Emerald solid
        
        // Re-inject copy buttons for all newly downloaded messages
        injectQuickCopyButtons();
        
        // Re-run the active search query on the newly populated DOM
        const input = document.getElementById('csti-search-input');
        const regexCheck = document.getElementById('csti-use-regex');
        const filterCheck = document.getElementById('csti-filter-only');
        performSearch(input.value, regexCheck.checked, filterCheck.checked);
        
        isFetching = false;
    }

    function attachEventListeners() {
        const input = document.getElementById('csti-search-input');
        const regexCheck = document.getElementById('csti-use-regex');
        const filterCheck = document.getElementById('csti-filter-only');
        const presets = document.getElementById('csti-presets');
        const fetchBtn = document.getElementById('csti-btn-fetchall');
        
        const triggerSearch = () => performSearch(input.value, regexCheck.checked, filterCheck.checked);

        input.addEventListener('input', triggerSearch);
        regexCheck.addEventListener('change', triggerSearch);
        filterCheck.addEventListener('change', triggerSearch);

        presets.addEventListener('change', (e) => {
            if (e.target.value) {
                input.value = e.target.value;
                regexCheck.checked = true;
                triggerSearch();
            }
        });

        if (fetchBtn) {
            fetchBtn.addEventListener('click', fetchAllPages);
            fetchBtn.onmouseover = () => { if(!isFetching) fetchBtn.style.background = 'rgba(16, 185, 129, 0.2)'; };
            fetchBtn.onmouseout = () => { if(!isFetching) fetchBtn.style.background = 'rgba(16, 185, 129, 0.1)'; };
        }

        const btnPrev = document.getElementById('csti-btn-prev');
        const btnNext = document.getElementById('csti-btn-next');
        
        const styleNavHover = (btn) => {
            btn.onmouseover = () => { btn.style.background = 'rgba(56, 189, 248, 0.2)'; };
            btn.onmouseout = () => { btn.style.background = 'rgba(15, 23, 42, 0.8)'; };
        };
        styleNavHover(btnPrev);
        styleNavHover(btnNext);

        btnPrev.addEventListener('click', () => navigateMatches(-1));
        btnNext.addEventListener('click', () => navigateMatches(1));

        document.getElementById('csti-btn-save').addEventListener('click', () => {
            if (!input.value) return alert('Enter a search term first.');
            const name = prompt('Enter a name for this preset:');
            if (name) {
                customPresets[name] = input.value;
                allPresets = { ...defaultPresets, ...customPresets };
                localStorage.setItem('cstracker_custom_presets', JSON.stringify(customPresets));
                updatePresetDropdown();
                presets.value = input.value;
            }
        });

        document.getElementById('csti-btn-clear').addEventListener('click', () => {
            input.value = '';
            presets.value = '';
            triggerSearch();
        });

        const exportMenu = document.getElementById('csti-export-menu');
        const exportToggle = document.getElementById('csti-btn-export-toggle');
        
        exportToggle.onmouseover = () => { exportToggle.style.color = '#e0f2fe'; exportToggle.style.borderColor = 'rgba(56, 189, 248, 0.5)'; };
        exportToggle.onmouseout = () => { exportToggle.style.color = '#cbd5e1'; exportToggle.style.borderColor = 'rgba(30, 41, 59, 0.8)'; };

        exportToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            exportMenu.style.display = exportMenu.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', (e) => {
            if (!exportMenu.contains(e.target) && e.target !== exportToggle) {
                exportMenu.style.display = 'none';
            }
        });

        document.querySelectorAll('.csti-export-action').forEach(btn => {
            btn.onmouseover = () => { btn.style.backgroundColor = 'rgba(56, 189, 248, 0.2)'; };
            btn.onmouseout = () => { btn.style.backgroundColor = 'rgba(56, 189, 248, 0.1)'; };
        });

        const saveExportConfig = () => {
            exportConfig = {
                scope: document.getElementById('csti-exp-scope').value,
                groupByMatch: document.getElementById('csti-exp-group').checked,
                copyFormat: document.getElementById('csti-exp-copy-fmt').value,
                date: document.getElementById('csti-exp-date').checked,
                map: document.getElementById('csti-exp-map').checked,
                round: document.getElementById('csti-exp-round').checked,
                time: document.getElementById('csti-exp-time').checked
            };
            localStorage.setItem('csti_export_config', JSON.stringify(exportConfig));
        };

        ['scope', 'copy-fmt'].forEach(id => document.getElementById(`csti-exp-${id}`).addEventListener('change', saveExportConfig));
        ['group', 'date', 'map', 'round', 'time'].forEach(id => document.getElementById(`csti-exp-${id}`).addEventListener('change', saveExportConfig));

        document.querySelectorAll('.csti-export-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                generateExport(e.target.getAttribute('data-format'));
                exportMenu.style.display = 'none';
            });
        });
    }

    function navigateMatches(direction) {
        if (matchedNodes.length === 0) return;
        
        currentMatchIdx += direction;
        if (currentMatchIdx < 0) currentMatchIdx = matchedNodes.length - 1;
        if (currentMatchIdx >= matchedNodes.length) currentMatchIdx = 0;

        const targetElement = matchedNodes[currentMatchIdx];
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

        const originalBg = targetElement.style.backgroundColor;
        targetElement.style.transition = 'background-color 0.3s';
        targetElement.style.backgroundColor = 'rgba(56, 189, 248, 0.25)'; 
        
        setTimeout(() => {
            targetElement.style.backgroundColor = originalBg;
            setTimeout(() => { targetElement.style.transition = ''; }, 300);
        }, 800);
    }

    function performSearch(query, useRegex, filterOnly) {
        const chatContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        const statsDiv = document.getElementById('csti-stats');
        const navBtns = document.getElementById('csti-nav-btns');
        
        if (!chatContainer) return;

        const sections = chatContainer.querySelectorAll('section');
        let searchRegex;
        let totalMsgs = 0;
        
        matchedNodes = [];
        currentMatchIdx = -1;

        try {
            searchRegex = useRegex && query ? new RegExp(query, 'gi') : null;
        } catch (e) {
            if (statsDiv) statsDiv.textContent = 'Invalid Regex';
            if (navBtns) navBtns.style.display = 'none';
            return;
        }

        sections.forEach(section => {
            const messages = section.querySelectorAll('a.grid');
            let sectionHasMatch = false;

            messages.forEach(msg => {
                const textDiv = msg.querySelector('.whitespace-pre-wrap');
                if (!textDiv) return;

                totalMsgs++;

                if (textDiv.dataset.originalText) {
                    textDiv.innerHTML = textDiv.dataset.originalText;
                } else {
                    textDiv.dataset.originalText = textDiv.innerHTML;
                }
                msg.style.display = '';

                let isMatch = true; 
                
                if (query) {
                    const text = textDiv.dataset.originalText;
                    if (useRegex && searchRegex) {
                        isMatch = searchRegex.test(text);
                        if (isMatch) {
                            textDiv.innerHTML = text.replace(searchRegex, match => `<mark style="background-color: rgba(251, 191, 36, 0.8); color: #0f172a; padding: 0 4px;">${match}</mark>`);
                        }
                    } else {
                        isMatch = text.toLowerCase().includes(query.toLowerCase());
                        if (isMatch) {
                            const regexStr = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const highlightRegex = new RegExp(`(${regexStr})`, 'gi');
                            textDiv.innerHTML = text.replace(highlightRegex, match => `<mark style="background-color: rgba(251, 191, 36, 0.8); color: #0f172a; padding: 0 4px;">${match}</mark>`);
                        }
                    }
                }

                msg.dataset.cstiMatch = isMatch ? 'true' : 'false';

                if (isMatch) {
                    sectionHasMatch = true;
                    if (query) matchedNodes.push(msg);
                }

                if (filterOnly && query && !isMatch) {
                    msg.style.display = 'none';
                }
            });

            section.dataset.cstiMatch = sectionHasMatch ? 'true' : 'false';

            if (filterOnly && query) {
                section.style.display = sectionHasMatch ? '' : 'none';
            } else {
                section.style.display = '';
            }
        });

        if (statsDiv) {
            if (!query) {
                statsDiv.innerHTML = '';
                if (navBtns) navBtns.style.display = 'none';
            } else {
                const matchedCount = matchedNodes.length;
                const percent = totalMsgs > 0 ? ((matchedCount / totalMsgs) * 100).toFixed(1) : 0;
                statsDiv.innerHTML = `<span style="color: #f8fafc;">${matchedCount}</span> / ${totalMsgs} <span style="color: #64748b; font-weight: normal;">(${percent}%)</span>`;
                
                if (navBtns) navBtns.style.display = matchedCount > 0 ? 'flex' : 'none';
            }
        }
    }

    function extractSectionData(section, onlyVisible = true) {
        let mapName = "Unknown";
        let dateStr = "Unknown Date";

        const mapEl = section.querySelector('.font-medium.text-cyan-200');
        if (mapEl) mapName = mapEl.textContent.trim();
        
        const dateEl = section.querySelector('[data-time-ago]');
        if (dateEl) {
            const title = dateEl.getAttribute('title');
            if (title) dateStr = title.replace('played ', '').trim();
        }

        let messages = [];
        section.querySelectorAll('a.grid').forEach(msg => {
            if (onlyVisible && msg.style.display === 'none') return;

            const textDiv = msg.querySelector('.whitespace-pre-wrap');
            const rawText = textDiv ? (textDiv.dataset.originalText || textDiv.textContent).trim() : "";
            
            let roundStr = "-";
            let timeStr = "-";
            
            const metaDiv = msg.querySelector('.text-xs.text-slate-500');
            if (metaDiv) {
                const parts = metaDiv.textContent.split('·');
                if (parts.length > 0) roundStr = parts[0].trim();
                if (parts.length > 1) timeStr = parts[1].trim();
            }

            messages.push({ round: roundStr, time: timeStr, text: rawText });
        });

        return { map: mapName, date: dateStr, messages };
    }

    async function copySessionData(section) {
        const data = extractSectionData(section, true);
        if (data.messages.length === 0) return showToast('No visible messages to copy!');

        let textToCopy = '';
        if (exportConfig.copyFormat === 'md') {
            textToCopy += `### ${data.map} (${data.date})\n\n| Round | Time | Message |\n|---|---|---|\n`;
            data.messages.forEach(m => {
                textToCopy += `| ${m.round} | ${m.time} | ${m.text.replace(/\|/g, '&#124;').replace(/\n/g, ' ')} |\n`;
            });
        } else {
            textToCopy += `=== [${data.map}] - ${data.date} ===\n`;
            data.messages.forEach(m => {
                let meta = [];
                if (exportConfig.round) meta.push(m.round);
                if (exportConfig.time) meta.push(`(${m.time})`);
                textToCopy += `${meta.length ? meta.join(' ') + ': ' : ''}${m.text}\n`;
            });
        }

        await navigator.clipboard.writeText(textToCopy);
        showToast('✓ Match copied to clipboard');
    }

    async function copySingleMessage(section, msg) {
        const sData = extractSectionData(section, false);
        const textDiv = msg.querySelector('.whitespace-pre-wrap');
        const rawText = textDiv ? (textDiv.dataset.originalText || textDiv.textContent).trim() : "";
        
        let roundStr = "-", timeStr = "-";
        const metaDiv = msg.querySelector('.text-xs.text-slate-500');
        if (metaDiv) {
            const parts = metaDiv.textContent.split('·');
            if (parts.length > 0) roundStr = parts[0].trim();
            if (parts.length > 1) timeStr = parts[1].trim();
        }

        let line = '';
        if (exportConfig.copyFormat === 'md') {
            line = `[${sData.date}] **${sData.map}** ${roundStr} (${timeStr}): \`${rawText}\``;
        } else {
            let meta = [];
            if (exportConfig.date) meta.push(`[${sData.date}]`);
            if (exportConfig.map) meta.push(sData.map);
            if (exportConfig.round) meta.push(roundStr);
            if (exportConfig.time) meta.push(`(${timeStr})`);
            line = `${meta.join(' ')}: ${rawText}`;
        }

        await navigator.clipboard.writeText(line);
        showToast('✓ Message copied');
    }

    function generateExport(format) {
        const chatContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        if (!chatContainer) return alert('No chat data found.');

        let sessions = [];
        chatContainer.querySelectorAll('section').forEach(section => {
            if (exportConfig.scope === 'sessions' && section.dataset.cstiMatch !== 'true') return;

            const sData = extractSectionData(section, false);
            const filteredMsgs = sData.messages.filter((m, idx) => {
                const msgEl = section.querySelectorAll('a.grid')[idx]; 
                return exportConfig.scope !== 'messages' || (msgEl && msgEl.dataset.cstiMatch === 'true');
            });

            if (filteredMsgs.length > 0) {
                sessions.push({ ...sData, messages: filteredMsgs });
            }
        });

        if (sessions.length === 0) return alert('No messages matched your export criteria.');

        let output = '';
        const pid = window.location.pathname.split('/').pop();
        const filename = `cstracker_${pid}_chat_${new Date().toISOString().split('T')[0]}.${format}`;

        if (format === 'csv') {
            if (exportConfig.groupByMatch) {
                output += `"Match Date","Map","Round","Time","Message"\n`;
                sessions.forEach(s => {
                    output += `\n"--- ${s.date} ---","--- ${s.map} ---","","",""\n`;
                    s.messages.forEach(m => {
                        output += `"${s.date}","${s.map}","${m.round}","${m.time}","${m.text.replace(/"/g, '""')}"\n`;
                    });
                });
            } else {
                output += `"Date","Map","Round","Time","Message"\n`;
                sessions.forEach(s => {
                    s.messages.forEach(m => {
                        output += `"${s.date}","${s.map}","${m.round}","${m.time}","${m.text.replace(/"/g, '""')}"\n`;
                    });
                });
            }
        } 
        else if (format === 'md') {
            if (exportConfig.groupByMatch) {
                sessions.forEach(s => {
                    output += `### ${s.map} — *${s.date}*\n\n`;
                    output += `| Round | Time | Message |\n|---|---|---|\n`;
                    s.messages.forEach(m => {
                        output += `| ${m.round} | ${m.time} | ${m.text.replace(/\|/g, '&#124;').replace(/\n/g, '<br>')} |\n`;
                    });
                    output += `\n---\n\n`;
                });
            } else {
                output += `| Date | Map | Round | Time | Message |\n|---|---|---|---|---|\n`;
                sessions.forEach(s => {
                    s.messages.forEach(m => {
                        output += `| ${s.date} | ${s.map} | ${m.round} | ${m.time} | ${m.text.replace(/\|/g, '&#124;').replace(/\n/g, '<br>')} |\n`;
                    });
                });
            }
        }
        else if (format === 'txt') {
            sessions.forEach(s => {
                if (exportConfig.groupByMatch) {
                    output += `\n==============================\n${s.map} · ${s.date}\n==============================\n`;
                }
                s.messages.forEach(m => {
                    let meta = [];
                    if (!exportConfig.groupByMatch) {
                        if (exportConfig.date) meta.push(`[${s.date}]`);
                        if (exportConfig.map) meta.push(s.map);
                    }
                    if (exportConfig.round) meta.push(m.round);
                    if (exportConfig.time) meta.push(`(${m.time})`);
                    output += `${meta.length ? meta.join(' ') + ': ' : ''}${m.text}\n`;
                });
            });
        }

        const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    init();
})();