/**
 * 出站地址安全策略（供模型服务、搜索、解析、语音等自定义端点共用）。
 *
 * 与使用须知第 3 节的承诺一致：**远程端点只允许 HTTPS；HTTP 仅允许本机或局域网地址**。
 * 以前只有模型服务做了这项校验，搜索/解析/语音只校验协议，用户填 `http://<公网IP>`
 * 时 API Key、页面 PNG 与录音会明文出站，属于"告知与实现不符"。
 *
 * 这里只做纯字符串/URL 判断，不发起请求，便于单测与各处复用。
 */

/** 是否本机或局域网主机（不含公网域名与公网 IP）。 */
export function isLocalOrLanHost(host: string): boolean {
  const value = (host ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!value) return false;
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.endsWith('.local')) {
    return true;
  }
  if (/^127\./.test(value)) return true;
  if (/^10\./.test(value) || /^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  return false;
}

/**
 * 断言地址满足 HTTPS 要求：`http:` 只允许本机/局域网主机，其余必须 `https:`。
 * 调用方负责先把字符串解析成 URL（或捕获这里的异常并换成自己的错误文案）。
 */
export function assertEndpointTransport(rawUrl: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label}格式不正确`);
  }
  if (parsed.protocol === 'http:' && !isLocalOrLanHost(parsed.hostname)) {
    throw new Error(`${label}必须使用 https；http 仅允许本机或局域网地址`);
  }
}
