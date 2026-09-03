/**
 * 节点处理器模块
 * 处理节点数量统计、批量更新等节点相关API请求
 */

import { StorageFactory } from '../../storage-adapter.js';
import { DEFAULT_SETTINGS, KV_KEY_SETTINGS } from '../config.js';
import { createJsonResponse, createErrorResponse, JSON_BODY_LIMITS, readJsonWithLimit } from '../utils.js';
import { parseNodeList } from '../utils/node-parser.js';
import { getProcessedUserAgent } from '../../utils/format-utils.js';
import { buildFetchProxyUrl } from '../../utils/fetch-proxy-utils.js';
import { isSuspiciousNodeCountDrop } from '../../services/node-cache-service.js';
import { buildSubscriptionFailureEmail, sendEmailNotification } from '../../services/email-notification-service.js';

// 创建用于全局匹配的协议正则表达式
const NODE_PROTOCOL_GLOBAL_REGEX = new RegExp('^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5|socks):\\/\\/', 'gm');

const SUBSCRIPTION_BODY_ERROR_PATTERNS = [
    /failed to fetch remote profile/i,
    /\bbad request\b/i,
    /\bforbidden\b/i,
    /\bunauthori[sz]ed\b/i,
    /\bnot authorized\b/i,
    /\bsubscription protection\b/i,
    /\bstatus\s*[:=]?\s*(400|401|403|404|429|5\d\d)\b/i,
    /\bhttp\s*(400|401|403|404|429|5\d\d)\b/i
];

async function notifySubscriptionUpdateFailure(env, name, url, error, errorType) {
    try {
        const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
        const settings = await storageAdapter.get(KV_KEY_SETTINGS) || DEFAULT_SETTINGS;
        await sendEmailNotification(settings.emailNotification, buildSubscriptionFailureEmail({
            name,
            url,
            error,
            errorType
        }));
    } catch (notificationError) {
        console.warn('[Node Count] Failure email notification failed:', notificationError);
    }
}

function parseBooleanEnvFlag(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
}

function resolveEnvSkipTlsVerify(env) {
    return parseBooleanEnvFlag(env?.MISUB_SKIP_TLS_VERIFY);
}

function safeHost(value) {
    try {
        return new URL(String(value || '')).host || 'unknown-host';
    } catch {
        return 'invalid-url';
    }
}

