/**
 * PreviewPanel — معاينة الموقع عبر iframe
 * تظهر تلقائيًا عند وجود رابط حتى لو الخادم لا يزال يجهز
 */
import { memo, useRef, useState, useEffect } from 'react'
import { RotateCw, AlertTriangle } from 'lucide-react'

interface Props {
  url: string | undefined
  running: boolean
  previewStarting?: boolean
}

export const PreviewPanel = memo(function PreviewPanel({ url, running, previewStarting }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [iframeError, setIframeError] = useState(false)
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!url) {
      setCurrentUrl(null)
      setLoaded(false)
      setIframeError(false)
    } else if (url !== currentUrl) {
      setCurrentUrl(url)
      setLoaded(false)
      setIframeError(false)
    }
  }, [url, currentUrl])

  function handleRefresh() {
    if (iframeRef.current) {
      setLoaded(false)
      setIframeError(false)
      iframeRef.current.src = iframeRef.current.src
    }
  }

  function handleLoad() { setLoaded(true); setIframeError(false) }
  function handleError() { setIframeError(true) }

  // لا رابط ولا خادم — شاشة الانتظار
  if (!currentUrl && !running) {
    return (
      <div className="preview-placeholder">
        <div className="preview-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
          </svg>
        </div>
        <p>شغّل الخادم لمعاينة موقعك هنا</p>
        <small>سيظهر موقعك مباشرة عند التشغيل</small>
      </div>
    )
  }

  // الخادم يجهز لكن الرابط لم يصل بعد — أو الوكيل بدأ تشغيل المعاينة
  if ((!currentUrl && running) || previewStarting) {
    return (
      <div className="preview-placeholder">
        <RotateCw size={28} className="spin" style={{ marginBottom: 8 }} />
        <p>جارٍ تجهيز الخادم...</p>
        <small>سيظهر الموقع هنا خلال لحظات</small>
      </div>
    )
  }

  // لدينا رابط
  return (
    <div className="preview-container">
      <div className="preview-toolbar">
        <span className="preview-url" dir="ltr">{currentUrl}</span>
        <div className="preview-toolbar-actions">
          {iframeError && <span className="preview-error-badge"><AlertTriangle size={12} /> تعذر التحميل</span>}
          <button className="preview-refresh-btn" onClick={handleRefresh} title="تحديث">
            <RotateCw size={13} className={loaded ? '' : 'spin'} />
          </button>
        </div>
      </div>
      <div className="preview-frame-wrap">
        {!loaded && !iframeError && (
          <div className="preview-loading">
            <RotateCw size={20} className="spin" />
            <span>جارٍ تحميل المعاينة...</span>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={currentUrl ?? undefined}
          className={`preview-iframe ${loaded ? 'loaded' : ''}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
          onLoad={handleLoad}
          onError={handleError}
          title="معاينة الموقع"
        />
      </div>
    </div>
  )
})
