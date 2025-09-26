
// 引入所需模块
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 创建Express应用和WebSocket服务器
const httpApp = express();
httpApp.use(express.json({ limit: '50mb' }));
httpApp.use(express.urlencoded({ limit: '50mb', extended: true }));

// 从环境变量读取配置
const API_HOST = process.env.API_HOST || '127.0.0.1';
const WS_PORT = parseInt(process.env.WS_PORT) || 8080;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || 'certs/server.key';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || 'certs/server.crt';

// WebSocket服务器和连接管理
const wsServer = new WebSocket.Server({ port: WS_PORT });
const wsConnections = new Map(); // 存储WebSocket连接
// 请求队列 req=>data
const activeRequests = new Map();

console.log(`WebSocket服务器启动在端口 ${WS_PORT}`);

// WebSocket连接处理
wsServer.on('connection', (ws, req) => {
    const connectionId = Math.random().toString(36).substring(2, 9);
    console.log(`[WS-${connectionId}] 新的WebSocket连接`);

    wsConnections.set(connectionId, {
        ws: ws,
        isIdle: false,
        lastActivity: Date.now()
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log(`[WS-${connectionId}] 收到消息:`, data.type);

            switch (data.type) {
                case 'idle_status':
                    if (data.isIdle) {
                        //当空闲状态找一个符合模型的待处理请求对象,发送start事件,并标记进行中
                        const requestData = findInMap(activeRequests, item => item.isIdle && (!data.model || item?.req?.body?.model?.search(data.model) >= 0));
                        if (requestData) {
                            requestData.isIdle = false;
                            requestData.wsCid = connectionId; // 设置WebSocket连接ID
                            sendToWebSocket(connectionId, {
                                type: 'ai_start',
                                reqId: requestData.reqId,
                                body: requestData.req.body,
                                headers: requestData.req.headers,
                            });
                        }
                    } else {
                        // 不支持处理或非空闲状态会回调这里,找到同reqId的请求对象,标记回待处理
                        const requestData = data?.reqId ? activeRequests.get(data.reqId) : null;
                        if (requestData) {
                            requestData.isIdle = true;
                        }
                    }
                    break;

                case 'ai_chunk':
                    console.log(`[WebSocket ${connectionId}] 收到ai_chunk消息 (reqId: ${data.reqId}):`, data.chunk?.substring(0, 100) + '...');
                    // 根据reqId找到对应的请求
                    const requestData = activeRequests.get(data.reqId);
                    if (requestData) {
                        try {
                            // 重置超时定时器
                            requestData.timeoutId && clearTimeout(requestData.timeoutId);
                            requestData.timeoutId = setTimeout(requestData.timeoutHandler, requestData.timeout);
                            // 流式响应：直接写入数据块
                            if (!requestData.res.writableEnded) {
                                requestData.res.write(data.data);
                            }
                            if (data.isEnd) {
                                // 流式响应：结束响应
                                if (!requestData.res.writableEnded) {
                                    requestData.res.end();
                                }
                                // 清理资源
                                activeRequests.delete(data.reqId);
                            }
                        } catch (error) {
                            console.error(`[${data.reqId}] 处理ai_chunk时出错:`, error);
                            sendStreamError(requestData.res, error?.message || 'chunk_error', data.reqId);
                        }
                    } else {
                        console.log(`[WebSocket ${connectionId}] 未找到对应的请求 (reqId: ${data.reqId}) 或请求已取消`);
                    }
                    break;
            }
        } catch (error) {
            console.error(`[WS-${connectionId}] 消息处理错误:`, error);
        }
    });

    ws.on('close', () => {
        console.log(`[WS-${connectionId}] 连接关闭`);
        wsConnections.delete(connectionId);
    });

    ws.on('error', (error) => {
        console.error(`[WS-${connectionId}] 连接错误:`, error);
        wsConnections.delete(connectionId);
    });
});

// 只支持流式请求的OpenAi风格接口
httpApp.post('/v1/chat/completions', async (req, res) => {
    const reqId = Math.random().toString(36).substring(2, 9); // 生成简短的请求 ID
    try {
        const isStreaming = req.body?.stream === true;
        if (!isStreaming) {
            res.status(400).json({
                error: {
                    message: "只支持流式请求，请设置 stream: true",
                    type: "invalid_request_error",
                    code: "stream_required"
                }
            });
            return;
        }

        // 设置流式响应头和状态码
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');

        // 创建请求队列项
        const queueItem = {
            req,
            res,
            reqId,
            wsCid: null,
            isIdle: true,
            timeout: 60000, // 60秒超时
            timeoutId: null, // 超时定时器ID
            timeoutHandler: () => {
                console.log(`[${reqId}] 请求超时 (60秒未响应)`);
                sendStreamError(res, 'timeout_error', reqId);
                activeRequests.delete(reqId);
            }, // 超时处理函数
        };
        //添加超时处理
        queueItem.timeoutId = setTimeout(queueItem.timeoutHandler, queueItem.timeout);
        // 监听响应关闭事件，及时清理资源
        res.on('close', () => {
            console.log(`[${reqId}] 响应关闭 (请求已完成或取消)`);
            // 清理超时定时器
            queueItem.timeoutId && clearTimeout(queueItem.timeoutId);
            // 从队列中移除
            activeRequests.delete(reqId);
            queueItem.wsCid && sendToWebSocket(queueItem.wsCid, { type: 'ai_stop', reqId });
        });
        // 将请求加入队列
        activeRequests.set(reqId, queueItem);
        console.log(`[${reqId}] 请求已加入队列 (当前队列长度: ${activeRequests.size})`);
    } catch (error) {
        console.error(`[${reqId}] API错误:`, error);
        sendStreamError(res, error?.message || 'request_error', reqId);
    }
});

