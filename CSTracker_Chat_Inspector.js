// ==UserScript==
// @name         CSTracker Chat Inspector
// @namespace    https://github.com/tomini
// @version      1.2.0
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

    let presetOrder = JSON.parse(localStorage.getItem('csti_preset_order')) || [];
    let hiddenPresets = new Set(JSON.parse(localStorage.getItem('csti_preset_hidden')) || []);
    let breakdownMode = localStorage.getItem('csti_breakdown_mode') || 'bar';
    let breakdownBarMetric = localStorage.getItem('csti_breakdown_bar_metric') || 'messages';
    let timelineChartType = localStorage.getItem('csti_timeline_chart_type') || 'stacked';
    let timelineShowUnmatchedLine = localStorage.getItem('csti_timeline_show_unmatched_line') === 'true';
    let timelineGroupBy = localStorage.getItem('csti_timeline_group_by') || 'month'; // 'month' | 'map' (map only applies to Stacked)
    let priorityEditorOpen = false;
    let timelineHitRegions = [];
    // Open by default for anyone who's never explicitly toggled it (fresh
    // install, or an existing install updating before this preference existed).
    const CSTI_SIDE_PANEL_STORED_OPEN = localStorage.getItem('csti_side_panel_open');
    let sidePanelOpen = CSTI_SIDE_PANEL_STORED_OPEN === null ? true : CSTI_SIDE_PANEL_STORED_OPEN === 'true';
    const CSTI_SIDE_PANEL_MAX_W = 640;
    const CSTI_SIDE_PANEL_MIN_W = 300;

    // Measures real gutter next to the chat log (no guessing container width),
    // minus the tab's own width. Floors at MIN_W, which may slightly overlap
    // content on very narrow windows.
    function computeSidePanelWidth() {
        const chatSection = document.getElementById('player-chat-section');
        if (!chatSection) return CSTI_SIDE_PANEL_MAX_W;
        const tabs = document.getElementById('csti-side-tabs');
        const jumpTab = document.getElementById('csti-jump-tab');
        const tabsW = tabs ? tabs.getBoundingClientRect().width : 36;
        const jumpW = (jumpTab && jumpTab.style.display !== 'none') ? jumpTab.getBoundingClientRect().width : 0;
        const reserve = Math.max(tabsW, jumpW);
        const gutter = window.innerWidth - chatSection.getBoundingClientRect().right - reserve - 20;
        return Math.max(CSTI_SIDE_PANEL_MIN_W, Math.min(CSTI_SIDE_PANEL_MAX_W, gutter));
    }
    const CSTI_TIMELINE_H_STACKED = 420;
    const CSTI_TIMELINE_H_LINE = 280;

    function syncPresetOrder() {
        const names = Object.keys(allPresets);
        presetOrder = presetOrder.filter(n => names.includes(n));
        names.forEach(n => { if (!presetOrder.includes(n)) presetOrder.push(n); });
        localStorage.setItem('csti_preset_order', JSON.stringify(presetOrder));

        let hiddenChanged = false;
        hiddenPresets.forEach(n => { if (!names.includes(n)) { hiddenPresets.delete(n); hiddenChanged = true; } });
        if (hiddenChanged) localStorage.setItem('csti_preset_hidden', JSON.stringify([...hiddenPresets]));
    }
    syncPresetOrder();
    
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
        const jumpTab = document.getElementById('csti-jump-tab');
        if (jumpTab) jumpTab.style.display = showScrollBtn ? 'flex' : 'none';
    });

    function jumpToChat() {
        const panel = document.getElementById('csti-panel');
        const target = panel || document.getElementById('player-chat-section');
        if (target) {
            const yOffset = target.getBoundingClientRect().top + window.scrollY - 12;
            window.scrollTo({ top: yOffset, behavior: 'smooth' });
        } else {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
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
            if (!window.location.href.includes('/players/')) return;
            const chatSection = document.getElementById('player-chat-section');
            if (chatSection && !document.getElementById('csti-panel')) {
                buildUI(chatSection);
                buildSidePanel();
                injectQuickCopyButtons();
                performSearch('', false, false);
            }
        }, 1000);

        attachWordFreqListener();
    }

    // CSTracker's own word-frequency cloud (aside next to chat log). Delegated once on
    // document so it keeps working across the site's own re-renders (pagination, nav).
    function attachWordFreqListener() {
        if (!document.getElementById('csti-wordfreq-style')) {
            const style = document.createElement('style');
            style.id = 'csti-wordfreq-style';
            style.textContent = `aside[aria-label="Player chat word frequency map"] [role="listitem"] { cursor: pointer; }`;
            document.head.appendChild(style);
        }

        document.addEventListener('click', (e) => {
            const wordEl = e.target.closest('aside[aria-label="Player chat word frequency map"] [role="listitem"]');
            if (!wordEl) return;

            const input = document.getElementById('csti-search-input');
            const regexCheck = document.getElementById('csti-use-regex');
            const filterCheck = document.getElementById('csti-filter-only');
            const presets = document.getElementById('csti-presets');
            if (!input || !regexCheck || !filterCheck) return;

            const word = wordEl.textContent.trim();
            if (!word) return;

            input.value = `\\b${escapeRegex(word)}\\b`;
            regexCheck.checked = true;
            if (presets) presets.value = '';

            performSearch(input.value, regexCheck.checked, filterCheck.checked);
            navigateMatches(1);
        });
    }

    function buildUI(chatSection) {
        const panel = document.createElement('div');
        panel.id = 'csti-panel';
        panel.style.cssText = 'background-color: rgba(15, 23, 42, 0.6); border: 1px solid rgba(30, 41, 59, 0.8); color: #f1f5f9; padding: 16px; margin-top: 24px; margin-bottom: 24px; font-size: 14px;';
        
        const hasPagination = chatSection.querySelector('button[hx-get*="sections/chat?page="]');
        const fetchAllBtnHTML = hasPagination ? `<button id="csti-btn-fetchall" style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.5); color: #a7f3d0; padding: 6px 14px; font-family: ${monoFont}; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; cursor: pointer; transition: 0.2s;">Fetch All Pages</button>` : '';

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
                ${fetchAllBtnHTML}

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
        
        chatSection.insertAdjacentElement('beforebegin', panel);
        updatePresetDropdown();
        attachEventListeners();
    }

    // Fixed HUD sidebar, toggled by a pull-tab; open/closed state persists via localStorage.
    function buildSidePanel() {
        if (document.getElementById('csti-side-panel')) return;

        if (!document.getElementById('csti-side-panel-style')) {
            const style = document.createElement('style');
            style.id = 'csti-side-panel-style';
            style.textContent = `
                @keyframes csti-tab-pulse { 0%, 100% { box-shadow: 0 0 0 rgba(56,189,248,0.35); } 50% { box-shadow: 0 0 10px rgba(56,189,248,0.55); } }
                #csti-side-tab:not(.csti-tab-open) { animation: csti-tab-pulse 3.2s ease-in-out infinite; }
                #csti-side-tab.csti-tab-open { box-shadow: none; }
                .csti-edge-tab {
                    background: rgba(2, 6, 23, 0.95); border: 1px solid rgba(56, 189, 248, 0.5); border-left: none;
                    color: #38bdf8; font-family: ${monoFont}; font-size: 9px; font-weight: 700;
                    text-transform: uppercase; letter-spacing: 0.13em; cursor: pointer; padding: 10px 2px;
                    writing-mode: vertical-rl; transform: rotate(180deg);
                    display: flex; flex-direction: column; align-items: center;
                }
                #csti-side-tab { gap: 10px; }
                .csti-tab-arrow { font-size: 12px; line-height: 1; }
                #csti-jump-tab {
                    writing-mode: horizontal-tb; transform: none; padding: 8px 10px;
                    border-left: 1px solid rgba(56, 189, 248, 0.5); border-right: none; gap: 6px;
                }
                #csti-side-panel::-webkit-scrollbar { width: 6px; }
                #csti-side-panel::-webkit-scrollbar-thumb { background: rgba(56,189,248,0.3); }
            `;
            document.head.appendChild(style);
        }

        const jumpTab = document.createElement('div');
        jumpTab.id = 'csti-jump-tab';
        jumpTab.className = 'csti-edge-tab';
        jumpTab.title = 'Jump to chat log';
        jumpTab.style.cssText = `position: fixed; top: 100px; right: 0; z-index: 99998; transition: right 0.28s ease;`;
        jumpTab.style.display = showScrollBtn ? 'flex' : 'none';
        jumpTab.innerHTML = `<span>JUMP</span><span class="csti-tab-arrow">▼</span>`;
        jumpTab.addEventListener('click', jumpToChat);
        jumpTab.onmouseover = () => { jumpTab.style.color = '#7dd3fc'; jumpTab.style.borderColor = 'rgba(125, 211, 252, 0.8)'; };
        jumpTab.onmouseout = () => { jumpTab.style.color = '#38bdf8'; jumpTab.style.borderColor = 'rgba(56, 189, 248, 0.5)'; };

        const tabs = document.createElement('div');
        tabs.id = 'csti-side-tabs';
        tabs.style.cssText = `
            position: fixed; top: 50%; right: 0; transform: translateY(-50%);
            z-index: 99998; display: flex; flex-direction: column; gap: 8px;
            transition: right 0.28s ease;
        `;

        const tab = document.createElement('div');
        tab.id = 'csti-side-tab';
        tab.className = 'csti-edge-tab';
        tab.title = 'Toggle preset breakdown';
        tab.innerHTML = `<span class="csti-tab-arrow">▶</span><span>BREAKDOWN</span>`;

        tabs.appendChild(tab);

        const panel = document.createElement('div');
        panel.id = 'csti-side-panel';
        panel.style.cssText = `
            position: fixed; top: 0; right: 0; height: 100vh; width: 0; overflow-x: hidden; overflow-y: auto;
            z-index: 99997; transition: width 0.28s ease; background-color: rgba(2, 6, 23, 0.97);
            border-left: 1px solid rgba(56, 189, 248, 0.35); box-shadow: -30px 0 60px -30px rgba(0,0,0,0.8);
        `;

        panel.innerHTML = `
            <div id="csti-side-panel-inner" style="width: ${CSTI_SIDE_PANEL_MAX_W}px; padding: 20px 18px 40px; box-sizing: border-box;">
                <div style="margin-bottom: 18px;">
                    <div style="display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3em; color: #64748b; font-family: ${monoFont}; margin-bottom: 6px;">
                        <span style="color: rgba(56, 189, 248, 0.9);">// preset · breakdown</span>
                        <div style="height: 1px; flex: 1; background: linear-gradient(to right, #1e293b, #334155, transparent);"></div>
                    </div>
                    <div style="font-family: ${monoFont}; font-size: 13px; color: #64748b; letter-spacing: 0.02em; line-height: 1.5;">How chat matches distribute across your presets over time.</div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                    <div style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.2em; color: #94a3b8;">Preset Match Distribution</div>
                    <div style="display: flex; gap: 3px;">
                        <button class="csti-breakdown-mode-btn" data-mode="bar" style="font-family: ${monoFont}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; padding: 6px 13px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Bar</button>
                        <button class="csti-breakdown-mode-btn" data-mode="pie" style="font-family: ${monoFont}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; padding: 6px 13px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Pie</button>
                        <button class="csti-breakdown-mode-btn" data-mode="timeline" style="font-family: ${monoFont}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; padding: 6px 13px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Timeline</button>
                    </div>
                </div>

                <div id="csti-breakdown-mode-hint" style="font-family: ${monoFont}; font-size: 13px; color: #94a3b8; margin-bottom: 14px; line-height: 1.6;"></div>

                <div id="csti-breakdown-metric-row" style="display: none; align-items: center; gap: 10px; margin-bottom: 12px;">
                    <span style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748b;">Count</span>
                    <div style="display: flex; gap: 3px;">
                        <button class="csti-breakdown-metric-btn" data-metric="messages" style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 5px 10px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Messages</button>
                        <button class="csti-breakdown-metric-btn" data-metric="occurrences" style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 5px 10px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Occurrences</button>
                    </div>
                </div>

                <div id="csti-breakdown-pie-wrap" style="display: none; flex-direction: column; align-items: center; gap: 20px;">
                    <canvas id="csti-breakdown-canvas" width="380" height="380" style="width: 100%; max-width: 380px; height: auto;"></canvas>
                    <div id="csti-breakdown-legend" style="width: 100%; font-family: ${monoFont}; font-size: 13px; color: #e2e8f0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px;"></div>
                </div>

                <div id="csti-breakdown-bar-wrap" style="display: none; flex-direction: column; gap: 14px;"></div>

                <div id="csti-breakdown-timeline-wrap" style="display: none; flex-direction: column; gap: 10px;">
                    <div id="csti-breakdown-timeline-type-row" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748b;">Chart</span>
                        <div style="display: flex; gap: 3px;">
                            <button class="csti-timeline-type-btn" data-type="stacked" style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 5px 10px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Stacked</button>
                            <button class="csti-timeline-type-btn" data-type="line" style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 5px 10px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Line</button>
                        </div>
                        <label id="csti-timeline-unmatched-toggle-row" style="display: none; align-items: center; gap: 6px; cursor: pointer; margin-left: 4px; font-family: ${monoFont}; font-size: 11px; color: #94a3b8;">
                            <input type="checkbox" id="csti-timeline-show-unmatched" style="accent-color: #38bdf8; width: 13px; height: 13px;"> Show "No preset match"
                        </label>
                    </div>

                    <div id="csti-timeline-groupby-row" style="display: none; align-items: center; gap: 10px;">
                        <span style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: #64748b;">Group by</span>
                        <div style="display: flex; gap: 3px;">
                            <button class="csti-timeline-groupby-btn" data-groupby="month" style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 5px 10px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Month</button>
                            <button class="csti-timeline-groupby-btn" data-groupby="map" style="font-family: ${monoFont}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 5px 10px; cursor: pointer; border: 1px solid rgba(30, 41, 59, 0.8); background: rgba(15, 23, 42, 0.8); color: #94a3b8;">Map</button>
                        </div>
                    </div>

                    <canvas id="csti-breakdown-timeline-canvas" width="424" height="280" style="width: 100%; cursor: crosshair;"></canvas>
                    <div id="csti-breakdown-timeline-axis" style="display: flex; justify-content: space-between; font-family: ${monoFont}; font-size: 12px; color: #64748b;"></div>
                    <div id="csti-breakdown-timeline-legend" style="font-family: ${monoFont}; font-size: 13px; color: #e2e8f0; display: flex; flex-wrap: wrap; gap: 8px 16px;"></div>
                </div>

                <div id="csti-breakdown-priority-block" style="display: none; margin-top: 16px; border-top: 1px solid rgba(30, 41, 59, 0.8); padding-top: 14px;">
                    <button id="csti-breakdown-priority-toggle" style="width: 100%; text-align: left; background: none; border: none; color: #38bdf8; font-family: ${monoFont}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; cursor: pointer; padding: 0;">▸ Edit preset priority &amp; visibility</button>
                    <div id="csti-breakdown-priority-note" style="display: none; font-family: ${monoFont}; font-size: 13px; color: #94a3b8; margin-top: 8px; line-height: 1.6;">
                        In Pie and Timeline mode each message is assigned to the first <u>visible</u> preset it matches, top to bottom — reorder to control which preset "wins" overlapping patterns (e.g. N-word vs. Slurs &amp; Hate Speech). Hide a preset to drop it from every chart without deleting it — hidden messages just fall through to the next preset in line, or to "No preset match".
                    </div>
                    <div id="csti-breakdown-priority-list" style="display: none; flex-direction: column; gap: 5px; margin-top: 10px;"></div>
                </div>

                <div id="csti-breakdown-note" style="font-family: ${monoFont}; font-size: 13px; color: #94a3b8; margin-top: 14px; letter-spacing: 0.02em; line-height: 1.6;"></div>
            </div>
        `;

        document.body.appendChild(jumpTab);
        document.body.appendChild(tabs);
        document.body.appendChild(panel);

        attachSidePanelListeners();
        applySidePanelState();
    }

    function applySidePanelState() {
        const panel = document.getElementById('csti-side-panel');
        const tabs = document.getElementById('csti-side-tabs');
        const tab = document.getElementById('csti-side-tab');
        const jumpTab = document.getElementById('csti-jump-tab');
        const inner = document.getElementById('csti-side-panel-inner');
        if (!panel || !tabs || !tab || !inner) return;

        const w = computeSidePanelWidth();
        inner.style.width = w + 'px';
        panel.style.width = sidePanelOpen ? w + 'px' : '0px';
        tabs.style.right = sidePanelOpen ? w + 'px' : '0px';
        if (jumpTab) jumpTab.style.right = sidePanelOpen ? w + 'px' : '0px';
        tab.querySelector('.csti-tab-arrow').textContent = sidePanelOpen ? '◀' : '▶';
        tab.classList.toggle('csti-tab-open', sidePanelOpen);

        if (sidePanelOpen) renderPresetBreakdown();
    }

    window.addEventListener('resize', () => {
        if (sidePanelOpen) applySidePanelState();
    });

    function setSidePanelOpen(open) {
        sidePanelOpen = open;
        localStorage.setItem('csti_side_panel_open', String(open));
        applySidePanelState();
    }

    function attachSidePanelListeners() {
        const panel = document.getElementById('csti-side-panel');
        const tab = document.getElementById('csti-side-tab');

        tab.addEventListener('click', () => setSidePanelOpen(!sidePanelOpen));
        tab.onmouseover = () => { tab.style.color = '#7dd3fc'; tab.style.borderColor = 'rgba(125, 211, 252, 0.8)'; };
        tab.onmouseout = () => { tab.style.color = '#38bdf8'; tab.style.borderColor = 'rgba(56, 189, 248, 0.5)'; };

        panel.querySelectorAll('.csti-breakdown-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                breakdownMode = btn.getAttribute('data-mode');
                localStorage.setItem('csti_breakdown_mode', breakdownMode);
                renderPresetBreakdown();
            });
        });

        panel.querySelectorAll('.csti-breakdown-metric-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                breakdownBarMetric = btn.getAttribute('data-metric');
                localStorage.setItem('csti_breakdown_bar_metric', breakdownBarMetric);
                renderPresetBreakdown();
            });
        });

        panel.querySelectorAll('.csti-timeline-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                timelineChartType = btn.getAttribute('data-type');
                localStorage.setItem('csti_timeline_chart_type', timelineChartType);
                // Map grouping only makes sense for Stacked (worst-first
                // ordering isn't a time axis); Line always reverts to Month.
                if (timelineChartType === 'line' && timelineGroupBy === 'map') {
                    timelineGroupBy = 'month';
                    localStorage.setItem('csti_timeline_group_by', timelineGroupBy);
                }
                renderPresetBreakdown();
            });
        });

        panel.querySelectorAll('.csti-timeline-groupby-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                timelineGroupBy = btn.getAttribute('data-groupby');
                localStorage.setItem('csti_timeline_group_by', timelineGroupBy);
                renderPresetBreakdown();
            });
        });

        document.getElementById('csti-timeline-show-unmatched').addEventListener('change', (e) => {
            timelineShowUnmatchedLine = e.target.checked;
            localStorage.setItem('csti_timeline_show_unmatched_line', String(timelineShowUnmatchedLine));
            renderPresetBreakdown();
        });

        document.getElementById('csti-breakdown-priority-toggle').addEventListener('click', () => {
            priorityEditorOpen = !priorityEditorOpen;
            renderPresetBreakdown();
        });

        setupTimelineTooltip();
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

            section.querySelectorAll('.divide-y > div.grid').forEach(msg => {
                if (!msg.querySelector('.csti-msg-copy-btn')) {
                    msg.style.position = 'relative';

                    const rowCopy = document.createElement('button');
                    rowCopy.className = 'csti-msg-copy-btn';
                    rowCopy.title = 'Copy message';
                    rowCopy.textContent = 'COPY';
                    
                    rowCopy.style.cssText = `
                        position: absolute; right: 48px; top: 50%; transform: translateY(-50%);
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
            const navButtons = Array.from(currentDoc.querySelectorAll('button[hx-get*="sections/chat?page="]'));
            const nextBtn = navButtons.find(btn => btn.textContent.toLowerCase().includes('older'));
            
            if (!nextBtn) break;

            const nextUrl = nextBtn.getAttribute('hx-get');
            pageCount++;
            fetchBtn.textContent = `FETCHING P${pageCount}...`;

            try {
                await new Promise(r => setTimeout(r, 250));
                
                const response = await fetch(nextUrl);
                const html = await response.text();
                
                const parser = new DOMParser();
                currentDoc = parser.parseFromString(html, 'text/html');

                const newContainer = currentDoc.querySelector('.overflow-y-auto');
                if (newContainer) {
                    const sections = newContainer.querySelectorAll('section');
                    sections.forEach(sec => targetContainer.appendChild(sec));
                }
            } catch (err) {
                console.error("CSTI: Failed to fetch pagination.", err);
                break;
            }
        }

        const liveNav = document.querySelector('#player-chat-section nav');
        if (liveNav) liveNav.remove();

        fetchBtn.textContent = 'ALL PAGES LOADED';
        fetchBtn.style.opacity = '1';
        fetchBtn.style.background = 'rgba(16, 185, 129, 0.2)';
        
        injectQuickCopyButtons();
        
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
                syncPresetOrder();
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

    // Counts each preset independently; overlapping presets can both count the same message.
    function computePresetBreakdownIndependent(metric) {
        const chatContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        const counts = {};
        const presetEntries = Object.entries(allPresets).filter(([name]) => !hiddenPresets.has(name));
        presetEntries.forEach(([name]) => { counts[name] = 0; });

        // 'messages': matched or not (0/1). 'occurrences': total pattern hits in the message.
        const useOccurrences = metric === 'occurrences';
        const compiled = presetEntries.map(([name, pattern]) => {
            try { return { name, re: new RegExp(pattern, useOccurrences ? 'gi' : 'i') }; }
            catch (e) { return null; }
        }).filter(Boolean);

        let total = 0;

        if (chatContainer) {
            chatContainer.querySelectorAll('.divide-y > div.grid').forEach(msg => {
                const textDiv = msg.querySelector('.whitespace-pre-wrap');
                if (!textDiv) return;
                const text = textDiv.dataset.originalText || textDiv.textContent;
                total++;
                compiled.forEach(p => {
                    if (useOccurrences) {
                        const hits = text.match(p.re);
                        if (hits) counts[p.name] += hits.length;
                    } else {
                        if (p.re.test(text)) counts[p.name]++;
                    }
                });
            });
        }

        return { counts, total };
    }

    // Exclusive: each message goes to the first preset it matches in presetOrder, so slices sum to 100%.
    function computePresetBreakdownExclusive() {
        const chatContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        const counts = {};
        presetOrder.forEach(name => { counts[name] = 0; });

        const compiled = presetOrder.map(name => {
            if (hiddenPresets.has(name) || !(name in allPresets)) return null;
            try { return { name, re: new RegExp(allPresets[name], 'i') }; }
            catch (e) { return null; }
        }).filter(Boolean);

        let unmatched = 0;
        let total = 0;

        if (chatContainer) {
            chatContainer.querySelectorAll('.divide-y > div.grid').forEach(msg => {
                const textDiv = msg.querySelector('.whitespace-pre-wrap');
                if (!textDiv) return;
                const text = textDiv.dataset.originalText || textDiv.textContent;
                total++;

                let matched = false;
                for (const p of compiled) {
                    if (p.re.test(text)) { counts[p.name]++; matched = true; break; }
                }
                if (!matched) unmatched++;
            });
        }

        return { counts, unmatched, total };
    }

    const CSTI_CHART_COLORS = [
        '#38bdf8', '#fbbf24', '#f472b6', '#a78bfa', '#34d399',
        '#fb7185', '#60a5fa', '#facc15', '#4ade80', '#c084fc'
    ];
    const CSTI_NO_MATCH_COLOR = '#334155';

    // Stable color per preset, keyed by presetOrder position — same color across all chart types.
    function getPresetColor(name) {
        const idx = presetOrder.indexOf(name);
        if (idx === -1) return CSTI_NO_MATCH_COLOR;
        return CSTI_CHART_COLORS[idx % CSTI_CHART_COLORS.length];
    }

    function stylePresetModeButtons() {
        document.querySelectorAll('.csti-breakdown-mode-btn').forEach(btn => {
            const active = btn.getAttribute('data-mode') === breakdownMode;
            btn.style.background = active ? 'rgba(56, 189, 248, 0.15)' : 'rgba(15, 23, 42, 0.8)';
            btn.style.borderColor = active ? 'rgba(56, 189, 248, 0.6)' : 'rgba(30, 41, 59, 0.8)';
            btn.style.color = active ? '#e0f2fe' : '#94a3b8';
        });
        document.querySelectorAll('.csti-breakdown-metric-btn').forEach(btn => {
            const active = btn.getAttribute('data-metric') === breakdownBarMetric;
            btn.style.background = active ? 'rgba(56, 189, 248, 0.15)' : 'rgba(15, 23, 42, 0.8)';
            btn.style.borderColor = active ? 'rgba(56, 189, 248, 0.6)' : 'rgba(30, 41, 59, 0.8)';
            btn.style.color = active ? '#e0f2fe' : '#94a3b8';
        });
        document.querySelectorAll('.csti-timeline-type-btn').forEach(btn => {
            const active = btn.getAttribute('data-type') === timelineChartType;
            btn.style.background = active ? 'rgba(56, 189, 248, 0.15)' : 'rgba(15, 23, 42, 0.8)';
            btn.style.borderColor = active ? 'rgba(56, 189, 248, 0.6)' : 'rgba(30, 41, 59, 0.8)';
            btn.style.color = active ? '#e0f2fe' : '#94a3b8';
        });
        document.querySelectorAll('.csti-timeline-groupby-btn').forEach(btn => {
            const active = btn.getAttribute('data-groupby') === timelineGroupBy;
            btn.style.background = active ? 'rgba(56, 189, 248, 0.15)' : 'rgba(15, 23, 42, 0.8)';
            btn.style.borderColor = active ? 'rgba(56, 189, 248, 0.6)' : 'rgba(30, 41, 59, 0.8)';
            btn.style.color = active ? '#e0f2fe' : '#94a3b8';
        });
    }

    function renderPriorityEditor() {
        const block = document.getElementById('csti-breakdown-priority-block');
        const toggle = document.getElementById('csti-breakdown-priority-toggle');
        const note = document.getElementById('csti-breakdown-priority-note');
        const list = document.getElementById('csti-breakdown-priority-list');

        const usesPriority = breakdownMode === 'pie' || breakdownMode === 'timeline';
        block.style.display = usesPriority ? 'block' : 'none';
        if (!usesPriority) return;

        toggle.textContent = (priorityEditorOpen ? '▾' : '▸') + ' Edit preset priority & visibility';
        note.style.display = priorityEditorOpen ? 'block' : 'none';
        list.style.display = priorityEditorOpen ? 'flex' : 'none';
        if (!priorityEditorOpen) return;

        list.innerHTML = presetOrder.map((name, i) => {
            const isHidden = hiddenPresets.has(name);
            return `
            <div style="display:flex; align-items:center; gap:8px; background: rgba(2,6,23,0.4); padding: 7px 10px; opacity: ${isHidden ? '0.45' : '1'};">
                <span style="color:#64748b; font-size:11px; width:18px; flex-shrink:0;">${i + 1}.</span>
                <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e2e8f0; font-size:13px; ${isHidden ? 'text-decoration: line-through;' : ''}">${name}</span>
                <button class="csti-priority-hide" data-idx="${i}" title="${isHidden ? 'Show in charts' : 'Hide from charts'}" style="background:none; border:1px solid ${isHidden ? 'rgba(56,189,248,0.5)' : 'rgba(30,41,59,0.8)'}; color:${isHidden ? '#38bdf8' : '#94a3b8'}; cursor:pointer; font-size:11px; padding:4px 9px;">${isHidden ? 'Show' : 'Hide'}</button>
                <button class="csti-priority-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''} style="background:none; border:1px solid rgba(30,41,59,0.8); color:${i === 0 ? '#334155' : '#94a3b8'}; cursor:${i === 0 ? 'default' : 'pointer'}; font-size:11px; padding:4px 8px;">▲</button>
                <button class="csti-priority-down" data-idx="${i}" ${i === presetOrder.length - 1 ? 'disabled' : ''} style="background:none; border:1px solid rgba(30,41,59,0.8); color:${i === presetOrder.length - 1 ? '#334155' : '#94a3b8'}; cursor:${i === presetOrder.length - 1 ? 'default' : 'pointer'}; font-size:11px; padding:4px 8px;">▼</button>
            </div>
        `;
        }).join('');

        list.querySelectorAll('.csti-priority-up').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const i = parseInt(btn.getAttribute('data-idx'), 10);
                if (i <= 0) return;
                [presetOrder[i - 1], presetOrder[i]] = [presetOrder[i], presetOrder[i - 1]];
                localStorage.setItem('csti_preset_order', JSON.stringify(presetOrder));
                renderPresetBreakdown();
            });
        });
        list.querySelectorAll('.csti-priority-down').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const i = parseInt(btn.getAttribute('data-idx'), 10);
                if (i >= presetOrder.length - 1) return;
                [presetOrder[i + 1], presetOrder[i]] = [presetOrder[i], presetOrder[i + 1]];
                localStorage.setItem('csti_preset_order', JSON.stringify(presetOrder));
                renderPresetBreakdown();
            });
        });
        list.querySelectorAll('.csti-priority-hide').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const i = parseInt(btn.getAttribute('data-idx'), 10);
                const name = presetOrder[i];
                if (hiddenPresets.has(name)) hiddenPresets.delete(name);
                else hiddenPresets.add(name);
                localStorage.setItem('csti_preset_hidden', JSON.stringify([...hiddenPresets]));
                renderPresetBreakdown();
            });
        });
    }

    function renderPresetBreakdown() {
        const hint = document.getElementById('csti-breakdown-mode-hint');
        const metricRow = document.getElementById('csti-breakdown-metric-row');
        const pieWrap = document.getElementById('csti-breakdown-pie-wrap');
        const barWrap = document.getElementById('csti-breakdown-bar-wrap');
        const timelineWrap = document.getElementById('csti-breakdown-timeline-wrap');
        const note = document.getElementById('csti-breakdown-note');
        if (!pieWrap || !barWrap || !timelineWrap) return;

        stylePresetModeButtons();
        renderPriorityEditor();

        pieWrap.style.display = breakdownMode === 'pie' ? 'flex' : 'none';
        barWrap.style.display = breakdownMode === 'bar' ? 'flex' : 'none';
        timelineWrap.style.display = breakdownMode === 'timeline' ? 'flex' : 'none';
        metricRow.style.display = breakdownMode === 'bar' ? 'flex' : 'none';

        if (breakdownMode === 'bar') {
            hint.textContent = breakdownBarMetric === 'occurrences'
                ? 'Independent counts — total pattern hits per preset, summed across all messages. A message with two slur words in it adds 2 to that preset, so this can run higher than your message count.'
                : 'Independent counts — one bar per preset, each computed on its own. Overlapping presets (e.g. N-word inside Slurs & Hate Speech) both count the same message, so bars don\'t need to sum to 100%.';
            renderBreakdownBar(barWrap, note);
        } else if (breakdownMode === 'timeline') {
            hint.textContent = 'Grouped by match month, using each match\'s date. Same exclusive assignment as Pie (first matching preset wins), so you can see if tone shifted from toxic toward sportsmanship over time. Priority order below controls overlaps.';
            renderBreakdownTimeline(note);
        } else {
            hint.textContent = 'Exclusive counts — each message goes to the first matching preset only, so slices always sum to 100%. Overlaps are resolved by priority order below.';
            renderBreakdownPie(note);
        }
    }

    function renderBreakdownBar(barWrap, note) {
        const { counts, total } = computePresetBreakdownIndependent(breakdownBarMetric);
        const isOccurrences = breakdownBarMetric === 'occurrences';

        if (total === 0) {
            barWrap.innerHTML = '<span style="font-family:' + monoFont + '; font-size:13px; color:#94a3b8;">No messages loaded.</span>';
            note.textContent = '';
            return;
        }

        const rows = Object.entries(counts)
            .map(([name, n]) => ({ name, n, color: getPresetColor(name) }))
            .sort((a, b) => b.n - a.n);

        const maxN = Math.max(1, ...rows.map(r => r.n));

        barWrap.innerHTML = rows.map(row => {
            const pct = ((row.n / total) * 100).toFixed(1);
            const pctLabel = isOccurrences ? `${pct}% of messages` : `${pct}%`;
            const widthPct = ((row.n / maxN) * 100).toFixed(1);
            return `<div style="font-family: ${monoFont}; font-size: 13px;">
                <div style="display:flex; justify-content:space-between; color:#e2e8f0; margin-bottom:4px;">
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:8px;">${row.name}</span>
                    <span style="color:#94a3b8; flex-shrink:0;">${row.n} <span style="color:#64748b;">(${pctLabel})</span></span>
                </div>
                <div style="background: rgba(2,6,23,0.5); height: 14px; width: 100%;">
                    <div style="background:${row.color}; height:100%; width:${widthPct}%;"></div>
                </div>
            </div>`;
        }).join('');

        note.textContent = isOccurrences
            ? `Based on ${total} loaded message${total === 1 ? '' : 's'}. Count = total pattern hits for that preset; % = that count relative to total messages (can exceed 100%).`
            : `Based on ${total} loaded message${total === 1 ? '' : 's'}. % is of total messages matched by that preset alone.`;
    }

    function renderBreakdownPie(note) {
        const canvas = document.getElementById('csti-breakdown-canvas');
        const legend = document.getElementById('csti-breakdown-legend');
        if (!canvas || !legend) return;

        const { counts, unmatched, total } = computePresetBreakdownExclusive();

        const slices = presetOrder
            .filter(name => counts[name] > 0)
            .map(name => ({ name, n: counts[name], color: getPresetColor(name) }));

        if (unmatched > 0) slices.push({ name: 'No preset match', n: unmatched, color: CSTI_NO_MATCH_COLOR });

        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        if (total === 0) {
            legend.innerHTML = '<span style="color:#64748b;">No messages loaded.</span>';
            note.textContent = '';
            return;
        }

        const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 2;
        let startAngle = -Math.PI / 2;

        slices.forEach(slice => {
            const angle = (slice.n / total) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, startAngle, startAngle + angle);
            ctx.closePath();
            ctx.fillStyle = slice.color;
            ctx.fill();
            startAngle += angle;
        });

        legend.innerHTML = slices.map(slice => {
            const pct = ((slice.n / total) * 100).toFixed(1);
            return `<div style="display:flex; align-items:center; gap:8px;">
                <span style="width:11px; height:11px; background:${slice.color}; flex-shrink:0; display:inline-block;"></span>
                <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#f8fafc;">${slice.name}</span>
                <span style="color:#64748b; flex-shrink:0;">${slice.n} (${pct}%)</span>
            </div>`;
        }).join('');

        note.textContent = `Based on ${total} loaded message${total === 1 ? '' : 's'}. Each message counts once, toward its highest-priority matching preset.`;
    }

    // Buckets messages by match month or by map (chat messages have no own
    // timestamp, so grouping is always per-match) and assigns exclusively, like Pie.
    function computeTimelineBreakdown(groupBy) {
        const chatContainer = document.querySelector('#player-chat-section .overflow-y-auto');
        const buckets = {};
        if (!chatContainer) return { buckets, keys: [] };

        const compiled = presetOrder.map(name => {
            if (hiddenPresets.has(name) || !(name in allPresets)) return null;
            try { return { name, re: new RegExp(allPresets[name], 'i') }; }
            catch (e) { return null; }
        }).filter(Boolean);

        chatContainer.querySelectorAll('section').forEach(section => {
            let bucketKey;
            if (groupBy === 'map') {
                const mapEl = section.querySelector('.font-medium.text-cyan-200');
                bucketKey = mapEl ? mapEl.textContent.trim() : 'Unknown';
            } else {
                const dateEl = section.querySelector('[data-time-ago]');
                if (!dateEl) return;
                const title = dateEl.getAttribute('title') || '';
                const dateStr = title.replace('played ', '').trim(); // "2026-08-31 21:04"
                bucketKey = dateStr.slice(0, 7); // "2026-08"
                if (bucketKey.length < 7) return;
            }

            if (!buckets[bucketKey]) buckets[bucketKey] = { total: 0, unmatched: 0 };
            const bucket = buckets[bucketKey];

            section.querySelectorAll('.divide-y > div.grid').forEach(msg => {
                const textDiv = msg.querySelector('.whitespace-pre-wrap');
                if (!textDiv) return;
                const text = textDiv.dataset.originalText || textDiv.textContent;
                bucket.total++;

                let matched = false;
                for (const p of compiled) {
                    if (p.re.test(text)) {
                        bucket[p.name] = (bucket[p.name] || 0) + 1;
                        matched = true;
                        break;
                    }
                }
                if (!matched) bucket.unmatched++;
            });
        });

        let keys;
        if (groupBy === 'map') {
            // Worst map first — highest flagged share, ties broken by message volume.
            keys = Object.keys(buckets).sort((a, b) => {
                const flaggedA = 1 - buckets[a].unmatched / buckets[a].total;
                const flaggedB = 1 - buckets[b].unmatched / buckets[b].total;
                return flaggedB - flaggedA || buckets[b].total - buckets[a].total;
            });
        } else {
            keys = Object.keys(buckets).sort(); // "YYYY-MM" sorts chronologically as a string
        }
        return { buckets, keys };
    }

    function formatBucketLabel(key) {
        return timelineGroupBy === 'map' ? key : formatMonthLabel(key);
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // DOM tooltip that follows the mouse; hit-tests timelineHitRegions from the latest render.
    function setupTimelineTooltip() {
        const canvas = document.getElementById('csti-breakdown-timeline-canvas');
        if (!canvas || canvas.dataset.cstiTooltipBound) return;
        canvas.dataset.cstiTooltipBound = 'true';

        let tooltip = document.getElementById('csti-timeline-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'csti-timeline-tooltip';
            tooltip.style.cssText = `
                position: fixed; z-index: 100001; display: none; pointer-events: none;
                background-color: rgba(2, 6, 23, 0.95); color: #f8fafc; border: 1px solid rgba(56, 189, 248, 0.5);
                padding: 7px 11px; font-family: ${monoFont}; font-size: 12px; line-height: 1.5;
                white-space: nowrap; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5);
            `;
            document.body.appendChild(tooltip);
        }

        // Padding is hit-test only — doesn't change what's drawn.
        const RECT_MIN_HIT_H = 5;
        const CIRCLE_HIT_R = 7;

        canvas.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const x = (e.clientX - rect.left) * scaleX;
            const y = (e.clientY - rect.top) * scaleY;

            let hit = null;
            let bestDist = Infinity;

            for (const r of timelineHitRegions) {
                if (r.shape === 'rect') {
                    const padY = Math.max(0, (RECT_MIN_HIT_H - r.h) / 2);
                    if (x >= r.x && x <= r.x + r.w && y >= r.y - padY && y <= r.y + r.h + padY) {
                        hit = r;
                        break;
                    }
                } else {
                    const dx = x - r.x, dy = y - r.y;
                    const dist = dx * dx + dy * dy;
                    if (dist <= CIRCLE_HIT_R * CIRCLE_HIT_R && dist < bestDist) {
                        hit = r;
                        bestDist = dist;
                    }
                }
            }

            if (!hit) { tooltip.style.display = 'none'; return; }

            const label = hit.name === '__unmatched' ? 'No preset match' : hit.name;
            tooltip.innerHTML = `<div style="color:#94a3b8;">${escapeHtml(formatBucketLabel(hit.bucketKey))}</div>
                <div style="color:#f8fafc; font-weight:600;">${escapeHtml(label)}</div>
                <div>${hit.n} / ${hit.total} msgs <span style="color:#64748b;">(${hit.pct.toFixed(1)}%)</span></div>`;
            tooltip.style.display = 'block';
            // Flip to the other side of the cursor when the default position
            // would push the tooltip past the viewport edge.
            const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
            const left = (e.clientX + 14 + tw > window.innerWidth) ? e.clientX - 14 - tw : e.clientX + 14;
            const top = (e.clientY + 14 + th > window.innerHeight) ? e.clientY - 14 - th : e.clientY + 14;
            tooltip.style.left = Math.max(4, left) + 'px';
            tooltip.style.top = Math.max(4, top) + 'px';
        });

        canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    }

    function formatMonthLabel(key) {
        const [y, m] = key.split('-');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const idx = parseInt(m, 10) - 1;
        return `${months[idx] || m}'${y.slice(2)}`;
    }

    function renderBreakdownTimeline(note) {
        const typeRow = document.getElementById('csti-breakdown-timeline-type-row');
        const unmatchedToggleRow = document.getElementById('csti-timeline-unmatched-toggle-row');
        const unmatchedToggleInput = document.getElementById('csti-timeline-show-unmatched');
        const groupByRow = document.getElementById('csti-timeline-groupby-row');
        const canvas = document.getElementById('csti-breakdown-timeline-canvas');
        const axis = document.getElementById('csti-breakdown-timeline-axis');
        const legend = document.getElementById('csti-breakdown-timeline-legend');
        if (!canvas || !axis || !legend) return;

        if (typeRow) typeRow.style.display = 'flex';
        if (unmatchedToggleRow) unmatchedToggleRow.style.display = timelineChartType === 'line' ? 'flex' : 'none';
        if (unmatchedToggleInput) unmatchedToggleInput.checked = timelineShowUnmatchedLine;
        // Map grouping only offered for Stacked — see the type-btn handler for why.
        if (groupByRow) groupByRow.style.display = timelineChartType === 'stacked' ? 'flex' : 'none';

        timelineHitRegions = [];

        // Stacked benefits from extra height (thin slices); Line doesn't, so it stays the same size.
        const targetHeight = timelineChartType === 'stacked' ? CSTI_TIMELINE_H_STACKED : CSTI_TIMELINE_H_LINE;
        if (canvas.height !== targetHeight) canvas.height = targetHeight;

        const groupBy = timelineChartType === 'stacked' ? timelineGroupBy : 'month';
        const { buckets, keys } = computeTimelineBreakdown(groupBy);
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        if (keys.length === 0) {
            axis.innerHTML = '';
            axis.style.height = '';
            axis.style.alignItems = '';
            legend.innerHTML = '<span style="color:#64748b;">No matches loaded.</span>';
            note.textContent = '';
            return;
        }

        const presetsUsedSet = new Set();
        keys.forEach(k => {
            presetOrder.forEach(name => { if (buckets[k][name]) presetsUsedSet.add(name); });
            if (buckets[k].unmatched) presetsUsedSet.add('__unmatched');
        });
        const presetsUsed = presetOrder.filter(n => presetsUsedSet.has(n));
        if (presetsUsedSet.has('__unmatched')) presetsUsed.push('__unmatched');

        // Line hides "No preset match" by default (it usually dominates); Stacked always shows it. Toggleable, not removed.
        const chartPresets = (timelineChartType === 'line' && !timelineShowUnmatchedLine)
            ? presetsUsed.filter(n => n !== '__unmatched')
            : presetsUsed;

        if (timelineChartType === 'line') {
            renderTimelineLine(ctx, w, h, buckets, keys, chartPresets);
        } else {
            renderTimelineStacked(ctx, w, h, buckets, keys, chartPresets);
        }

        // Map names run longer than "Aug'26" and don't fit horizontally under
        // narrow bars — angle them instead of truncating to near-uselessness.
        // Map mode always shows every bar's label (the map pool is finite and
        // rotation makes room); month mode still caps at 8 to avoid clutter
        // over a long chronological history.
        const rotateLabels = groupBy === 'map';
        const showAllLabels = rotateLabels || keys.length <= 8;
        axis.style.height = rotateLabels ? '64px' : '';
        axis.style.alignItems = rotateLabels ? 'flex-start' : '';

        if (showAllLabels) {
            axis.innerHTML = keys.map(k => rotateLabels
                // Anchoring on an edge (left or right) always leaves the label's
                // visual mass drifted to one side of the bar once rotated — an
                // edge point isn't the same as the label's own center. Instead
                // position the wrapper's center at 50% and rotate around the
                // label's own center (translateX(-50%) + transform-origin:
                // center), so the label's bounding-box center stays pinned to
                // the bar's center at any rotation angle.
                ? `<span style="flex:1; position:relative; height:1px;"><span style="position:absolute; top:0; left:50%; display:inline-block; transform: translateX(-50%) rotate(-40deg); transform-origin: center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80px; font-size:12px;">${escapeHtml(formatBucketLabel(k))}</span></span>`
                : `<span style="flex:1; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(formatBucketLabel(k))}</span>`
            ).join('');
        } else {
            axis.innerHTML = `<span>${escapeHtml(formatBucketLabel(keys[0]))}</span><span>${escapeHtml(formatBucketLabel(keys[keys.length - 1]))}</span>`;
        }

        legend.innerHTML = chartPresets.map(name => {
            const label = name === '__unmatched' ? 'No preset match' : name;
            const color = name === '__unmatched' ? CSTI_NO_MATCH_COLOR : getPresetColor(name);
            return `<div style="display:flex; align-items:center; gap:8px;">
                <span style="width:11px; height:11px; background:${color}; flex-shrink:0; display:inline-block;"></span>
                <span style="color:#f8fafc;">${escapeHtml(label)}</span>
            </div>`;
        }).join('');

        const totalMsgs = keys.reduce((sum, k) => sum + (buckets[k].total || 0), 0);
        note.textContent = timelineChartType === 'line'
            ? `Based on ${totalMsgs} loaded message${totalMsgs === 1 ? '' : 's'} across ${keys.length} month${keys.length === 1 ? '' : 's'}. One line per preset, y = that preset's % share of the month (0–100%). Months with no messages leave a gap in the line. Hover a point for exact numbers.`
            : groupBy === 'map'
            ? `Based on ${totalMsgs} loaded message${totalMsgs === 1 ? '' : 's'} across ${keys.length} map${keys.length === 1 ? '' : 's'}, worst first (highest flagged share). Each bar = one map, full bar height = 100% of that map's messages. Hover a segment for exact numbers.`
            : `Based on ${totalMsgs} loaded message${totalMsgs === 1 ? '' : 's'} across ${keys.length} month${keys.length === 1 ? '' : 's'}. Each bar = one calendar month, full bar height = 100% of that month's messages. Hover a segment for exact numbers.`;
    }

    function renderTimelineStacked(ctx, w, h, buckets, keys, presetsUsed) {
        const padding = 4;
        const gap = 4;
        const barAreaW = w - padding * 2;
        const barW = Math.max(2, (barAreaW - gap * (keys.length - 1)) / keys.length);
        const chartH = h - padding * 2;

        keys.forEach((k, i) => {
            const bucket = buckets[k];
            const total = bucket.total || 0;
            if (total === 0) return;
            const x = padding + i * (barW + gap);
            let y = h - padding;

            presetsUsed.forEach(name => {
                const n = name === '__unmatched' ? bucket.unmatched : (bucket[name] || 0);
                if (!n) return;
                const segH = (n / total) * chartH;
                ctx.fillStyle = name === '__unmatched' ? CSTI_NO_MATCH_COLOR : getPresetColor(name);
                ctx.fillRect(x, y - segH, barW, segH);

                // Hit region matches the drawn rect exactly; padding happens only at hit-test time.
                timelineHitRegions.push({
                    shape: 'rect', x, y: y - segH, w: barW, h: segH,
                    name, n, total, pct: (n / total) * 100, bucketKey: k
                });

                y -= segH;
            });
        });
    }

    // One line per preset: y = % share of that month's messages. A month
    // with zero messages total breaks the line; zero share still plots at 0.
    function renderTimelineLine(ctx, w, h, buckets, keys, presetsUsed) {
        const padding = 16;
        const chartW = w - padding * 2;
        const chartH = h - padding * 2;
        const xStep = keys.length > 1 ? chartW / (keys.length - 1) : 0;
        const xAt = i => padding + (keys.length > 1 ? i * xStep : chartW / 2);
        const yAt = pct => (h - padding) - (pct / 100) * chartH;

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
        ctx.lineWidth = 1;
        [0, 50, 100].forEach(p => {
            const y = yAt(p);
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(w - padding, y);
            ctx.stroke();
        });

        presetsUsed.forEach(name => {
            const color = name === '__unmatched' ? CSTI_NO_MATCH_COLOR : getPresetColor(name);
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1.5;

            let drawing = false;
            ctx.beginPath();
            keys.forEach((k, i) => {
                const bucket = buckets[k];
                const total = bucket.total || 0;
                if (total === 0) { drawing = false; return; }
                const n = name === '__unmatched' ? bucket.unmatched : (bucket[name] || 0);
                const pct = (n / total) * 100;
                const x = xAt(i), y = yAt(pct);
                if (!drawing) { ctx.moveTo(x, y); drawing = true; } else { ctx.lineTo(x, y); }
            });
            ctx.stroke();

            keys.forEach((k, i) => {
                const bucket = buckets[k];
                const total = bucket.total || 0;
                if (total === 0) return;
                const n = name === '__unmatched' ? bucket.unmatched : (bucket[name] || 0);
                const pct = (n / total) * 100;
                const x = xAt(i), y = yAt(pct);
                ctx.beginPath();
                ctx.arc(x, y, 2.5, 0, Math.PI * 2);
                ctx.fill();

                timelineHitRegions.push({ shape: 'circle', x, y, name, n, total, pct, bucketKey: k });
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
            const messages = section.querySelectorAll('.divide-y > div.grid');
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
        section.querySelectorAll('.divide-y > div.grid').forEach(msg => {
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
                const msgEl = section.querySelectorAll('.divide-y > div.grid')[idx]; 
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