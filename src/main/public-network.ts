import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import { isBlockedAddress, isBlockedHost } from './tools'

const MAX_REDIRECTS = 3
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000

export async function assertPublicHttpsUrl(value: string | URL): Promise<URL> {
  const url = typeof value === 'string' ? new URL(value) : new URL(value.toString())
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('يسمح فقط برابط HTTPS عام دون بيانات اعتماد')
  if (isBlockedHost(url.hostname)) throw new Error('لا يسمح بالوصول إلى شبكة محلية أو عنوان خاص')
  const addresses = await publicAddresses(url.hostname)
  if (!addresses.length) throw new Error('تعذر التحقق من عنوان خادم الشبكة')
  return url
}

export async function requestPublicHttps(value: string | URL, init: { method?: string; headers?: HeadersInit; body?: string; signal?: AbortSignal } = {}, options: { maxResponseBytes?: number; maxRedirects?: number } = {}): Promise<Response> {
  let url = await assertPublicHttpsUrl(value)
  for (let redirect = 0; redirect <= (options.maxRedirects ?? MAX_REDIRECTS); redirect++) {
    const response = await requestOne(url, init, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    if (!location || redirect >= (options.maxRedirects ?? MAX_REDIRECTS)) throw new Error('تجاوز خادم الشبكة حد إعادة التوجيه')
    const next = new URL(location, url)
    if (next.protocol !== 'https:') throw new Error('إعادة التوجيه إلى HTTP غير مسموحة')
    url = await assertPublicHttpsUrl(next)
  }
  throw new Error('تعذر إكمال طلب الشبكة العام')
}

async function publicAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (isIP(hostname)) {
    const family = isIP(hostname) as 4 | 6
    if (isBlockedAddress(hostname)) throw new Error('عنوان الشبكة خاص أو محلي')
    return [{ address: hostname, family }]
  }
  const records = await lookup(hostname, { all: true, verbatim: true })
  const addresses = records.map((record) => ({ address: record.address, family: record.family as 4 | 6 })).filter((record) => !isBlockedAddress(record.address))
  if (addresses.length !== records.length) throw new Error('اسم المضيف يحل إلى عنوان خاص أو محلي')
  return addresses
}

async function requestOne(url: URL, init: { method?: string; headers?: HeadersInit; body?: string; signal?: AbortSignal }, maxBytes: number): Promise<Response> {
  const addresses = await publicAddresses(url.hostname)
  const selected = addresses[0]
  if (!selected) throw new Error('لا يوجد عنوان عام صالح')
  if (init.signal?.aborted) throw new DOMException('تم إلغاء طلب الشبكة', 'AbortError')
  const headers = new Headers(init.headers)
  return new Promise((resolveResponse, reject) => {
    let settled = false
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    init.signal?.addEventListener('abort', abort, { once: true })
    const request = httpsRequest({
      protocol: 'https:', hostname: url.hostname, port: url.port || 443,
      path: `${url.pathname}${url.search}`, method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()), servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    }, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes <= maxBytes) chunks.push(chunk)
        else if (!settled) { settled = true; request.destroy(new Error(`استجابة الشبكة أكبر من الحد (${maxBytes} بايت)`)); reject(new Error(`استجابة الشبكة أكبر من الحد (${maxBytes} بايت)`)) }
      })
      response.once('error', (error) => finish(undefined, error))
      response.once('end', () => {
        if (settled) return
        const responseHeaders = headersFromNode(response.headers)
        finish(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: responseHeaders }))
      })
    })
    const timer = setTimeout(() => { request.destroy(new Error('انتهت مهلة الشبكة العامة')); finish(undefined, new Error('انتهت مهلة الشبكة العامة')) }, 60_000)
    const onAbort = (): void => { request.destroy(); finish(undefined, new DOMException('تم إلغاء طلب الشبكة', 'AbortError')) }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    request.once('error', (error) => finish(undefined, error))
    if (init.body) request.write(init.body)
    request.end()

    function finish(response: Response | undefined, error?: Error): void {
      if (settled) return
      settled = true; clearTimeout(timer); init.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort)
      if (error) reject(error); else if (response) resolveResponse(response)
    }
  })
}

function headersFromNode(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) if (value !== undefined) result.set(key, Array.isArray(value) ? value.join(', ') : value)
  return result
}