// 启动API服务器
// 尝试读取SSL证书
let httpsOptions = null;
const keyPath = path.resolve(SSL_KEY_PATH);
const certPath = path.resolve(SSL_CERT_PATH);

if (ENABLE_HTTPS && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
        httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        console.log(`SSL证书加载成功: ${keyPath}, ${certPath}`);
    } catch (error) {
        console.error('SSL证书加载失败:', error.message);
        httpsOptions = null;
    }
}

// 启动HTTP服务器 (端口80)
const httpServer = http.createServer(httpApp);
httpServer.listen(HTTP_PORT, API_HOST, () => {
    console.log(`HTTP服务器启动: http://${API_HOST}:${HTTP_PORT}`);
});

// 启动HTTPS服务器 (端口443)
let httpsServer = null;
if (httpsOptions) {
    httpsServer = https.createServer(httpsOptions, httpApp);
    httpsServer.listen(HTTPS_PORT, API_HOST, () => {
        console.log(`HTTPS服务器启动: https://${API_HOST}:${HTTPS_PORT}`);
    });
} else {
    if (!ENABLE_HTTPS) {
        console.log('HTTPS服务器已禁用 (ENABLE_HTTPS=false)');
    } else {
        console.log('未找到SSL证书，跳过HTTPS服务器启动');
        console.log('运行 "npm run generate-cert" 生成证书以启用HTTPS');
        console.log(`证书路径: ${keyPath}, ${certPath}`);
    }
}

function findInMap(map, predicate) {
  for (const [key, value] of map) {
    if (predicate(value, key, map)) {
      return value; // 返回找到的键值对对象
    }
  }
  return undefined; // 未找到时返回 undefined
}

// 发送消息到指定的WebSocket连接
function sendToWebSocket(connectionId, message) {
    const connection = wsConnections.get(connectionId);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

// --- Helper: 发送流式错误块 ---
function sendStreamError(res, errorMessage, reqId) {
    if (!res.writableEnded) {
        // 设置错误状态码
        if (!res.headersSent) {
            res.status(500);
        }
        const errorPayload = { error: { message: `[${reqId}] Server error during streaming: ${errorMessage}`, type: 'server_error' } };
        try {
            // Avoid writing multiple DONE messages if error occurs after normal DONE
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
            if (!res.writableEnded) res.write('data: [DONE]\n\n');
        } catch (e) {
            console.error(`[${reqId}] Error writing stream error chunk:`, e.message);
        } finally {
            if (!res.writableEnded) res.end(); // Ensure stream ends
        }
    }
}

// 进程关闭时的清理处理
function gracefulShutdown(signal) {
    console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);

    // 关闭HTTP服务器
    httpServer.close((err) => {
        if (err) {
            console.error('HTTP服务器关闭时出错:', err);
        } else {
            console.log('HTTP服务器已关闭');
        }
    });

    // 关闭HTTPS服务器
    if (httpsServer) {
        httpsServer.close((err) => {
            if (err) {
                console.error('HTTPS服务器关闭时出错:', err);
            } else {
                console.log('HTTPS服务器已关闭');
            }
        });
    }

    // 关闭WebSocket服务器
    wsServer.close((err) => {
        if (err) {
            console.error('WebSocket服务器关闭时出错:', err);
        } else {
            console.log('WebSocket服务器已关闭');
        }
    });

    // 关闭所有WebSocket连接
    wsConnections.forEach((connection, connectionId) => {
        if (connection.ws.readyState === WebSocket.OPEN) {
            connection.ws.close();
            console.log(`WebSocket连接 ${connectionId} 已关闭`);
        }
    });

    console.log('所有资源已清理完成，进程即将退出');
    process.exit(0);
}

// 监听进程退出信号
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// 监听未捕获的异常
process.on('uncaughtException', (err) => {
    console.error('未捕获的异常:', err);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    gracefulShutdown('unhandledRejection');
});
