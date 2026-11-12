import { request as httpsRequest } from 'node:https';

export const upstreamTimeoutMs = 150_000;
const maxResponseBytes = 4 * 1024 * 1024;

export function postHttps(url, headers, body, signal = AbortSignal.timeout(upstreamTimeoutMs)) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST',
      family: 4,
      signal,
      headers: { ...headers, 'Content-Length': body.byteLength }
    }, async response => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > maxResponseBytes) throw Error('Upstream response is too large.');
          chunks.push(chunk);
        }
        const status = response.statusCode;
        const content = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const key of ['content-type', 'retry-after', 'x-request-id']) {
          if (typeof response.headers[key] === 'string') responseHeaders.set(key, response.headers[key]);
        }
        resolve(new Response(content, { status, headers: responseHeaders }));
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.end(body);
  });
}

export function upstreamErrorCode(error) {
  if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') return 'TimeoutError';
  return error.cause?.code || error.code || error.name;
}