function summarizeResponseText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function detectSubscriptionBodyError(text) {
    const summary = summarizeResponseText(text);
    if (!summary) return null;

    const hasErrorText = SUBSCRIPTION_BODY_ERROR_PATTERNS.some(pattern => pattern.test(summary));
    if (!hasErrorText) return null;

    const statusMatch = summary.match(/\b(?:status|http)\s*[:=]?\s*(\d{3})\b/i)
        || summary.match(/\b(400|401|403|404|429|5\d\d)\b/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    const message = status ? `HTTP ${status}: ${summary}` : summary;
    const error = new Error(message);
    if (status) error.status = status;
    return error;
}

async function resolveNodeCountFetchCfOptions(env) {
    const envOverride = resolveEnvSkipTlsVerify(env);
    if (envOverride === true) {
        return { cf: { insecureSkipVerify: true } };
    }
    if (envOverride === false) {
        return {};
    }

    try {
        const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
        const settings = await storageAdapter.get(KV_KEY_SETTINGS) || DEFAULT_SETTINGS;
        if (settings?.builtinSkipCertVerify === true) {
            return { cf: { insecureSkipVerify: true } };
        }
    } catch (error) {
        console.warn('[NodeHandler] Failed to load certificate verification setting, using secure default:', error);
    }
    return {};
}

/**
 * 获取订阅节点数量和用户信息
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleNodeCountRequest(request, env) {
    if (request.method !== 'POST') {
        return createErrorResponse('Method Not Allowed', 405);
    }

    try {
        const { url: subUrl, name: subscriptionName, fetchProxy, plusAsSpace, userAgent: customUserAgent, deferPersist = false } = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
        if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//i.test(subUrl)) {
            return createErrorResponse('Invalid or missing url', 400);
        }

        const result = { count: 0, userInfo: null };
        let trafficRequestSucceeded = false;
        let nodeCountRequestSucceeded = false;
        let fetchError = null;

        let requestUrl = subUrl;
        const requestedUserAgent = typeof customUserAgent === 'string' ? customUserAgent.trim() : '';
        const processedUserAgent = requestedUserAgent || getProcessedUserAgent('v2rayN/7.23', subUrl);
        const effectiveFetchProxy = typeof fetchProxy === 'string' ? fetchProxy.trim() : '';
        if (effectiveFetchProxy) {
            requestUrl = buildFetchProxyUrl(effectiveFetchProxy, subUrl, processedUserAgent);
        }
        console.info(
            `[NodeHandler] node_count request target proxyUsed=${Boolean(effectiveFetchProxy)} requestUrl=${requestUrl}`
        );

        try {
            // 使用统一的User-Agent策略
            const fetchOptions = {
                headers: { 'User-Agent': processedUserAgent },
                redirect: "follow"
            };
            // cf 选项需传给 fetch() 而非 Request()：仅在用户显式启用跳过证书验证时传递
            const cfOptions = await resolveNodeCountFetchCfOptions(env);
            const nodeCountResponse = await fetch(new Request(requestUrl, fetchOptions), cfOptions);

            // 1. 处理流量请求的结果
            // 辅助函数：从响应头提取用户信息
            const extractUserInfo = (response) => {
                const userInfoHeader = response.headers.get('subscription-userinfo');
                if (userInfoHeader) {
                    const info = {};
                    userInfoHeader.split(';').forEach(part => {
                        const [key, value] = part.trim().split('=');
                        if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                    });
                    return info;
                }
                return null;
            };

            const hasCompleteTrafficInfo = (info) => ['upload', 'download', 'total']
                .every(key => Number.isFinite(Number(info?.[key])));
            const mergeUserInfo = (existing, incoming) => {
                const merged = { ...(existing || {}), ...(incoming || {}) };
                // 兼容旧版本：曾将正文“剩余流量”错误写为 total=remaining、upload/download=0。
                if (incoming?.remaining !== undefined
                    && Number(existing?.total) === Number(incoming.remaining)
                    && Number(existing?.upload || 0) === 0
                    && Number(existing?.download || 0) === 0) {
                    delete merged.total;
                    delete merged.upload;
                    delete merged.download;
                }
                return merged;
            };

            // 辅助函数：从响应体伪节点名称中解析流量和到期信息
            // 许多机场会在节点列表中嵌入 "剩余流量：985.4 GB" / "套餐到期：2025-12-31" 等伪节点
            const extractUserInfoFromBody = (decodedText) => {
                if (!decodedText) return null;

                const info = {};
                // 解析所有 URI fragment（# 后面的部分）
                const fragments = [];
                const lines = decodedText.split('\n');
                for (const line of lines) {
                    const hashIdx = line.indexOf('#');
                    if (hashIdx !== -1) {
                        try {
                            fragments.push(decodeURIComponent(line.slice(hashIdx + 1).trim()));
                        } catch {
                            fragments.push(line.slice(hashIdx + 1).trim());
                        }
                    }
                }
                const fullText = fragments.join('\n');

                // 解析剩余流量（支持多种格式）
                const trafficPatterns = [
                    /剩余流量[：:]\s*([\d.]+)\s*(GB|MB|TB|KB)/i,
                    /Remaining[：:]\s*([\d.]+)\s*(GB|MB|TB|KB)/i,
                    /剩余[：:]\s*([\d.]+)\s*(GB|MB|TB|KB)/i,
                    /Traffic[：:]\s*([\d.]+)\s*(GB|MB|TB|KB)/i
                ];
                for (const pattern of trafficPatterns) {
                    const match = fullText.match(pattern);
                    if (match) {
                        const value = parseFloat(match[1]);
                        const unit = match[2].toUpperCase();
                        const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
                        const bytes = Math.round(value * (multipliers[unit] || 1));
                        // 正文伪节点给出的是剩余量，不能伪造为套餐总量或已用量。
                        info.remaining = bytes;
                        break;
                    }
                }

                // 解析到期时间
                const expirePatterns = [
                    /(?:套餐到期|到期时间|过期时间|Expire)[：:]\s*(.+)/i
                ];
                for (const pattern of expirePatterns) {
                    const match = fullText.match(pattern);
                    if (match) {
                        const expireStr = match[1].trim();
                        if (/长期有效|永久|永不过期|unlimited|forever/i.test(expireStr)) {
                            // 设置一个非常远的到期时间表示长期有效
                            info.expire = Math.floor(new Date('2099-12-31').getTime() / 1000);
                        } else {
                            // 尝试解析日期
                            const dateMatch = expireStr.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
                            if (dateMatch) {
                                const ts = new Date(dateMatch[1].replace(/\//g, '-')).getTime();
                                if (!isNaN(ts)) {
                                    info.expire = Math.floor(ts / 1000);
                                }
                            }
                        }
                        break;
                    }
                }

                // 只有当至少解析到一项信息时才返回
                return Object.keys(info).length > 0 ? info : null;
            };

            // 使用同一个订阅响应同时解析节点和流量信息，避免同一 token 的并发请求互相限流。
            if (nodeCountResponse.ok) {
                const buffer = await nodeCountResponse.arrayBuffer();
                const text = new TextDecoder('utf-8').decode(buffer);

                // 使用与预览功能相同的节点解析逻辑
                try {
                    // [回退1] 如果之前的流量请求失败或没拿到数据，尝试从节点请求的响应头中提取
                    if (!hasCompleteTrafficInfo(result.userInfo)) {
                        const info = extractUserInfo(nodeCountResponse);
                        if (info) {
                            console.info('[NodeHandler] Successfully extracted traffic info from node response header (Fallback 1).');
                            result.userInfo = mergeUserInfo(result.userInfo, info);
                            trafficRequestSucceeded = true;
                        }
                    }

                    const bodyError = detectSubscriptionBodyError(text);
                    if (bodyError) {
                        fetchError = bodyError;
                        console.warn(`[NodeHandler] Node count response contains upstream error: ${bodyError.message}`);
                        throw bodyError;
                    }

                    // 使用 parseNodeList 函数，与预览功能完全一致
                    const parsedNodes = parseNodeList(text, { plusAsSpace: Boolean(plusAsSpace) });

                    // [回退2] 如果响应头中也没有流量信息，尝试从 body 伪节点中解析
                    // 这在使用 FetchProxy（如 Vercel）时非常重要，因为代理会丢弃上游响应头
                    if (!hasCompleteTrafficInfo(result.userInfo)) {
                        // 需要先解码 base64（如果是 base64 编码的话）
                        let decodedText = text;
                        try {
                            const cleanedText = text.replace(/\s/g, '');
                            let normalized = cleanedText.replace(/-/g, '+').replace(/_/g, '/');
                            const padding = normalized.length % 4;
                            if (padding) normalized += '='.repeat(4 - padding);
                            if (/^[A-Za-z0-9+/=]+$/.test(normalized) && normalized.length >= 20) {
                                const binaryString = atob(normalized);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }
                                decodedText = new TextDecoder('utf-8').decode(bytes);
                            }
                        } catch { /* 已经是明文 */ }

                        const bodyInfo = extractUserInfoFromBody(decodedText);
                        if (bodyInfo) {
                            console.info('[NodeHandler] Successfully extracted traffic info from body fake nodes (Fallback 2).');
                            result.userInfo = mergeUserInfo(result.userInfo, bodyInfo);
                            trafficRequestSucceeded = true;
                        }
                    }

                    if (parsedNodes.length > 0) {
                        result.count = parsedNodes.length;
                        nodeCountRequestSucceeded = true;
                    } else {
                        fetchError = fetchError || new Error('No valid nodes returned from subscription');
                        console.warn(`[NodeHandler] Node count response parsed successfully but contained no valid nodes for ${subUrl}.`);
                    }
                } catch (e) {
                    if (e === fetchError) {
                        console.warn(`[NodeHandler] Skipping node count fallback because upstream returned an error body: ${e.message}`);
                    } else {
                    // 解析失败，尝试简单统计
                    console.error('Node count parse error:', e);

                    try {
                        const cleanedText = text.replace(/\s/g, '');
                        let normalized = cleanedText.replace(/-/g, '+').replace(/_/g, '/');
                        const padding = normalized.length % 4;
                        if (padding) {
                            normalized += '='.repeat(4 - padding);
                        }
                        const base64Regex = /^[A-Za-z0-9+\/=]+$/;
                        if (base64Regex.test(normalized) && normalized.length >= 20) {
                            const binaryString = atob(normalized);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            const processedText = new TextDecoder('utf-8').decode(bytes);
                            const lineMatches = processedText.match(NODE_PROTOCOL_GLOBAL_REGEX);
                            if (lineMatches) {
                                result.count = lineMatches.length;
                                nodeCountRequestSucceeded = true;
                            }
                        } else {
                            const lineMatches = text.match(NODE_PROTOCOL_GLOBAL_REGEX);
                            if (lineMatches) {
                                result.count = lineMatches.length;
                                nodeCountRequestSucceeded = true;
                            }
                        }
                    } catch (error) {
                        // 最后降级到原始文本统计
                        console.debug('[NodeHandler] Failed to decode node count response, falling back to raw text:', error);
                        const lineMatches = text.match(NODE_PROTOCOL_GLOBAL_REGEX);
                        if (lineMatches) {
                            result.count = lineMatches.length;
                            nodeCountRequestSucceeded = true;
                        }
                    }
                    }
                }
            } else {
                if (!fetchError) fetchError = new Error(`HTTP ${nodeCountResponse.status}: ${nodeCountResponse.statusText}`);
                console.error('Node count request returned error:', nodeCountResponse.status);
            }

            // 只有首个响应未携带流量信息时，才以兼容 UA 串行补偿一次。
            if (nodeCountRequestSucceeded && !hasCompleteTrafficInfo(result.userInfo)) {
                try {
                    const trafficResponse = await fetch(new Request(requestUrl, {
                        headers: { 'User-Agent': 'clash-verge/v2.4.3' },
                        redirect: 'follow'
                    }), cfOptions);
                    if (trafficResponse.ok) {
                        const info = extractUserInfo(trafficResponse);
                        if (info) {
                            result.userInfo = mergeUserInfo(result.userInfo, info);
                            trafficRequestSucceeded = true;
                        }
                    }
                } catch (trafficError) {
                    console.warn('[NodeHandler] Traffic fallback request failed:', trafficError?.message || trafficError);
                }
            }

            // 检查是否两个请求都失败了
            if (!nodeCountRequestSucceeded) {
                // 两个请求都失败,返回错误信息
                let errorType = 'fetch_failed';
                let errorMessage = 'No valid nodes returned from subscription';

                if (fetchError) {
                    if (fetchError.name === 'AbortError' || fetchError.message?.includes('timeout')) {
                        errorType = 'timeout';
                        errorMessage = '订阅请求超时';
                    } else if (fetchError.message?.includes('HTTP')) {
                        errorType = 'server';
                        errorMessage = fetchError.message;
                    } else if (fetchError.message?.includes('network') || fetchError.message?.includes('fetch')) {
                        errorType = 'network';
                        errorMessage = '网络连接失败';
                    } else if (fetchError.message) {
                        errorMessage = fetchError.message;
                    }
                }

                console.error(
                    `[Node Count] Node count update failed proxyUsed=${Boolean(effectiveFetchProxy)} requestUrl=${requestUrl}: ${errorMessage}`
                );
                void notifySubscriptionUpdateFailure(env, subscriptionName || subUrl, subUrl, errorMessage, errorType);
                return createJsonResponse({
                    success: false,
                    error: errorMessage,
                    errorType: errorType,
                    status: fetchError?.status || null,
                    count: 0,
                    userInfo: result.userInfo || null
                });
            }

            // 请求成功且至少获取到节点或订阅信息时才更新数据库；避免解析暂时为 0 时丢失流量/到期数据。
            if (result.count > 0 || result.userInfo) {
                const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
                const originalSubs = typeof storageAdapter.getAllSubscriptions === 'function'
                    ? await storageAdapter.getAllSubscriptions()
                    : await storageAdapter.get('misub_subscriptions_v1') || [];
                const subToUpdate = originalSubs.find(s => s.url === subUrl);

                if (subToUpdate) {
                    const knownNodeCount = Math.max(
                        Number(subToUpdate.lastGoodNodeCount) || 0,
                        Number(subToUpdate.nodeCount) || 0
                    );

                    if (result.count === 0 && knownNodeCount > 0) {
                        result.count = knownNodeCount;
                        result.protected = true;
                    }

                    // This endpoint is also called automatically while loading a subscription
                    // group. A truncated Base64 prefix may still parse as one node, so preserve
                    // the last healthy count instead of destroying the shrink-protection baseline.
                    if (isSuspiciousNodeCountDrop(knownNodeCount, result.count)) {
                        console.warn(`[Node Count] Rejecting suspicious node-count drop for ${subUrl} (${knownNodeCount} known -> ${result.count} fetched)`);
                        result.count = knownNodeCount;
                        result.protected = true;
                        result.lastGoodNodeCount = knownNodeCount;
                        return createJsonResponse({
                            success: true,
                            data: result
                        });
                    }

                    if (deferPersist) {
                        console.debug(`[Node Count] Deferring persistence for batch refresh: ${subUrl}`);
                    } else if (typeof storageAdapter.updateSubscriptionById === 'function') {
                        await storageAdapter.updateSubscriptionById(subToUpdate.id, current => ({
                            ...current,
                            nodeCount: result.count,
                            ...(result.count >= 10 ? { lastGoodNodeCount: result.count } : {}),
                            userInfo: result.userInfo ? mergeUserInfo(current.userInfo, result.userInfo) : current.userInfo || null,
                            lastError: null,
                            lastUpdate: new Date().toISOString()
                        }));
                    } else {
                        const allSubs = JSON.parse(JSON.stringify(originalSubs));
                        const target = allSubs.find(s => s.url === subUrl);
                        if (target) {
                            target.nodeCount = result.count;
                            if (result.count >= 10) target.lastGoodNodeCount = result.count;
                            target.userInfo = result.userInfo ? mergeUserInfo(target.userInfo, result.userInfo) : target.userInfo || null;
                            target.lastError = null;
                            target.lastUpdate = new Date().toISOString();
                            await storageAdapter.put('misub_subscriptions_v1', allSubs);
                        }
                    }
                }
            } else {
                // 如果 count 为 0 且没有用户信息，但请求成功了（可能机场真的没节点），也要更新错误状态（可选，此处暂不作为错误）
            }

        } catch (e) {
            // 节点计数处理错误
            console.error('Node count processing error:', e);
            return createJsonResponse({
                success: false,
                error: `处理失败: ${e.message}`,
                errorType: 'processing_error'
            });
        }

        return createJsonResponse({
            success: true,
            data: result
        });
    } catch (e) {
        return createErrorResponse(`获取节点数量失败: ${e.message}`, 500);
    }
}

