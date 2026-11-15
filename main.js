/**
 * ServerTap 接口代理（Deno Deploy适配，移除cf专属字段）
 * 功能：将 HTTP 明文接口包装为 HTTPS，供前端监控页面调用
 * 场景：MC 服务器只读监控（CPU/内存/TPS/玩家列表）
 */
// ===================== 配置区（修改仅需改这里） =====================
const CONFIG = (function () {
    const config = {
        // 源站 ServerTap 地址
        UPSTREAM_BASE: 'http://free-c2.tudouai.cn:11316',
        UPSTREAM_HOST: 'free-c2.tudouai.cn:11316',
        // 允许的 HTTP 方法（只读监控只需要 GET）
        ALLOW_METHODS: ['GET', 'OPTIONS'],
        // 允许的接口路径前缀（严格白名单，禁止越权）
        ALLOW_PATH_PREFIXES: ['/v1/server', '/v1/players'],
        // 边缘缓存时长（秒），减轻源站压力（Deno不使用cf缓存，仅保留配置变量）
        CACHE_TTL: 5,
        // 请求超时（毫秒）
        REQUEST_TIMEOUT: 5000,
        // 跨域允许的源，部署后建议替换为你的网页域名，如 'https://xxx.pages.dev'
        CORS_ORIGIN: '*',
        // ServerTap API 密钥配置（可选，没设置留空即可）
        SERVERTAP_API_KEY: '',
        // 密钥请求头名称，部分 ServerTap 版本用 'key'，默认 Authorization
        API_KEY_HEADER: 'Authorization',
        // 密钥值前缀，Bearer 格式留 'Bearer '，无格式留空字符串
        API_KEY_PREFIX: 'Bearer '
    };
    // 深度冻结配置对象，防止运行时被意外篡改
    Object.freeze(config);
    Object.freeze(config.ALLOW_METHODS);
    Object.freeze(config.ALLOW_PATH_PREFIXES);
    return config;
})();
// ===================== 工具函数 =====================
/**
 * 统一返回 JSON 响应（自动带 CORS、安全头）
 */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            ...getCorsHeaders()
        }
    });
}
/**
 * 获取标准 CORS 响应头
 */
function getCorsHeaders() {
    return {
        'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN,
        'Access-Control-Allow-Methods': CONFIG.ALLOW_METHODS.join(', '),
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
}
/**
 * 安全校验：防御路径遍历 + 前缀溢出 + 非法编码
 */
function isPathSafe(path) {
    try {
        // 解码路径，捕获非法百分比编码的 URIError
        const decoded = decodeURIComponent(path);
        // 1. 拦截路径遍历符、空字节注入
        if (decoded.includes('..') || decoded.includes('%00') || decoded.includes('\0')) {
            return false;
        }
        // 2. 严格白名单前缀校验，防止 /v1/server-xxx 这类前缀溢出
        // 规则：路径完全等于白名单，或以「白名单路径 + /」开头
        return CONFIG.ALLOW_PATH_PREFIXES.some(allowPath => {
            return decoded === allowPath || decoded.startsWith(allowPath + '/');
        });
    } catch (e) {
        // 非法编码直接判定为不安全，不抛出异常
        return false;
    }
}
// ===================== 核心逻辑 =====================
export default {
    async fetch(request) {
        // 全链路异常兜底：任何错误都返回标准 JSON，不返回 Worker 默认 500 页
        try {
            // 1. 快速拦截：方法校验
            if (!CONFIG.ALLOW_METHODS.includes(request.method)) {
                return jsonResponse({ error: 'Method Not Allowed' }, 405);
            }
            const url = new URL(request.url);
            const path = url.pathname;
            // 2. 健康检查（快速返回，不打源站）
            if (path === '/health') {
                return jsonResponse({ status: 'ok', timestamp: Date.now() });
            }
            // 3. 跨域预检请求
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: getCorsHeaders()
                });
            }
            // 4. 路径安全校验
            if (!isPathSafe(path)) {
                return jsonResponse({ error: 'Forbidden' }, 403);
            }
            // 5. 构造转发请求（清洗头、注入密钥）
            const targetUrl = CONFIG.UPSTREAM_BASE + path + url.search;
            const forwardHeaders = new Headers();
            // 仅保留必要请求头，彻底清洗 Cookie、Authorization 等敏感头
            const KEEP_HEADERS = ['Accept', 'Accept-Encoding', 'User-Agent'];
            KEEP_HEADERS.forEach(name => {
                const value = request.headers.get(name);
                if (value) forwardHeaders.append(name, value);
            });
            // 设置正确的源站 Host（带端口号）
            forwardHeaders.set('Host', CONFIG.UPSTREAM_HOST);
            // 注入 API 密钥（如果配置了）
            if (CONFIG.SERVERTAP_API_KEY) {
                forwardHeaders.set(
                    CONFIG.API_KEY_HEADER,
                    CONFIG.API_KEY_PREFIX + CONFIG.SERVERTAP_API_KEY
                );
            }
            // 6. 发起转发请求（已移除cf对象）
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: forwardHeaders,
                signal: controller.signal,
                redirect: 'follow'
            });
            clearTimeout(timeoutId);
            // 7. 处理响应（清洗响应头 + 精细化缓存策略）
            const respHeaders = new Headers();
            // 保留源站 Content‑Type，兜底为 JSON
            const contentType = response.headers.get('Content‑Type');
            respHeaders.set('Content‑Type', contentType || 'application/json; charset=utf‑8');
            respHeaders.set('X‑Content‑Type‑Options', 'nosniff');
            // 仅 2xx 成功响应允许缓存；错误响应禁止缓存，避免故障扩散
            if (response.ok) {
                respHeaders.set('Cache‑Control', `public, max‑age=${CONFIG.CACHE_TTL}`);
            } else {
                respHeaders.set('Cache‑Control', 'no‑store');
            }
            // 合并 CORS 头
            Object.entries(getCorsHeaders()).forEach(([key, value]) => {
                respHeaders.set(key, value);
            });
            // 流式透传响应体，内存占用最低
            return new Response(response.body, {
                status: response.status,
                headers: respHeaders
            });
        } catch (err) {
            // 全异常分级处理
            const isTimeout = err.name === 'AbortError';
            const status = isTimeout ? 504 : 502;
            const message = isTimeout ? '上游服务器响应超时' : '接口请求失败';
            return jsonResponse({
                error: isTimeout ? 'Gateway Timeout' : 'Bad Gateway',
                message
            }, status);
        }
    }
};
