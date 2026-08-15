/**
 * SettingsModal Component — لوحة إعدادات المزود
 * مستخرج من App.tsx (P1-01)
 */
import { useState, useRef, useEffect } from 'react'
import { KeyRound, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { ProviderSettings } from '../../../shared/types'
import { GO_MODELS, getGoModel } from '../../../shared/models'

interface SettingsModalProps {
  value: ProviderSettings
  close(): void
  saved(value: ProviderSettings): void
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function SettingsModal({ value, close, saved }: SettingsModalProps) {
  const focusRef = useRef<HTMLDivElement>(null)
  useFocusTrap(focusRef, true)
  const [modelId, setModelId] = useState(value.model)
  const [contextWindow, setContextWindow] = useState(value.contextWindow)
  const [apiKey, setApiKey] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [tavilyKey, setTavilyKey] = useState('')
  const [tavilyHas, setTavilyHas] = useState(false)
  const [tavilyBusy, setTavilyBusy] = useState(false)
  const model = getGoModel(modelId)

  function selectModel(id: string) { setModelId(id); setContextWindow(getGoModel(id).contextWindow) }

  async function save() {
    setBusy('save'); setResult('')
    try { const settings = await window.rCode.provider.save({ model: modelId, contextWindow, apiKey: apiKey || undefined }); saved(settings); close() }
    catch (error) { setResult(errorText(error)) }
    finally { setBusy(null) }
  }

  async function test() {
    setBusy('test'); setResult('جارٍ الاختبار...')
    try { setResult(await window.rCode.provider.test({ model: modelId, contextWindow, apiKey: apiKey || undefined })) }
    catch (error) { setResult(errorText(error)) }
    finally { setBusy(null) }
  }

  async function clearKey() {
    if (!window.confirm('حذف مفتاح API المحفوظ من هذا الجهاز؟')) return
    setBusy('save'); setResult('')
    try { saved(await window.rCode.provider.clear()); setApiKey(''); close() }
    catch (error) { setResult(errorText(error)) }
    finally { setBusy(null) }
  }

  useEffect(() => {
    void window.rCode.tavily.get().then((res) => setTavilyHas(res.hasApiKey)).catch(() => {})
  }, [])

  async function saveTavily() {
    setTavilyBusy(true); setResult('')
    try { const res = await window.rCode.tavily.save({ apiKey: tavilyKey }); setTavilyHas(res.hasApiKey); setTavilyKey(''); setResult('تم حفظ مفتاح Tavily') }
    catch (error) { setResult(errorText(error)) }
    finally { setTavilyBusy(false) }
  }

  async function clearTavily() {
    if (!window.confirm('حذف مفتاح Tavily المحفوظ؟')) return
    setTavilyBusy(true); setResult('')
    try { await window.rCode.tavily.clear(); setTavilyHas(false); setResult('تم حذف مفتاح Tavily') }
    catch (error) { setResult(errorText(error)) }
    finally { setTavilyBusy(false) }
  }

  const source = model.contextSource === 'catalog' ? 'موثّق في كتالوج models.dev' : model.contextSource === 'official-threshold' ? 'عتبة منشورة في توثيق OpenCode Go' : 'حد محافظ لأن Go لا ينشر قيمة سياق مؤكدة'

  return (
    <div className="modal-backdrop" onClick={close}>
      <div ref={focusRef} className="modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <header><h2 id="settings-title">إعداد المزود</h2><button aria-label="إغلاق الإعدادات" onClick={close}><X size={18} /></button></header>
        <p>المفتاح يبقى مشفرًا داخل Windows ولا يعاد إلى الواجهة. اترك الحقل فارغًا للاحتفاظ بالمفتاح المحفوظ.</p>
        <label className="field"><KeyRound size={14} /> مفتاح API<input autoFocus dir="ltr" type="password" placeholder={value.hasApiKey ? 'مفتاح محفوظ، اكتب لاستبداله' : 'opencode_...'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
        <hr className="settings-divider" />
        <label className="field">مفتاح Tavily<small>يُستخدم للبحث في الويب عبر Tavily API. اتركه فارغًا للاحتفاظ بالمفتاح المحفوظ.</small><input dir="ltr" type="password" placeholder={tavilyHas ? 'مفتاح محفوظ، اكتب لاستبداله' : 'tvly-dev-...'} value={tavilyKey} onChange={(event) => setTavilyKey(event.target.value)} /></label>
        <div className="tavily-actions">
          {tavilyHas && <button className="btn-ghost danger-text" onClick={() => void clearTavily()} disabled={tavilyBusy}>حذف مفتاح Tavily</button>}
          <button className="btn-ghost" onClick={() => void saveTavily()} disabled={tavilyBusy || (!tavilyKey && !tavilyHas)}>{tavilyBusy ? 'يحفظ...' : 'حفظ Tavily'}</button>
        </div>
        <label className="field">النموذج<select value={modelId} onChange={(event) => selectModel(event.target.value)}>{GO_MODELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{model.apiStyle === 'anthropic' ? 'Anthropic Messages' : model.apiStyle === 'responses' ? 'Responses API' : 'Chat Completions'}</small></label>
        <label className="field">نافذة السياق الفعلية<input dir="ltr" type="number" min={32000} max={2000000} step={1000} value={contextWindow} onChange={(event) => setContextWindow(Math.min(2000000, Math.max(32000, Number(event.target.value) || 32000)))} /><small>الحالي: {contextWindow.toLocaleString('en')} رمز · {source}.</small></label>
        {result && <div className="test-result" role="status">{result}</div>}
        <footer>
          {value.hasApiKey && <button className="btn-ghost danger-text" onClick={() => void clearKey()} disabled={Boolean(busy)}>حذف المفتاح</button>}
          <button className="btn-ghost" onClick={() => void test()} disabled={Boolean(busy) || !apiKey && !value.hasApiKey}>{busy === 'test' ? 'يختبر...' : 'اختبار'}</button>
          <button className="btn-primary" onClick={() => void save()} disabled={Boolean(busy) || !apiKey && !value.hasApiKey}>{busy === 'save' ? 'يحفظ...' : 'حفظ'}</button>
        </footer>
      </div>
    </div>
  )
}
