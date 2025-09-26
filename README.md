# 项目说明
大多数AI服务都提供网页版免费使用，但日常使用避免不了复制粘贴、在多个窗口切换等步骤, 影响效率, 所以实现一个兼容OpenAI标准的API代理服务器，扩展这些网页的功能, 也方便将其集成到第三方应用中。

## 架构说明
**HTTP API** --> **WebSocket 中继** <--> **Tampermonkey 脚本** --> **AI 网页服务**（AI Studio、腾讯元宝等）
1. 接收标准的 HTTP API 请求（兼容 OpenAI 格式）
2. 通过 WebSocket 将请求转发给浏览器脚本
3. 浏览器脚本自动操作网页界面, 并将结果通过 WebSocket 返回给服务器
4. 将从 WebSocket 获取到的结果以 OpenAI 兼容的流式格式返回给客户端

## 已完成的浏览器脚本
- [x] AI Studio
- [ ] TX元宝
- [ ] 更多

## 安装使用

**安装依赖并启动**
```bash
# 安装依赖
npm install
#启动服务
npm start
```
- 可修改`.env`文件更改`websocket端口`和`http服务ip地址`,
- 第三方应用配置 BaseUrl `http(s)://ip地址/v1`
- 对于不支持配置 BaseUrl 的应用, 可以修改host把http服务的ip解析到openAi的api请求域名 (注意: https需要证书, 在`.env`配置开启)
- 不建议部署到公网

**使用流程:**
1. 浏览器安装`Tampermonkey插件`, 在浏览器扩展设置页面中允许运行用户脚本
2. 安装脚本到Tampermonkey插件中
3. 打开对应的网站配置 websocket 地址和端口, 例如: `http://localhost:8080`
4. 调用 api 或者配置到第三方应用

**请求示例:**

只支持流式请求, stream必须为true

```bash
curl -X POST http://127.0.0.1/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": true
  }'
```

## 浏览器脚本开发规范

1. 提供配置websocket的配置表单保存配置
2. 创建连接websocket, 并定时发送`idle_status`空闲状态报告
3. 监听websocket消息, 在收到`ai_start`时操作页面获取响应, 并通过websocket发送`ai_chunk`消息,该消息的数据会完整的在SSE的chunk中返回,不能处理需要回应`idle_status`
4. 在收到`ai_stop`时, 操作页面停止响应,并继续定时发送空闲状态报告

### 客户端 -> 服务器

#### 空闲状态报告
```json
{
  "type": "idle_status",
  "isIdle": true,//是否空闲
  "model": ".*",//当前网页支持处理的模型名称,通过正则表达式验证,验证通过才会处理对应模型的请求,
  "reqId": "req_abc123"//队列的请求id, 用于匹配对应的请求,当收到ai_start时不是空闲中需要上报idle_status回去
}
```

#### AI 响应块（流式数据）
```json
{
  "type": "ai_chunk",
  "data": "data: {\"id\":\"chatcmpl_1734567890\",\"object\":\"chat.completion.chunk\",\"created\":1734567890,\"model\":\"gemini-1.5-pro-002\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello! I'm doing well, thank you for asking.\"},\"finish_reason\":null}]}\n\n",//响应回去的流式数据
  "isEnd": false,//是否结束整个流式请求
  "reqId": "req_abc123"//队列的请求id, 用于匹配对应的请求
}
```

### 服务器 -> 客户端

#### 开始获取流式数据
```json
{
  "type": "ai_start",
  "reqId": "req_abc123",//队列的请求id, 用于匹配对应的请求
  "body": {...},//请求体, 与http api请求体一致
  "headers": {...}//请求头, 与http api请求头一致
}
```

#### 停止获取流式数据
```json
{
  "type": "ai_stop",
  "reqId": "abc123"//队列的请求id, 用于匹配对应的请求
}
```
