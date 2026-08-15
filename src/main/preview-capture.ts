/**
 * Preview Capture — عيون الوكيل على المعاينة
 *
 * يفتح نافذة Electron خفية على رابط المعاينة، ينتظر تنفيذ JavaScript،
 * ثم يلتقط: لقطة شاشة، أخطاء/تحذيرات console، النص المرئي الفعلي،
 * وإحصاءات العناصر. لا يحتاج أي اعتماديات خارجية (بلا Playwright/Puppeteer).
 *
 * ملاحظة: استيراد electron كسول داخل الدالة حتى يبقى هذا الملف قابلًا
 * للتحميل في بيئات الاختبار (node/tsx) حيث لا يتوفر Electron.
 */
import { promises as fs } from 'node:fs'

export interface PreviewCapture {
  url: string
  title: string
  visibleText: string
  consoleErrors: string[]
  consoleWarnings: string[]
  elementStats: { images: number; links: number; buttons: number; inputs: number; headings: number }
  screenshot?: { path: string; width: number; height: number; bytes: number }
  capturedAt: number
}

const PAGE_INFO_SCRIPT = `(() => {
  try {
    return {
      title: document.title || '',
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000),
      images: document.images ? document.images.length : 0,
      links: document.links ? document.links.length : 0,
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input,textarea,select').length,
      headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    }
  } catch (error) { return null }
})()`

const CAPTURE_TOTAL_TIMEOUT_MS = 15_000
const SETTLE_AFTER_LOAD_MS = 1_800

export async function capturePreviewPage(url: string, saveScreenshotTo: string): Promise<PreviewCapture> {
  const { BrowserWindow } = await import('electron')
  return new Promise<PreviewCapture>((resolve, reject) => {
    let win: import('electron').BrowserWindow | null = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const consoleErrors: string[] = []
    const consoleWarnings: string[] = []
    let settled = false
    let settleTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (settleTimer) clearTimeout(settleTimer)
      clearTimeout(totalTimer)
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const finalize = async (): Promise<void> => {
      if (settled || !win || win.isDestroyed()) return
      settled = true
      const target = win
      try {
        const info = await target.webContents.executeJavaScript(PAGE_INFO_SCRIPT, true).catch(() => null) as {
          title?: string; text?: string; images?: number; links?: number; buttons?: number; inputs?: number; headings?: number
        } | null
        let screenshot: PreviewCapture['screenshot']
        try {
          const image = await target.webContents.capturePage()
          if (!image.isEmpty()) {
            const resized = image.getSize().width > 1100 ? image.resize({ width: 1100 }) : image
            const buffer = resized.toJPEG(80)
            await fs.writeFile(saveScreenshotTo, buffer)
            const size = resized.getSize()
            screenshot = { path: saveScreenshotTo, width: size.width, height: size.height, bytes: buffer.byteLength }
          }
        } catch { /* اللقطة اختيارية — النصوص وconsole كافية */ }
        cleanup()
        resolve({
          url,
          title: info?.title ?? '',
          visibleText: (info?.text ?? '').slice(0, 4_000),
          consoleErrors: consoleErrors.slice(0, 20),
          consoleWarnings: consoleWarnings.slice(0, 10),
          elementStats: {
            images: info?.images ?? 0,
            links: info?.links ?? 0,
            buttons: info?.buttons ?? 0,
            inputs: info?.inputs ?? 0,
            headings: info?.headings ?? 0,
          },
          ...(screenshot ? { screenshot } : {}),
          capturedAt: Date.now(),
        })
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const totalTimer = setTimeout(() => { void finalize() }, CAPTURE_TOTAL_TIMEOUT_MS)

    // مستوى console: 0=verbose 1=info 2=warning 3=error
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message ?? '').slice(0, 500)
      if (!text) return
      if (level >= 3) { if (consoleErrors.length < 40) consoleErrors.push(text) }
      else if (level === 2) { if (consoleWarnings.length < 20) consoleWarnings.push(text) }
    })
    win.webContents.once('did-finish-load', () => {
      settleTimer = setTimeout(() => { void finalize() }, SETTLE_AFTER_LOAD_MS)
    })
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      fail(new Error(`فشل تحميل المعاينة (${errorCode}): ${errorDescription}`))
    })
    win.loadURL(url).catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
}
