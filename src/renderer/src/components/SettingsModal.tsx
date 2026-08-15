/**
 * SettingsModal Component — لوحة إعدادات المزود
 * مستخرج من App.tsx (P1-01)
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { KeyRound, X, Plus, Pencil, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { ProviderSettings, CustomProviderSettings } from '../../../shared/types'
import { GO_MODELS, getGoModel } from '../../../shared/models'
import { AddProviderModal } from './AddProviderModal'

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
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState('')
  const [tavilyKey, setTavilyKey] = useState('')
  const [tavilyHas, setTavilyHas] = useState(false)
  const [tavilyBusy, setTavilyBusy] = useState(false)
  const model = getGoModel(modelId)

  // Custom providers state
  const [customProviders, setCustomProviders] = useState<CustomProviderSettings[]>([])
  const [showAddProvider, setShowAddProvider] = useState(false)
  const [editingProvider, setEditingProvider] = useState<CustomProviderSettings | undefined>()
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

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
    void window.rCode.customProviders.list().then((providers) => setCustomProviders(providers)).catch(() => {})
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

  const loadCustomProviders = useCallback(async () => {
    try { setCustomProviders(await window.rCode.customProviders.list()) } catch {}
  }, [])

  async function deleteCustomProvider(id: string) {
    if (!window.confirm('حذف هذا المزود المخصص؟')) return
    try { await window.rCode.customProviders.remove(id); await loadCustomProviders() }
    catch (error) { setResult(errorText(error)) }
  }

  function toggleExpand(id: string) {
    setExpandedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const source = model.contextSource === 'catalog' ? 'موثّق في كتالوج models.dev' : model.contextSource === 'official-threshold' ? 'عتبة منشورة في توثيق OpenCode Go' : 'حد محافظ لأن Go لا ينشر قيمة سياق مؤكدة'

  async function checkForUpdates() {
    setUpdateBusy(true); setUpdateResult('جارٍ التحقق...')
    try {
      const result = await window.rCode.updates.check()
      if (result.status === 'available' && result.version) {
        setUpdateResult(`يتوفر الإصدار ${result.version}`)
        if (window.confirm(`يتوفر الإصدار ${result.version}. هل تريد تنزيله وتثبيته؟`)) {
          setUpdateResult('جارٍ تنزيل التحديث...')
          await window.rCode.updates.install()
        }
      } else setUpdateResult(result.message ?? 'لا يوجد تحديث.')
    } catch (error) { setUpdateResult(errorText(error)) }
    finally { setUpdateBusy(false) }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div ref={focusRef} className="modal modal-tall" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <header><h2 id="settings-title">إعداد المزود</h2><button aria-label="إغلاق الإعدادات" onClick={close}><X size={18} /></button></header>
        <div className="settings-scroll">
          {/* OpenCode Go Section */}
          <section className="settings-section">
            <h3 className="settings-section-title">OpenCode Go</h3>
            <p>المفتاح يبقى مشفرًا داخل Windows ولا يعاد إلى الواجهة. اترك الحقل فارغًا للاحتفاظ بالمفتاح المحفوظ.</p>
            <label className="field"><KeyRound size={14} /> مفتاح API<input autoFocus dir="ltr" type="password" placeholder={value.hasApiKey ? 'مفتاح محفوظ، اكتب لاستبداله' : 'opencode_...'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
            <label className="field">النموذج<select value={modelId} onChange={(event) => selectModel(event.target.value)}>{GO_MODELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{model.apiStyle === 'anthropic' ? 'Anthropic Messages' : model.apiStyle === 'responses' ? 'Responses API' : 'Chat Completions'}</small></label>
            <label className="field">نافذة السياق الفعلية<input dir="ltr" type="number" min={32000} max={2000000} step={1000} value={contextWindow} onChange={(event) => setContextWindow(Math.min(2000000, Math.max(32000, Number(event.target.value) || 32000)))} /><small>الحالي: {contextWindow.toLocaleString('en')} رمز · {source}.</small></label>
            <div className="settings-actions">
              {value.hasApiKey && <button className="btn-ghost danger-text" onClick={() => void clearKey()} disabled={Boolean(busy)}>حذف المفتاح</button>}
              <button className="btn-ghost" onClick={() => void test()} disabled={Boolean(busy) || !apiKey && !value.hasApiKey}>{busy === 'test' ? 'يختبر...' : 'اختبار'}</button>
              <button className="btn-primary" onClick={() => void save()} disabled={Boolean(busy) || !apiKey && !value.hasApiKey}>{busy === 'save' ? 'يحفظ...' : 'حفظ'}</button>
            </div>
          </section>

          <hr className="settings-divider" />

          <section className="settings-section">
            <h3 className="settings-section-title">تحديث التطبيق</h3>
            <p>تحقق من وجود إصدار أحدث ونزّله مباشرة من GitHub.</p>
            <div className="settings-actions">
              <button className="btn-ghost" onClick={() => void checkForUpdates()} disabled={updateBusy}>{updateBusy ? 'يتحقق...' : 'التحقق من التحديثات'}</button>
            </div>
            {updateResult && <small className="settings-update-result" role="status">{updateResult}</small>}
          </section>

          <hr className="settings-divider" />

          {/* Tavily Section */}
          <section className="settings-section">
            <h3 className="settings-section-title">Tavily</h3>
            <label className="field">مفتاح Tavily<small>يُستخدم للبحث في الويب عبر Tavily API. اتركه فارغًا للاحتفاظ بالمفتاح المحفوظ.</small><input dir="ltr" type="password" placeholder={tavilyHas ? 'مفتاح محفوظ، اكتب لاستبداله' : 'tvly-dev-...'} value={tavilyKey} onChange={(event) => setTavilyKey(event.target.value)} /></label>
            <div className="settings-actions">
              {tavilyHas && <button className="btn-ghost danger-text" onClick={() => void clearTavily()} disabled={tavilyBusy}>حذف مفتاح Tavily</button>}
              <button className="btn-ghost" onClick={() => void saveTavily()} disabled={tavilyBusy || (!tavilyKey && !tavilyHas)}>{tavilyBusy ? 'يحفظ...' : 'حفظ Tavily'}</button>
            </div>
          </section>

          <hr className="settings-divider" />

          {/* Custom Providers Section */}
          <section className="settings-section">
            <div className="settings-section-header">
              <h3 className="settings-section-title">المزودات المخصصة</h3>
              <button className="btn-ghost btn-sm" onClick={() => { setEditingProvider(undefined); setShowAddProvider(true) }}><Plus size={14} /> إضافة مزود جديد</button>
            </div>

            {customProviders.length === 0 ? (
              <p className="settings-empty">لا توجد مزودات مخصصة بعد. أضف مزودًا لاستخدام نماذج مخصصة.</p>
            ) : (
              <div className="custom-providers-list">
                {customProviders.map((provider) => (
                  <div key={provider.id} className="custom-provider-card">
                    <div className="custom-provider-header" onClick={() => toggleExpand(provider.id)}>
                      <div className="custom-provider-info">
                        <span className="custom-provider-name">{provider.name}</span>
                        <span className="custom-provider-meta">{provider.models.length} نموذج · {provider.apiStyle === 'chat' ? 'Chat' : provider.apiStyle === 'anthropic' ? 'Anthropic' : 'Responses'}</span>
                      </div>
                      <div className="custom-provider-actions-inline">
                        <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEditingProvider(provider); setShowAddProvider(true) }}><Pencil size={14} /></button>
                        <button className="btn-ghost btn-sm danger-text" onClick={(e) => { e.stopPropagation(); void deleteCustomProvider(provider.id) }}><Trash2 size={14} /></button>
                        {expandedProviders.has(provider.id) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </div>
                    </div>
                    {expandedProviders.has(provider.id) && (
                      <div className="custom-provider-models">
                        {provider.models.map((model) => (
                          <div key={model.id} className="custom-model-row">
                            <span className="custom-model-id" dir="ltr">{model.modelId}</span>
                            <span className="custom-model-meta">{(model.contextWindow / 1_000_000).toFixed(0)}M context · {model.maxOutputTokens.toLocaleString()} max</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {result && <div className="test-result" role="status">{result}</div>}

        <footer>
          <button className="btn-ghost" onClick={close}>إغلاق</button>
        </footer>
      </div>

      {showAddProvider && (
        <AddProviderModal
          editing={editingProvider}
          close={() => { setShowAddProvider(false); setEditingProvider(undefined) }}
          saved={async () => { await loadCustomProviders(); setShowAddProvider(false); setEditingProvider(undefined) }}
        />
      )}
    </div>
  )
}