/**
 * 批量更新节点信息
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleBatchUpdateNodesRequest(request, env) {
    if (request.method !== 'POST') {
        return createJsonResponse('Method Not Allowed', 405);
    }

    try {
        const requestData = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
        const { subscriptionIds, userAgent = 'MiSub-Batch-Update/1.0' } = requestData;

        // 验证必需参数
        if (!subscriptionIds || !Array.isArray(subscriptionIds) || subscriptionIds.length === 0) {
            return createJsonResponse({
                error: '请提供要更新的订阅ID列表'
            }, 400);
        }

        const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
        const allSubscriptions = await storageAdapter.get('misub_subscriptions_v1') || [];

        // 过滤出要更新的订阅
        const targetSubscriptions = allSubscriptions.filter(sub =>
            subscriptionIds.includes(sub.id) && sub.enabled && sub.url && sub.url.startsWith('http')
        );

        if (targetSubscriptions.length === 0) {
            return createJsonResponse({
                error: '没有找到需要更新的有效订阅'
            }, 400);
        }

        // 单个订阅超时时间（毫秒）
        const SINGLE_SUB_TIMEOUT = 15000;

        // 并行获取所有订阅的节点（带超时）
        const updatePromises = targetSubscriptions.map(async (subscription) => {
            try {
                const effectiveUserAgent = (typeof subscription.customUserAgent === 'string' && subscription.customUserAgent.trim())
                    || getProcessedUserAgent(userAgent, subscription.url);
                let requestUrl = subscription.url;
                if (subscription.fetchProxy && typeof subscription.fetchProxy === 'string' && subscription.fetchProxy.trim()) {
                    requestUrl = buildFetchProxyUrl(subscription.fetchProxy, subscription.url, effectiveUserAgent);
                }

                // 使用 Promise.race 实现超时
                const fetchPromise = fetch(new Request(requestUrl, {
                    headers: { 'User-Agent': effectiveUserAgent },
                    redirect: "follow"
                }), { cf: { insecureSkipVerify: true } });

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('请求超时')), SINGLE_SUB_TIMEOUT)
                );

                const response = await Promise.race([fetchPromise, timeoutPromise]);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const text = await response.text();

                // 使用与预览功能相同的解码和节点统计逻辑
                let nodeCount = 0;
                try {
                    // 使用 parseNodeList 函数，与预览功能完全一致
                    const parsedNodes = parseNodeList(text);
                    nodeCount = parsedNodes.length;
                } catch (e) {
                    // 解码失败，尝试简单统计
                    console.error('Batch update decode error:', e);
                    try {
                        const cleanedText = text.replace(/\s/g, '');
                        const base64Regex = /^[A-Za-z0-9+\/=]+$/;
                        if (base64Regex.test(cleanedText) && cleanedText.length >= 20) {
                            const binaryString = atob(cleanedText);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            const processedText = new TextDecoder('utf-8').decode(bytes);
                            nodeCount = (processedText.match(NODE_PROTOCOL_GLOBAL_REGEX) || []).length;
                        } else {
                            nodeCount = (text.match(NODE_PROTOCOL_GLOBAL_REGEX) || []).length;
                        }
                    } catch {
                        // 如果都失败，使用原始文本进行统计
                        nodeCount = (text.match(NODE_PROTOCOL_GLOBAL_REGEX) || []).length;
                    }
                }

                return {
                    subscriptionId: subscription.id,
                    subscriptionName: subscription.name,
                    success: true,
                    nodeCount,
                    error: null,
                    lastUpdated: new Date().toISOString()
                };
            } catch (e) {
                return {
                    subscriptionId: subscription.id,
                    subscriptionName: subscription.name,
                    success: false,
                    nodeCount: 0,
                    error: e.message,
                    lastUpdated: new Date().toISOString()
                };
            }
        });

        // 等待所有更新完成
        const results = await Promise.all(updatePromises);

        const successfulResults = results.filter(result => result.success);
        if (successfulResults.length > 0) {
            const updatedAt = new Date().toISOString();
            await Promise.all(successfulResults.map(result =>
                typeof storageAdapter.updateSubscriptionById === 'function'
                    ? storageAdapter.updateSubscriptionById(result.subscriptionId, current => ({
                        ...current,
                        nodeCount: result.nodeCount,
                        ...(result.nodeCount >= 10 ? { lastGoodNodeCount: result.nodeCount } : {}),
                        lastError: null,
                        lastUpdate: updatedAt
                    }))
                    : null
            ));
        }

        // 统计结果
        const successfulUpdates = results.filter(r => r.success);
        const totalNodes = successfulUpdates.reduce((sum, r) => sum + r.nodeCount, 0);

        return createJsonResponse({
            success: true,
            results,
            summary: {
                totalSubscriptions: targetSubscriptions.length,
                successfulUpdates: successfulUpdates.length,
                failedUpdates: targetSubscriptions.length - successfulUpdates.length,
                totalNodes
            }
        });
    } catch (e) {
        return createErrorResponse(`批量更新失败: ${e.message}`, 500);
    }
}

/**
 * 清理无效节点（移除重复节点、无效节点等）
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleCleanNodesRequest(request, env) {
    if (request.method !== 'POST') {
        return createJsonResponse('Method Not Allowed', 405);
    }

    try {
        const requestData = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
        const { profileId } = requestData;

        const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));

        if (profileId) {
            // 清理指定订阅组的节点
            const { handleSubscriptionNodesRequest } = await import('../subscription-handler.js');
            const previewResult = await handleSubscriptionNodesRequest(request, env);

            if (!previewResult.success) {
                return createErrorResponse(`获取订阅组节点失败: ${previewResult.error}`, 400);
            }

            // 去重处理
            const uniqueNodes = [];
            const seenUrls = new Set();

            previewResult.nodes.forEach(node => {
                if (node.url && !seenUrls.has(node.url)) {
                    seenUrls.add(node.url);
                    uniqueNodes.push(node);
                }
            });

            return createJsonResponse({
                success: true,
                profileId,
                originalCount: previewResult.nodes.length,
                cleanedCount: uniqueNodes.length,
                removedDuplicates: previewResult.nodes.length - uniqueNodes.length,
                cleanedNodes: uniqueNodes
            });
        } else {
            // 清理所有订阅的节点（全局清理）
            return createErrorResponse('全局节点清理功能暂未实现，请指定profileId', 501);
        }
    } catch (e) {
        return createErrorResponse(`节点清理失败: ${e.message}`, 500);
    }
}

/**
 * 节点健康检查（测试节点连通性）
 * @param {Object} request - HTTP请求对象
 * @param {Object} env - Cloudflare环境对象
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleHealthCheckRequest(request, env) {
    if (request.method !== 'POST') {
        return createJsonResponse('Method Not Allowed', 405);
    }

    try {
        const requestData = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
        const { nodeUrls, timeout = 5000 } = requestData;

        if (!nodeUrls || !Array.isArray(nodeUrls) || nodeUrls.length === 0) {
            return createJsonResponse({
                error: '请提供要检查的节点URL列表'
            }, 400);
        }

        // 在Cloudflare环境中，我们只能进行基本的格式检查
        // 实际的连通性测试需要在外部进行
        const healthResults = nodeUrls.map(nodeUrl => {
            try {
                const url = new URL(nodeUrl);
                const isValidProtocol = ['ss:', 'ssr:', 'vmess:', 'vless:', 'trojan:', 'hysteria:', 'hysteria2:', 'tuic:', 'snell:'].includes(url.protocol);

                return {
                    nodeUrl,
                    healthy: isValidProtocol,
                    error: isValidProtocol ? null : '不支持的协议',
                    checkTime: new Date().toISOString()
                };
            } catch (e) {
                return {
                    nodeUrl,
                    healthy: false,
                    error: '无效的URL格式',
                    checkTime: new Date().toISOString()
                };
            }
        });

        const healthyNodes = healthResults.filter(r => r.healthy).length;

        return createJsonResponse({
            success: true,
            results: healthResults,
            summary: {
                totalNodes: nodeUrls.length,
                healthyNodes,
                unhealthyNodes: nodeUrls.length - healthyNodes
            }
        });
    } catch (e) {
        return createJsonResponse({
            error: `健康检查失败: ${e.message}`
        }, 500);
    }
}
