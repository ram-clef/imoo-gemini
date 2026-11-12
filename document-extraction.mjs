import { randomUUID } from 'node:crypto';
import { postHttps, upstreamErrorCode, upstreamTimeoutMs } from './upstream-https.mjs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { extractionFields as fields } from './public/workflow.js';
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
const primary = { pan: 'panNo', udyam: 'udyamNo', acc: 'accountNumber', fssai: 'number', gst: 'gstNumber' };
const prompt = (await readFile(new URL('./prompt.txt', import.meta.url), 'utf8')).replace(/^\uFEFF/, '');

async function analyze(file, apiKey, instructions) {
  const id = randomUUID().slice(0, 8);
  const started = Date.now();
  const image = Buffer.from(await file.arrayBuffer());
  const body = Buffer.from(JSON.stringify({
    contents: [{ parts: [
      { text: instructions },
      { inlineData: { mimeType: file.type, data: image.toString('base64') } }
    ] }],
    generationConfig: { responseMimeType: 'application/json' }
  }));
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
  const log = (event, data) => console.log('[Gemini ' + id + '] ' + event + ' ' + JSON.stringify(data));
  log('request', { mimeType: file.type, bytes: image.length, timeoutMs: upstreamTimeoutMs });

  const signal = AbortSignal.timeout(upstreamTimeoutMs);
  let response;
  try {
    response = await postHttps(endpoint, headers, body, signal);
    if (response.status === 503) {
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : 2000;
      if (Date.now() - started + waitMs < upstreamTimeoutMs) {
        log('retry', { status: 503, delayMs: waitMs });
        await delay(waitMs, undefined, { signal });
        response = await postHttps(endpoint, headers, body, signal);
      }
    }
  } catch (error) {
    const code = upstreamErrorCode(error);
    log('network error', { code, elapsedMs: Date.now() - started });
    throw Error('Could not complete the Gemini request (' + code + '). See Gemini log ' + id + '.');
  }

  const result = await response.json().catch(() => null);
  const candidate = result?.candidates?.[0];
  log('response', {
    status: response.status,
    providerStatus: result?.error?.status,
    elapsedMs: Date.now() - started,
    finishReason: candidate?.finishReason,
    blockReason: result?.promptFeedback?.blockReason
  });
  if (response.status === 503) {
    throw Error('Gemini is temporarily unavailable. Try again shortly. See Gemini log ' + id + '.');
  }
  if (!response.ok) {
    throw Error('Gemini returned HTTP ' + response.status + '. See Gemini log ' + id + '.');
  }
  const text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('');
  let parsed;
  try { parsed = JSON.parse(text ?? ''); }
  catch { throw Error('Gemini did not return valid JSON. See Gemini log ' + id + '.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error('Gemini did not return the expected extraction JSON. See Gemini log ' + id + '.');
  }
  return parsed;
}

export async function classifyDocuments(files, env, collage) {
  const extraction = { pan: null, udyam: null, acc: null, fssai: null, gst: null, otherDocs: {} };
  const unclassified = [];
  const conflicts = [];
  const instructions = collage ? prompt + '\n\n' +
    'The attachment is one collage. Its tiles have labels Source 1 through Source ' + files.length + '. ' +
    'Return exactly one JSON object with a sources array. Each entry must have sourceNumber (an integer copied from the label) ' +
    'and the pan, udyam, acc, fssai, gst, otherDocs and conflicts fields described above. ' +
    'Return one entry per source, combining pages with the same Source number. Never mix fields between different sources. ' +
    'Include empty/null values for unreadable sources. Do not put document fields at the top level.' : prompt;
  if (files.length > 1 && !collage) throw Error('Combine the selected documents before extraction.');
  const result = await analyze(collage || files[0], env.GEMINI_API_KEY, instructions);
  const sources = new Map();
  if (collage) {
    if (!Array.isArray(result.sources)) throw Error('Gemini did not return source labels for the collage.');
    for (const source of result.sources) {
      const number = source?.sourceNumber;
      if (!Number.isInteger(number) || number < 1 || number > files.length || sources.has(number)) {
        throw Error('Gemini returned an invalid or duplicate source label.');
      }
      sources.set(number, source);
    }
  } else {
    sources.set(1, result);
  }
  for (const index of files.keys()) {
    const parsed = sources.get(index + 1);
    if (!parsed) {
      unclassified.push(index);
      continue;
    }
    if (Array.isArray(parsed.conflicts) && parsed.conflicts.length) {
      conflicts.push('Conflicting document IDs found in file ' + (index + 1) + '.');
    }
    const other = parsed.otherDocs && typeof parsed.otherDocs === 'object' ? Object.entries(parsed.otherDocs) : [];
    if (other.length) extraction.otherDocs['file' + (index + 1)] = { sourceFileIndexes: [index], documents: Object.fromEntries(other) };
    let identified = false;
    for (const [type, keys] of Object.entries(fields)) {
      const item = parsed[type];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      identified = true;
      const current = extraction[type] ??= { sourceFileIndexes: [] };
      const id = primary[type];
      const nextId = typeof item[id] === 'string' ? item[id].trim() : '';
      if (current[id] && nextId && current[id].toUpperCase() !== nextId.toUpperCase()) {
        conflicts.push('Different ' + type + ' identifiers were found across files.');
        continue;
      }
      current.sourceFileIndexes.push(index);
      for (const key of keys) {
        if (!current[key] && typeof item[key] === 'string' && item[key].trim()) current[key] = item[key].trim().slice(0, 500);
      }
    }
    if (!identified && !other.length) unclassified.push(index);
  }
  return { extraction, unclassified, conflicts };
}
