/**
 * Sentry Error Monitoring (P2-06)
 * مراقبة أخطاء اختيارية — لا تؤثر على عمل التطبيق أبداً
 * تفعّل فقط عند وجود SENTRY_DSN في متغيرات البيئة
 */
import * as Sentry from '@sentry/electron/main'
import { app } from 'electron'

let sentryEnabled = false

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN?.trim()

  // لا تفعّل بدون DSN — صفر تأثير على الأداء
  if (!dsn) return false

  try {
    Sentry.init({
      dsn,
      release: `code-agent@${app.getVersion()}`,
      environment: app.isPackaged ? 'production' : 'development',
      // لا نرسل بيانات المستخدم أبداً
      sendDefaultPii: false,
      // نرسل الأعطال فقط — لا تتبع أداء أو جلسات
      tracesSampleRate: 0,
      // تجاهل أخطاء متوقعة
      ignoreErrors: [
        'تم الإلغاء',
        'ألغى المستخدم التشغيل',
        'DOMException: تم الإلغاء',
      ],
    })
    sentryEnabled = true
    console.info('[sentry] مراقبة الأعطال مفعّلة')
    return true
  } catch (error) {
    console.warn('[sentry] فشل التهيئة:', error instanceof Error ? error.message : String(error))
    return false
  }
}

export function isSentryEnabled(): boolean {
  return sentryEnabled
}

/** التقاط استثناء وإرساله إلى Sentry (لا يرمي ولا يؤثر على سير التطبيق) */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryEnabled) return
  try {
    Sentry.captureException(error, {
      extra: context,
      tags: {
        platform: process.platform,
        arch: process.arch,
        packaged: String(app.isPackaged),
        version: app.getVersion(),
      },
    })
  } catch { /* فشل صامت — المراقبة لا توقف التطبيق أبداً */ }
}
