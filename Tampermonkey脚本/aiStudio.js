    // ==UserScript==
    // @name         AI Studio WebSocket Hook
    // @namespace    http://tampermonkey.net/
    // @version      1.0
    // @description  Hook AI Studio responses and forward to WebSocket
    // @author       You
    // @match        https://aistudio.google.com/prompts/*
    // @grant        none
    // ==/UserScript==

    (function () {
        'use strict';
        console.log('AI Studio WebSocket Hook loaded...');
        window.aiStart = async function (wsConnection, evData) {
            if (!location.href.startsWith('https://aistudio.google.com/prompts/')) return;
            window.$$evData = evData;
            const {
                reqId,
                body,
                headers,
            } = evData;
            //会话id
            const sessionId = headers['x-request-id'] || headers['x-chat-request-id'];
            //定义 hook xhr 的事件
            //监听上下文保存完成
            window.onCreateSession = () => {
                console.log('保存会话成功');
                // window.aiStart(wsConnection, evData);
            };
            //构造上下文和functionCall等..
            window.getAiData = (originRes) => {
                console.log('hook getAiData');

                try {
                    let json = JSON.parse(originRes);
                    let sysMsg = '';
                    let userMsg = [];
                    let lastTool = null;
                    body.messages.forEach(item => {
                        if (item.role === 'system') {
                            sysMsg = item.content;
                        }
                        let tmp = createNullArray(29);
                        if (item.role === 'user' || item.role === 'assistant') {
                            let content = typeof item.content == 'string' ? item.content : (item.content[0].type == 'text' ? item.content[0].text : '');

                            // 如果是assistant消息，需要检查是否包含think标签
                            if (item.role === 'assistant' && content) {
                                // 提取think标签内容
                                const thinkMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);
                                if (thinkMatch) {
                                    // 创建think消息的tmp数组
                                    let thinkTmp = createNullArray(29);
                                    thinkTmp[0] = thinkMatch[1]; // think标签内容
                                    thinkTmp[8] = 'model';
                                    thinkTmp[16] = null; // think标签内容的tmp[16]是null
                                    thinkTmp[18] = 1;
                                    thinkTmp[19] = 1; // think标签内容的tmp[19]是1
                                    thinkTmp[25] = -1; // think标签内容的tmp[25]是-1
                                    userMsg.push(thinkTmp);

                                    // 移除think标签，保留普通内容
                                    content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
                                }
                            }

                            //如果是图片文件
                            if(item.content[1]?.type === "image_url") {
                                let fileTmp = createNullArray(29);
                                let file = parseBase64Url(item.content[1]?.image_url?.url);
                                if(file) {
                                    fileTmp[8] = 'user';
                                    fileTmp[12] = [
                                        file.mimeType,
                                        file.base64,
                                    ];
                                    fileTmp[18] = 259;
                                    userMsg.push(fileTmp);
                                }
                            }

                            // 如果还有普通内容，创建普通消息
                            if (content) {
                                tmp[0] = content;
                                tmp[8] = item.role === 'user' ? 'user' : 'model';
                                tmp[16] = item.role === 'assistant' ? 1 : null;
                                tmp[18] = 1;
                                userMsg.push(tmp);
                            }

                            if (item.tool_calls) {
                                lastTool = item.tool_calls;
                            }
                        }
                        if (item.role === 'tool') {
                            //找到对应的tool参数
                            let toolParams = lastTool ? lastTool.find(v => v.id == item.tool_call_id) : null;
                            toolParams = JSON.parse(toolParams?.function?.arguments || '{}');
                            let toolsKeys = Object.keys(toolParams) || [];
                            tmp[8] = 'model';
                            tmp[16] = 1;
                            tmp[18] = 128;
                            tmp[20] = [
                                [
                                    item.name,
                                    [
                                        toolsKeys.map(tk => {
                                            return [
                                                tk,
                                                [null, null, toolParams[tk]]
                                            ];
                                        })
                                    ],
                                ],
                                item.content,
                            ];
                            // tmp[28] = "";
                            // tmp[29] = [createNullArray(14)];
                            // tmp[29][0][10] = tmp[20][0];
                            userMsg.push(tmp);
                        }
                    });
                    body.msgSize = userMsg.length;
                    json[0][3] = [
                        1,
                        null,
                        "models/gemini-2.5-pro",//写死模型
                        null,
                        0.95,
                        64,
                        65536,
                        [
                            [
                                null,
                                null,
                                7,
                                5
                            ],
                            [
                                null,
                                null,
                                8,
                                5
                            ],
                            [
                                null,
                                null,
                                9,
                                5
                            ],
                            [
                                null,
                                null,
                                10,
                                5
                            ]
                        ],
                        null,
                        0,
                        null,
                        getTools(body),
                        null,
                        null,
                        0,
                        null,
                        null,
                        0,
                        0,
                        null,
                        null,
                        null,
                        null,
                        null,
                        -1
                    ];
                    json[0][12] = [sysMsg];
                    json[0][13] = [userMsg];
                    console.log('上下文', json);
                    return JSON.stringify(json);
                } catch (e) {
                    return originRes;
                }
            };
            //转发请求
            window.lastSentMsgIndex = 0;
            window.isInThinkMode = false;
            window.onAiMessage = (res, isEnd) => {
                window.sendInterval && clearInterval(window.sendInterval);
                const msgList = extractMsgContent(res);
                console.log('onAiMessage', msgList, isEnd);

                const CHAT_COMPLETION_ID_PREFIX = 'chatcmpl-';
                const MODEL_NAME = 'gemini-2.5-pro';

                if (!msgList || msgList.length === 0) {
                    if (isEnd) {
                        const created = Math.floor(Date.now() / 1000);
                        const endChunk = {
                            id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                            object: 'chat.completion.chunk',
                            created: created,
                            model: MODEL_NAME,
                            choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: 'stop'
                            }]
                        };
                        window.currentChunk = endChunk;

                        // 发送到WebSocket
                        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                            try {
                                wsConnection.send(JSON.stringify({
                                    type: 'ai_chunk',
                                    data: 'data: ' + JSON.stringify(endChunk) + '\n\n',
                                    isEnd: false,
                                    reqId,
                                }));
                                wsConnection.send(JSON.stringify({
                                    type: 'ai_chunk',
                                    data: 'data: [DONE]\n\n',
                                    isEnd: true,
                                    reqId,
                                }));
                            } catch (error) {
                                console.error('发送WebSocket消息失败:', error);
                            }
                        }
                        window.lastSentMsgIndex = 0;
                    }
                    return;
                }

                const newMessages = msgList.slice(window.lastSentMsgIndex);

                if (newMessages.length === 0 && !isEnd) {
                    return;
                }

                const created = Math.floor(Date.now() / 1000);
                let toolCallIndex = 0;

                for (let i = 0; i < newMessages.length; i++) {
                    const item = newMessages[i];
                    let chunk;

                    if (item.type === 'think' && item.content) {
                        // 如果是第一个think消息且不在think模式，添加开始标记
                        if (!window.isInThinkMode) {
                            const openThinkChunk = {
                                id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                                object: 'chat.completion.chunk',
                                created: created,
                                model: MODEL_NAME,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        content: '<thinking>'
                                    },
                                    finish_reason: null
                                }]
                            };

                            // 发送到WebSocket
                            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                                try {
                                    wsConnection.send(JSON.stringify({
                                        type: 'ai_chunk',
                                        data: 'data: ' + JSON.stringify(openThinkChunk) + '\n\n',
                                        isEnd: false,
                                        reqId,
                                    }));
                                } catch (error) {
                                    console.error('发送WebSocket消息失败:', error);
                                }
                            }
                            window.isInThinkMode = true;
                        }

                        // 输出think内容
                        chunk = {
                            id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                            object: 'chat.completion.chunk',
                            created: created,
                            model: MODEL_NAME,
                            choices: [{
                                index: 0,
                                delta: {
                                    content: item.content
                                },
                                finish_reason: null
                            }]
                        };
                    } else {
                        // 如果当前不是think消息但之前在think模式，需要闭合XML标记
                        if (window.isInThinkMode) {
                            const closeThinkChunk = {
                                id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                                object: 'chat.completion.chunk',
                                created: created,
                                model: MODEL_NAME,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        content: '</thinking>'
                                    },
                                    finish_reason: null
                                }]
                            };

                            // 发送到WebSocket
                            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                                try {
                                    wsConnection.send(JSON.stringify({
                                        type: 'ai_chunk',
                                        data: 'data: ' + JSON.stringify(closeThinkChunk) + '\n\n',
                                        isEnd: false,
                                        reqId,
                                    }));
                                } catch (error) {
                                    console.error('发送WebSocket消息失败:', error);
                                }
                            }
                            window.isInThinkMode = false;
                        }

                        if (item.type === 'function' && item.content) {
                            // 第一条消息：包含工具调用信息
                            const currentToolCallIndex = toolCallIndex++;
                            const toolCallId = `call_${item.content.name}_${created}_${currentToolCallIndex}`;

                            const firstChunk = {
                                id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                                object: 'chat.completion.chunk',
                                created: created,
                                model: MODEL_NAME,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        tool_calls: [{
                                            index: currentToolCallIndex,
                                            id: toolCallId,
                                            type: 'function',
                                            function: {
                                                name: item.content.name,
                                                arguments: JSON.stringify(item.content.params)
                                            }
                                        }]
                                    },
                                    finish_reason: null
                                }]
                            };

                            // 发送第一条消息
                            window.currentChunk = firstChunk;
                            console.log('data: ' + JSON.stringify(firstChunk) + '\n\n')

                            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                                try {
                                    wsConnection.send(JSON.stringify({
                                        type: 'ai_chunk',
                                        data: 'data: ' + JSON.stringify(firstChunk) + '\n\n',
                                        isEnd: false,
                                        reqId,
                                    }));
                                } catch (error) {
                                    console.error('发送WebSocket消息失败:', error);
                                }
                            }

                            // 第二条消息：标记工具要执行
                            chunk = {
                                id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                                object: 'chat.completion.chunk',
                                created: created,
                                model: MODEL_NAME,
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    finish_reason: 'tool_calls'
                                }]
                            };

                            // 立即发送第二条消息
                            window.currentChunk = chunk;
                            console.log('data: ' + JSON.stringify(chunk) + '\n\n')

                            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                                try {
                                    wsConnection.send(JSON.stringify({
                                        type: 'ai_chunk',
                                        data: 'data: ' + JSON.stringify(chunk) + '\n\n',
                                        isEnd: false,
                                        reqId,
                                    }));
                                } catch (error) {
                                    console.error('发送WebSocket消息失败:', error);
                                }
                            }

                            // 设置 chunk 为 null，避免重复发送
                            chunk = null;
                        } else if (item.type === 'image' && item.content) {
                            const imageMarkdown = `![image](data:image/png;base64,${item.content})`;
                            chunk = {
                                id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                                object: 'chat.completion.chunk',
                                created: created,
                                model: MODEL_NAME,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        content: imageMarkdown
                                    },
                                    finish_reason: null
                                }]
                            };
                        } else if (item.type === 'text' && item.content) {
                            chunk = {
                                id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                                object: 'chat.completion.chunk',
                                created: created,
                                model: MODEL_NAME,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        content: item.content
                                    },
                                    finish_reason: null
                                }]
                            };
                        }
                    }

                    if (chunk) {
                        window.currentChunk = chunk;
                        console.log('data: ' + JSON.stringify(chunk) + '\n\n')

                        // 发送到WebSocket
                        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                            try {
                                wsConnection.send(JSON.stringify({
                                    type: 'ai_chunk',
                                    data: 'data: ' + JSON.stringify(chunk) + '\n\n',
                                    isEnd: false,
                                    reqId,
                                }));
                            } catch (error) {
                                console.error('发送WebSocket消息失败:', error);
                            }
                        }
                    }
                }

                window.lastSentMsgIndex = msgList.length;

                if (isEnd) {
                    const endChunk = {
                        id: `${CHAT_COMPLETION_ID_PREFIX}${created}`,
                        object: 'chat.completion.chunk',
                        created: created,
                        model: MODEL_NAME,
                        choices: [{
                            index: 0,
                            delta: {},
                            finish_reason: 'stop'
                        }]
                    };

                    const lastMessage = msgList[msgList.length - 1];
                    if (lastMessage && (lastMessage.type === 'function' || lastMessage.type === 'think')) {
                        endChunk.choices[0].finish_reason = 'tool_calls';
                    }

                    window.currentChunk = endChunk;

                    // 发送到WebSocket
                    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                        try {
                            wsConnection.send(JSON.stringify({
                                type: 'ai_chunk',
                                data: 'data: ' + JSON.stringify(endChunk) + '\n\n',
                                isEnd: false,
                                reqId,
                            }));
                            wsConnection.send(JSON.stringify({
                                type: 'ai_chunk',
                                data: 'data: [DONE]\n\n',
                                isEnd: true,
                                reqId,
                            }));
                        } catch (error) {
                            console.error('发送WebSocket消息失败:', error);
                        }
                    }
                    window.lastSentMsgIndex = 0;
                }
            }
            //自动控制逻辑
            //1 先查找是否有title为 aiStudioApi 的历史记录,没有就创建
            //判断侧边栏是否打开
            let isOpenNavbar = document.getElementsByTagName('ms-prompt-history')[0].getElementsByClassName('ng-star-inserted').length > 0;
            if (!isOpenNavbar) {
                //先打开侧边栏才能获取会话记录
                document.getElementsByClassName('navbar-toggle-button')[0]?.click();
                console.log('打开侧边栏')
                await delay(100);
            }
            if (!document.querySelector('ms-prompt-history mat-expansion-panel.mat-expanded')) {
                document.getElementsByTagName('ms-prompt-history')[0]?.getElementsByTagName('button')[0].click();
                await delay(100);
            }
            let sessionList = document.getElementsByTagName('ms-prompt-history')[0]?.getElementsByClassName('prompt-link') || [];
            let sessionBtn = Array.from(sessionList).find(session => session.innerText.trim() === 'aiStudioApi');
            if (!sessionBtn) {
                console.log('没有找到会话,创建新会话');
                //创建会话,输入文字让创建会话按钮出来
                document.getElementsByTagName('ms-prompt-input-wrapper')[0].getElementsByTagName('textarea')[0].value = "1";
                document.getElementsByTagName('ms-prompt-input-wrapper')[0].getElementsByTagName('textarea')[0].dispatchEvent(new Event('input', { bubbles: true }));
                console.log('输入内容让创建会话按钮出来');
                document.body.style.zoom = 0.1;//缩放避免屏幕不兼容
                await delay(100);
                //点击创建会话按钮
                document.getElementsByClassName('page-title')[0].getElementsByTagName('button')[0].click();
                console.log('点击创建会话按钮');
                await delay(100);//等会话表单弹出
                document.getElementsByTagName('ms-save-prompt-dialog')[0].getElementsByTagName('input')[0].value = 'aiStudioApi';
                document.getElementsByTagName('ms-save-prompt-dialog')[0].getElementsByTagName('input')[0].dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementsByTagName('ms-save-prompt-dialog')[0].getElementsByTagName('textarea')[0].value = 'api自动控制,不要手动操作避免api上下文异常';
                document.getElementsByTagName('ms-save-prompt-dialog')[0].getElementsByTagName('textarea')[0].dispatchEvent(new Event('input', { bubbles: true }));
                //点击保存
                document.getElementsByTagName('ms-save-prompt-dialog')[0].getElementsByClassName('ms-button-primary')[0].click();
                console.log('点击保存会话按钮');
                document.body.style.zoom = 1;

                // 使用observeDOM监听会话列表变化，替代setInterval
                const sessionObserver = window.observeDOM(
                    document.getElementsByTagName('ms-prompt-history')[0],
                    (mutations) => {
                        let sessionList = document.getElementsByTagName('ms-prompt-history')[0]?.getElementsByClassName('prompt-link') || [];
                        let sessionBtn = Array.from(sessionList).find(session => session.innerText.trim() === 'aiStudioApi');
                        if (sessionBtn) {
                            sessionObserver.disconnect(); // 停止监听
                            window.aiStart(wsConnection, evData);
                        }
                    },
                    { childList: true, subtree: true }
                );
                return;
            }
            //3 执行刷新上下文
            document.querySelector('[href="/prompts/new_chat"]').click();
            let loadDom = document.getElementById('cdk-live-announcer-0');
            loadDom.innerText = '';
            await delay(500);
            sessionBtn.click();
            console.log('点击设置上下文,触发请求获取prompts记录,hook它返回websocket传递过来的记录');
            //在收到ai回复后再清除,避免没点到的情况
            window.sendInterval && clearInterval(window.sendInterval);
            window.sendInterval = setInterval(async () => {
                let msgDoms = document.querySelectorAll('ms-chat-turn');
                if (!msgDoms?.length || !loadDom.innerText) {
                    return;
                }
                let endDom = msgDoms[msgDoms.length - 1];
                if (endDom && endDom.querySelector('ms-function-call-chunk')) {
                    let btnDom = endDom.querySelector('.toggle-edit-button');
                    if(!btnDom) return
                    console.log('找到 fun call');
                    //点击编辑按钮,再点击send按钮
                    btnDom.click();
                    await delay(200);
                    endDom.querySelector('[type="submit"]').click();
                } else {
                    console.log('点击重试', endDom?.querySelector('[name="rerun-button"]'));
                    endDom?.querySelector('[name="rerun-button"]')?.click();
                }
            }, 2000)
        };
        // hook xhr
        xhrHook();
        // WebSocket处理
        var intervalId = null;
        const settingsManager = WebSocketSettingsManager();
        settingsManager.init({
            onMessage: function (message, wsConnection) {
                console.log('处理WebSocket消息:', message);

                // 设置全局的sendChunkToWebSocket函数
                window.sendChunkToWebSocket = function (data, isEnd) {
                    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                        try {
                            const messageData = {
                                type: 'ai_chunk',
                                data: data,
                                isEnd: isEnd,
                                reqId: message.reqId,
                            };
                            wsConnection.send(JSON.stringify(messageData));
                            console.log('发送数据到WebSocket:', messageData);
                        } catch (error) {
                            console.error('发送WebSocket消息失败:', error);
                        }
                    } else {
                        console.warn('WebSocket连接不可用，无法发送消息');
                    }
                };

                // 处理不同类型的消息
                switch (message.type) {
                    case 'ai_start':
                        let stoppableElements = document.getElementsByClassName('stoppable');
                        let isIdle = stoppableElements.length === 0;
                        if (!isIdle && message.reqId != window.$$evData?.reqId) {
                            //如果reqId不一致,发送非空闲状态到webSocket
                            try {
                                const idleMessage = {
                                    type: 'idle_status',
                                    isIdle: false,
                                    timestamp: Date.now(),
                                    reqId: message.reqId,
                                };
                                wsConnection.send(JSON.stringify(idleMessage));
                            } catch (error) {
                                console.error('发送空闲状态失败:', error);
                            }
                        }
                        if (window.aiStart && typeof window.aiStart === 'function') {
                            window.aiStart(wsConnection, message);
                        }
                        break;
                    case 'ai_stop':
                        //收到相同的reqId,则点击停止按钮
                        if (message.reqId === window.$$evData?.reqId) {
                            var stopButton = document.getElementsByClassName('stoppable')[0];
                            if (stopButton) {
                                stopButton.click();
                            }
                        }
                        break;
                    default:
                        console.log('未知的WebSocket消息类型:', message.type);
                }
            },
            onOpen: function (wsConnection) {
                console.log('WebSocket连接已建立');
                intervalId && clearInterval(intervalId);
                intervalId = setInterval(() => {
                    let stoppableElements = document.getElementsByClassName('stoppable');
                    let isIdle = stoppableElements.length === 0;

                    // 只有当空闲状态发生变化时才发送消息，避免重复发送
                    if (isIdle) {
                        const idleMessage = {
                            type: 'idle_status',
                            isIdle: true,
                            model: '.*',//匹配模型
                            timestamp: Date.now()
                        };
                        wsConnection.send(JSON.stringify(idleMessage));
                    }
                }, 1000); // 每秒检查一次
            }
        });

        // DOM监听工具函数 - 简化版
        window.observeDOM = function (targetElement, callback, options = {}) {
            if (!targetElement || typeof callback !== 'function') {
                console.error('observeDOM: 无效的参数');
                return null;
            }

            // 默认配置
            const config = {
                childList: true,
                subtree: true,
                attributes: false,
                characterData: false,
                ...options
            };

            // 创建并启动观察者
            const observer = new MutationObserver((mutations) => {
                try {
                    callback(mutations, targetElement);
                } catch (error) {
                    console.error('DOM监听回调执行错误:', error);
                }
            });

            observer.observe(targetElement, config);
            return observer; // 返回观察者对象，可用于停止监听: observer.disconnect()
        };

        // WebSocket设置管理器
        function WebSocketSettingsManager() {
            // WebSocket连接管理
            let wsConnection = null;
            let wsSettings = {
                wsUrl: 'ws://localhost:8080',
                autoConnect: false
            };
            let messageHandler = null;
            let openHandler = null;
            let reconnectTimer = null; // 重连定时器

            // 从localStorage加载设置
            function loadSettings() {
                const saved = localStorage.getItem('gemini-ws-settings');
                if (saved) {
                    try {
                        wsSettings = { ...wsSettings, ...JSON.parse(saved) };
                    } catch (e) {
                        console.error('加载WebSocket设置失败:', e);
                    }
                }
            }

            // 保存设置到localStorage
            function saveSettings() {
                localStorage.setItem('gemini-ws-settings', JSON.stringify(wsSettings));
            }

            // 连接WebSocket
            function connectWebSocket(messageHandler, openHandler) {
                if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                    return;
                }

                // 清除之前的重连定时器
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }

                try {
                    // 检查是否在HTTPS环境中使用ws://连接
                    if (location.protocol === 'https:' && wsSettings.wsUrl.startsWith('ws://')) {
                        console.warn('在HTTPS环境中使用非安全的WebSocket连接可能被浏览器阻止');
                        console.warn('建议使用wss://连接或在浏览器中允许混合内容');
                    }

                    wsConnection = new WebSocket(wsSettings.wsUrl);

                    wsConnection.onopen = function () {
                        console.log('WebSocket连接已建立');
                        // 清除重连定时器
                        if (reconnectTimer) {
                            clearTimeout(reconnectTimer);
                            reconnectTimer = null;
                        }
                        if (openHandler && typeof openHandler === 'function') {
                            openHandler(wsConnection);
                        }
                        updateConnectionStatus(true);
                    };

                    wsConnection.onclose = function (event) {
                        console.log('WebSocket连接已关闭', event);
                        updateConnectionStatus(false);
                        wsConnection = null;

                        // 如果不是手动断开连接，则启动重连
                        if (event.code !== 1000 && wsSettings.autoConnect) {
                            console.log('WebSocket连接意外断开，10秒后尝试重连...');
                            reconnectTimer = setTimeout(() => {
                                console.log('开始重连WebSocket...');
                                connectWebSocket(messageHandler, openHandler);
                            }, 10000); // 10秒后重连
                        }
                    };

                    wsConnection.onerror = function (error) {
                        console.error('WebSocket连接错误:', error);
                        if (location.protocol === 'https:' && wsSettings.wsUrl.startsWith('ws://')) {
                            console.error('可能的原因：HTTPS页面不允许非安全的WebSocket连接');
                            console.error('解决方案：1) 使用wss://连接 2) 在浏览器地址栏点击锁图标，允许不安全内容');
                        }
                        updateConnectionStatus(false);

                        // 连接错误时也启动重连（如果启用了自动连接）
                        if (wsSettings.autoConnect && !reconnectTimer) {
                            console.log('WebSocket连接错误，10秒后尝试重连...');
                            reconnectTimer = setTimeout(() => {
                                console.log('开始重连WebSocket...');
                                connectWebSocket(messageHandler, openHandler);
                            }, 10000); // 10秒后重连
                        }
                    };

                    wsConnection.onmessage = function (event) {
                        try {
                            const message = JSON.parse(event.data);
                            console.log('收到WebSocket消息:', message);

                            // 如果提供了消息处理函数，则调用它，并传递WebSocket连接对象
                            if (messageHandler && typeof messageHandler === 'function') {
                                messageHandler(message, wsConnection);
                            }
                        } catch (e) {
                            console.error('解析WebSocket消息失败:', e);
                        }
                    };
                } catch (error) {
                    console.error('WebSocket连接失败:', error);
                    if (location.protocol === 'https:' && wsSettings.wsUrl.startsWith('ws://')) {
                        console.error('可能的原因：HTTPS页面不允许非安全的WebSocket连接');
                    }
                    updateConnectionStatus(false);
                }
            }

            // 断开WebSocket
            function disconnectWebSocket() {
                // 清除重连定时器
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }

                if (wsConnection) {
                    wsConnection.close(1000, 'Manual disconnect'); // 使用1000状态码表示正常关闭
                    wsConnection = null;
                }
                updateConnectionStatus(false);
            }

            // 更新连接状态显示
            function updateConnectionStatus(connected) {
                const statusElement = document.getElementById('ws-status');
                if (statusElement) {
                    statusElement.textContent = connected ? '已连接' : '未连接';
                    statusElement.className = connected ? 'connected' : 'disconnected';
                }

                // 更新连接按钮状态
                const connectBtn = document.getElementById('ws-connect-toggle');
                if (connectBtn) {
                    if (connected) {
                        connectBtn.textContent = '断开连接';
                        connectBtn.style.background = '#ea4335';
                        connectBtn.dataset.connected = 'true';
                    } else {
                        connectBtn.textContent = '连接';
                        connectBtn.style.background = '#4285f4';
                        connectBtn.dataset.connected = 'false';
                    }
                }
            }

            // 创建设置界面
            function createSettingsUI() {
                // 创建设置按钮
                const settingsBtn = document.createElement('div');
                settingsBtn.id = 'gemini-ws-settings-btn';
                settingsBtn.textContent = '⚙️';
                settingsBtn.style.cssText = `
                        position: fixed;
                        top: 40px;
                        right: 20px;
                        width: 40px;
                        height: 40px;
                        background: #4285f4;
                        color: white;
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        z-index: 10000;
                        font-size: 18px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    `;

                // 创建设置面板
                const settingsPanel = document.createElement('div');
                settingsPanel.id = 'gemini-ws-settings-panel';
                settingsPanel.style.cssText = `
                        position: fixed;
                        top: 70px;
                        right: 20px;
                        width: 300px;
                        background: white;
                        border: 1px solid #ddd;
                        border-radius: 8px;
                        padding: 20px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                        z-index: 10001;
                        display: none;
                        font-family: Arial, sans-serif;
                    `;

                // 创建设置面板内容
                const title = document.createElement('h3');
                title.style.cssText = 'margin: 0 0 15px 0; color: #333;';
                title.textContent = 'AI Studio OpenAi Proxy 设置';
                settingsPanel.appendChild(title);

                // WebSocket连接地址输入
                const wsUrlDiv = document.createElement('div');
                wsUrlDiv.style.marginBottom = '15px';
                const wsUrlLabel = document.createElement('label');
                wsUrlLabel.style.cssText = 'display: block; margin-bottom: 5px; color: #555;';
                wsUrlLabel.textContent = 'WebSocket连接地址:';
                const wsUrlInput = document.createElement('input');
                wsUrlInput.type = 'text';
                wsUrlInput.id = 'ws-url';
                wsUrlInput.value = wsSettings.wsUrl;
                wsUrlInput.placeholder = '请输入WebSocket连接地址，如: ws://localhost:8080 (HTTPS页面建议使用wss://)';
                wsUrlInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
                wsUrlDiv.appendChild(wsUrlLabel);
                wsUrlDiv.appendChild(wsUrlInput);
                settingsPanel.appendChild(wsUrlDiv);

                // 自动连接复选框
                const autoConnectDiv = document.createElement('div');
                autoConnectDiv.style.marginBottom = '15px';
                const autoConnectLabel = document.createElement('label');
                autoConnectLabel.style.cssText = 'display: block; margin-bottom: 5px; color: #555;';
                const autoConnectCheckbox = document.createElement('input');
                autoConnectCheckbox.type = 'checkbox';
                autoConnectCheckbox.id = 'ws-auto-connect';
                autoConnectCheckbox.checked = wsSettings.autoConnect;
                autoConnectLabel.appendChild(autoConnectCheckbox);
                autoConnectLabel.appendChild(document.createTextNode(' 自动连接'));
                autoConnectDiv.appendChild(autoConnectLabel);
                settingsPanel.appendChild(autoConnectDiv);

                // 状态显示
                const statusDiv = document.createElement('div');
                statusDiv.style.marginBottom = '15px';
                const statusLabel = document.createElement('span');
                statusLabel.style.color = '#555';
                statusLabel.textContent = '状态: ';
                const statusSpan = document.createElement('span');
                statusSpan.id = 'ws-status';
                statusSpan.className = 'disconnected';
                statusSpan.textContent = '未连接';
                statusDiv.appendChild(statusLabel);
                statusDiv.appendChild(statusSpan);
                settingsPanel.appendChild(statusDiv);

                // 按钮容器
                const buttonDiv = document.createElement('div');
                buttonDiv.style.cssText = 'display: flex; gap: 10px;';
                const connectToggleBtn = document.createElement('button');
                connectToggleBtn.id = 'ws-connect-toggle';
                connectToggleBtn.style.cssText = 'flex: 1; padding: 8px; background: #4285f4; color: white; border: none; border-radius: 4px; cursor: pointer;';
                connectToggleBtn.textContent = '连接';
                connectToggleBtn.dataset.connected = 'false';
                buttonDiv.appendChild(connectToggleBtn);
                settingsPanel.appendChild(buttonDiv);

                // 保存按钮
                const saveBtn = document.createElement('button');
                saveBtn.id = 'ws-save';
                saveBtn.style.cssText = 'width: 100%; margin-top: 10px; padding: 8px; background: #34a853; color: white; border: none; border-radius: 4px; cursor: pointer;';
                saveBtn.textContent = '保存设置';
                settingsPanel.appendChild(saveBtn);

                // 添加样式
                const style = document.createElement('style');
                style.textContent = `
                        #ws-status.connected { color: #34a853; font-weight: bold; }
                        #ws-status.disconnected { color: #ea4335; font-weight: bold; }
                    `;
                document.head.appendChild(style);

                // 事件监听器
                settingsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isVisible = settingsPanel.style.display !== 'none';
                    settingsPanel.style.display = isVisible ? 'none' : 'block';
                    console.log('设置面板状态:', settingsPanel.style.display);
                });

                // 设置面板事件
                settingsPanel.addEventListener('click', (e) => {
                    e.stopPropagation();

                    if (e.target.id === 'ws-connect-toggle') {
                        const isConnected = e.target.dataset.connected === 'true';
                        if (isConnected) {
                            disconnectWebSocket();
                        } else {
                            connectWebSocket(messageHandler, openHandler);
                        }
                    } else if (e.target.id === 'ws-save') {
                        // 保存设置
                        const wsUrlValue = document.getElementById('ws-url').value.trim();
                        if (!wsUrlValue) {
                            alert('请填写WebSocket连接地址');
                            return;
                        }
                        if (!wsUrlValue.startsWith('ws://') && !wsUrlValue.startsWith('wss://')) {
                            alert('WebSocket连接地址必须以 ws:// 或 wss:// 开头');
                            return;
                        }
                        wsSettings.wsUrl = wsUrlValue;
                        wsSettings.autoConnect = document.getElementById('ws-auto-connect').checked;
                        saveSettings();
                        alert('设置已保存');
                    }
                });

                // 点击其他地方关闭面板
                document.addEventListener('click', (e) => {
                    // 如果点击的不是设置按钮或设置面板内的元素，则关闭面板
                    if (!settingsBtn.contains(e.target) && !settingsPanel.contains(e.target)) {
                        settingsPanel.style.display = 'none';
                    }
                });

                document.body.appendChild(settingsBtn);
                document.body.appendChild(settingsPanel);
            }

            // 初始化设置管理器
            function init(options = {}) {
                const { onMessage, onOpen } = options;

                // 保存消息处理函数
                messageHandler = onMessage;
                openHandler = onOpen;

                // 加载设置
                loadSettings();

                // 页面加载完成后创建UI
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', createSettingsUI);
                } else {
                    createSettingsUI();
                }

                // 自动连接
                if (wsSettings.autoConnect) {
                    setTimeout(() => connectWebSocket(messageHandler, openHandler), 1000);
                }
            }

            // 返回公共接口
            return {
                init: init,
                disconnect: disconnectWebSocket,
                getSettings: () => wsSettings,
                loadSettings: loadSettings,
                saveSettings: saveSettings
            };
        }

        function extractMsgContent(inputString) {
            try {
                const results = [];

                // 根据用户要求：前缀 [[null, ... 后缀 ","model"]，截取中间子数组内容
                // 使用简单的非贪婪匹配，但确保正确处理嵌套结构
                const chunkRegex = /\[\[null,([\s\S]*?)\],\s*"model"\]/g;
                let m;

                while ((m = chunkRegex.exec(inputString)) !== null) {
                    const inner = m[1];
                    try {
                        // 还原为可 JSON.parse 的子数组：[null, ...]
                        const subArray = JSON.parse(`[null,${inner}`);
                        if (Array.isArray(subArray)) {
                            const result = parseSubArray(subArray);
                            if (result) results.push(result);
                        }
                    } catch (e) {
                        // console.warn('解析子数组失败:', e);
                    }
                }

                return results;
            } catch (error) {
                console.error('提取文字内容时出错:', error);
                return [];
            }
        }

        function parseSubArray(subArray) {
            try {
                let type = "text";
                let textContent = "";

                // 检查索引1 - 文本内容
                if (subArray.length > 1 && subArray[1] !== null && subArray[1] !== undefined) {
                    type = "text";
                    textContent = subArray[1];
                }

                // 检查索引2 - 可能是长度为2的数组, 文件类型
                if (subArray.length > 2 && subArray[2] !== null && Array.isArray(subArray[2]) && subArray[2].length === 2) {
                    type = subArray[2][0];
                    textContent = subArray[2][1];
                } else {
                    // 检查索引12 - isThink标记
                    if (subArray.length > 12 && subArray[12] === 1) {
                        type = 'think';
                    }
                }

                // 检查索引10 - function类型
                if (subArray.length > 10 && subArray[10] !== null && subArray[10] !== undefined) {
                    type = "function";
                    textContent = parseFunctionData(subArray[10]);
                }

                // 只有当有实际内容时才返回结果
                if (textContent) {
                    return {
                        content: textContent,
                        type: type,
                    };
                }

                return null;
            } catch (error) {
                console.error('解析子数组失败:', error);
                return null;
            }
        }

        function parseFunctionData(functionArray) {
            try {
                if (!Array.isArray(functionArray) || functionArray.length < 2) {
                    return null;
                }

                const functionName = functionArray[0];
                const paramsArray = functionArray[1];

                if (!Array.isArray(paramsArray)) {
                    return { name: functionName, params: {} };
                }

                const params = {};

                // 解析参数数组
                paramsArray.forEach(paramGroup => {
                    if (Array.isArray(paramGroup)) {
                        paramGroup.forEach(param => {
                            if (Array.isArray(param) && param.length >= 2) {
                                const paramName = param[0];
                                const paramValueArray = param[1];

                                if (Array.isArray(paramValueArray) && paramValueArray.length > 2) {
                                    // 参数值在索引2
                                    params[paramName] = paramValueArray[2];
                                }
                            }
                        });
                    }
                });

                return {
                    name: functionName,
                    params: params
                };
            } catch (error) {
                console.error('解析函数数据失败:', error);
                return null;
            }
        }

        function xhrHook() {
            //hookXhr实现自定义内容, 重写window的getAiData方法返回ai studio 设置上下文function call 等
            // hook xhr 会调用getAiData返回,dom点击会话历史触发切换就能加载了
            // 重写onAiMessage能获取aiStudio返回的内容
            const openCache = window.XMLHttpRequest.prototype.open;
            const originalSend = window.XMLHttpRequest.prototype.send;
            // 获取 responseText 和 response 原始的属性描述符
            const responseTextDescriptor = Object.getOwnPropertyDescriptor(window.XMLHttpRequest.prototype, 'responseText');
            const responseDescriptor = Object.getOwnPropertyDescriptor(window.XMLHttpRequest.prototype, 'response');
            //请求后处理
            window.XMLHttpRequest.prototype.open = function (method, url) {
                this._requestURL = url;
                console.log(`open xhr ${url}`);
                const xhr = this;
                if (!xhr._isHooked) {
                    xhr._isHooked = true;
                    // 重定义 responseText 属性
                    Object.defineProperty(xhr, 'responseText', {
                        configurable: true,
                        get: function () {
                            console.log('测试注入xhr');
                            // 1. 调用原始的 get 方法获取未经修改的 responseText
                            let originalResponseText = responseTextDescriptor.get.call(this);
                            if (window.onAiMessage && originalResponseText && url.includes('/GenerateContent')) {
                                let isEnd = this.readyState === 4;
                                window.onAiMessage(originalResponseText, isEnd)
                            }
                            if (this.readyState !== 4) {
                                return originalResponseText;
                            }
                            // 2. 检查请求是否已完成，如果未完成则直接返回原始值
                            if (this.readyState !== 4 || !originalResponseText) {
                                return originalResponseText;
                            }
                            // 检查 URL 是否包含 'ResolveDriveResource'
                            if ((url.includes("/ResolveDriveResource") || url.includes("/CreatePrompt")) && window.getAiData) {
                                const modifiedText = window.getAiData(originalResponseText);
                                // 返回修改后的文本
                                return modifiedText;
                            }
                            // 4. 如果不符合条件，返回原始响应文本
                            return originalResponseText;
                        }
                    });
                    Object.defineProperty(xhr, 'response', {
                        configurable: true,
                        get: function () {
                            console.log('测试注入xhr');
                            // 1. 获取原始的 response (可能是对象、文本等)
                            const originalResponse = responseDescriptor.get.call(this);
                            if (window.onAiMessage && originalResponse && url.includes('/GenerateContent')) {
                                let isEnd = this.readyState === 4;
                                // window.onAiMessage(originalResponse, isEnd)
                            }
                            if (this.readyState !== 4) {
                                return originalResponse;
                            }
                            // 对于非文本/json类型的响应，直接返回
                            if (this.responseType !== '' && this.responseType !== 'text' && this.responseType !== 'json') {
                                return originalResponse;
                            }
                            // 2. --- 在这里加入你的特定修改逻辑 ---
                            if ((url.includes("/ResolveDriveResource") || url.includes("/CreatePrompt")) && window.getAiData) {
                                // 首先获取原始的文本内容
                                let originalResponseText = responseTextDescriptor.get.call(this);
                                if (!originalResponseText) return originalResponse;
                                // 进行替换
                                const modifiedText = window.getAiData(originalResponseText);
                                // 如果原始请求期望一个JSON对象 (responseType === 'json')
                                // 我们需要返回一个由修改后文本解析出的新JSON对象
                                if (this.responseType === 'json') {
                                    try {
                                        return JSON.parse(modifiedText);
                                    } catch (e) {
                                        // 如果解析失败，返回原始的 response 以免业务逻辑报错
                                        console.error("Hook xhr response: Failed to parse modified JSON, returning original.", e);
                                        return originalResponse;
                                    }
                                }
                                // 如果是文本类型，直接返回修改后的文本
                                return modifiedText;
                            }
                            // 3. 如果不符合条件，返回原始响应
                            return originalResponse;
                        }
                    });
                }
                return openCache.apply(this, arguments);
            };
            //拦截请求
            let ResolveDriveResourceTmp = "[[\"prompts/Tips_Turn_off_script_to_restore_webpage_to_normal\",null,null,[1,null,\"models/gemini-2.5-pro\",null,0.95,64,65536,[[null,null,7,5],[null,null,8,5],[null,null,9,5],[null,null,10,5]],null,0,null,null,null,null,0,null,null,0,0,null,null,null,null,null,128],[\"Untitled prompt\",null,[\"fff\",1,\"https://lh3.googleusercontent.com/a/test\"],null,[[\"1759074710\",704000000],[\"fff\",1,\"https://lh3.googleusercontent.com/a/test\"]],[1,1,1],null,null,null,null,[]],null,null,null,null,null,null,null,[],[null,[[\"1\",null,null,null,null,null,null,null,\"user\",null,null,null,null,null,null,null,null,null,2,null,null,null,null,null,null,null,null,null,\"\"]]]]]";
            let updateTmp = "[\"prompts/Tips_Turn_off_script_to_restore_webpage_to_normal\",null,null,[1,null,\"models/gemini-2.5-pro\",null,0.95,64,65536,[[null,null,7,5],[null,null,8,5],[null,null,9,5],[null,null,10,5]],null,0,null,null,null,null,0,null,null,0,0,null,null,null,null,null,8192],[\"aiStudioApi\",null,[\"fff\",1,\"https://lh3.googleusercontent.com/a/test\"],null,[[\"1759073740\",966000000],[\"fff\",1,\"https://lh3.googleusercontent.com/a/test\"]],[1,1,1],null,null,null,null,[]],null,null,null,null,null,null,null,[],[null,[[\"1\",null,null,null,null,null,null,null,\"user\",null,null,null,null,null,null,null,null,null,2]]]]";
            let listTmp = "[[[\"prompts/Tips_Turn_off_script_to_restore_webpage_to_normal\",null,null,null,[\"aiStudioApi\",null,[\"fff\",1,\"https://lh3.googleusercontent.com/a/test\"],null,[[\"1759073734\",670000000],[\"fff\",1,\"https://lh3.googleusercontent.com/a/test\"]],[1,1,1],null,null,null,null,[]],null,null,null,null,null,null,null,null,[]]]]";
            XMLHttpRequest.prototype.send = function(...args) {
                const url = this._requestURL;
                var modifiedText = "";
                if(url?.includes("/ResolveDriveResource")) {
                    console.log(`[XHR Hook] 拦截到外部请求: ${url}`);
                    modifiedText = window.getAiData(ResolveDriveResourceTmp);
                }
                if(url?.includes('/ListPrompts')) {
                    console.log(`[XHR Hook] 拦截到外部请求: ${url}`);
                    modifiedText = listTmp;
                }
                if(url?.includes("/UpdatePrompt")) {
                    console.log(`[XHR Hook] 拦截到外部请求: ${url}`);
                    modifiedText = updateTmp;
                }
                if(modifiedText) {
                    console.log("[XHR Hook] 正在返回自定义的成功响应...", JSON.parse(modifiedText));
                    // 使用 Object.defineProperty 定义只读属性，更真实地模拟原生XHR对象
                    Object.defineProperty(this, 'status', { value: 200, writable: false });
                    Object.defineProperty(this, 'statusText', { value: 'OK', writable: false });
                    Object.defineProperty(this, 'response', { value: modifiedText, writable: false });
                    Object.defineProperty(this, 'responseText', { value: modifiedText, writable: false });
                    Object.defineProperty(this, 'readyState', { value: XMLHttpRequest.DONE, writable: false }); // DONE = 4
                    // 触发 onload 和 onreadystatechange 事件，让监听器以为请求已成功完成
                    // 使用 setTimeout 模拟异步性，防止回调在 send() 调用栈中同步执行
                    setTimeout(() => {
                        if (typeof this.onreadystatechange === 'function') {
                            this.onreadystatechange();
                        }
                        if (typeof this.onload === 'function') {
                            this.onload();
                        }
                    }, 0);
                    return;
                }
                return originalSend.apply(this, args);
            };
        }

        // --- END: Hide Disclaimer & Fix Layout (v2) ---
        function delay(ms) {
            return new Promise(resolve => {
                setTimeout(resolve, ms);
            });
        }

        function getTools(body) {
            let types = { 'string': 1, 'number': 2, 'integer': 3, 'boolean': 4, 'object': 5, 'enum': 6 }
            let tools = body?.tools
            if (!tools) return null;
            return tools.map((item) => {
                let fc = item.function;
                let paramsKeys = fc?.parameters?.properties ? Object.keys(fc.parameters.properties) : [];
                let params = paramsKeys.map(key => {
                    return [
                        key,
                        [
                            types[fc.parameters.properties[key].type],
                            null,
                            fc.parameters.properties[key]?.description || '',
                        ]
                    ]
                });
                if (!params.length) {
                    params = null;
                }
                return [
                    fc.name,
                    fc.description,
                    [
                        6,
                        null,
                        null,
                        null,
                        null,
                        null,
                        params,
                        fc.parameters.required,
                        /*[
                            [
                                "dsn",
                                [
                                    1,
                                    null,
                                    "MySQL数据库连接字符串，DSN格式：mysql://user:password@host:port/database"
                                ]
                            ],
                            [
                                "sql",
                                [
                                    1,
                                    null,
                                    "要执行的SQL语句,执行失败重试2次"
                                ]
                            ]
                        ],
                        [
                            "dsn",
                            "sql"
                        ]*/
                    ],
                    null,
                    0
                ]
            })
        }

        function createNullArray(len) {
            let arr = [];
            for (let i = 0; i <= len; i++) {
                arr.push(null);
            }
            return arr;
        }
        function parseBase64Url(base64UrlString) {
            const regex = /^data:([a-z]+\/[a-z0-9\-\+\.]+);base64,(.+)$/i;
            const match = base64UrlString.match(regex);
            if (!match) {
                console.error("无效的 Base64 URL 格式");
                return null;
            }
            return {
                mimeType: match[1],
                base64: match[2],
            };
        }
    })();
