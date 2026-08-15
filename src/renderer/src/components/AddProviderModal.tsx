/**
 * AddProviderModal — نموذج إضافة مزود مخصص
 * تصميم: عمودان (بيانات المزود | النماذج)
 */
import { useState, useRef, useCallback } from 'react'
import { X, Plus, Trash2, TestTube, Check, AlertCircle, LoaderCircle, Server, Braces, KeyRound, Link2, Layers, Zap } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { CustomProviderSettings, ApiStyle } from '../../../shared/types'

interface AddProviderModalProps {
  editing?: CustomProviderSettings
  close(): void
  saved(provider: CustomProviderSettings): void
}

interface ModelForm {
  id: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  testStatus: 'idle' | 'testing' | 'success' | 'error'
  testError?: string
  testLatency?: number
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

let modelCounter = 0
function newModelForm(): ModelForm {
  return { id: `new-${++modelCounter}`, modelId: '', contextWindow: 128_000, maxOutputTokens: 4096, testStatus: 'idle' }
}

const API_STYLES: Array<{ value: ApiStyle; label: string; path: string }> = [
  { value: 'chat', label: 'Chat Completions', path: '/chat/completions' },
  { value: 'anthropic', label: 'Anthropic Messages', path: '/messages' },
  { value: 'responses', label: 'Responses API', path: '/responses' },
]

export function AddProviderModal({ editing, close, saved }: AddProviderModalProps) {
  const focusRef = useRef<HTMLDivElement>(null)
  useFocusTrap(focusRef, true)

  const [name, setName] = useState(editing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiStyle, setApiStyle] = useState<ApiStyle>(editing?.apiStyle ?? 'chat')
  const [models, setModels] = useState<ModelForm[]>(() => {
    if (editing?.models?.length) {
      return editing.models.map((m) => ({ id: m.id, modelId: m.modelId, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens, testStatus: 'idle' as const }))
    }
    return [newModelForm()]
  })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  const updateModel = useCallback((index: number, patch: Partial<ModelForm>) => {
    setModels((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }, [])

  const removeModel = useCallback((index: number) => {
    setModels((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const addModel = useCallback(() => {
    setModels((prev) => [...prev, newModelForm()])
  }, [])

  async function testModel(index: number) {
    const model = models[index]
    if (!model || !model.modelId || !baseUrl) return
    updateModel(index, { testStatus: 'testing', testError: undefined })
    try {
      const res = await window.rCode.customProviders.testNewModel({
        baseUrl,
        apiKey: apiKey || undefined,
        apiStyle,
        modelId: model.modelId,
      })
      updateModel(index, {
        testStatus: res.success ? 'success' : 'error',
        testError: res.error,
        testLatency: res.latency,
      })
    } catch (error) {
      updateModel(index, { testStatus: 'error', testError: errorText(error) })
    }
  }

  async function save() {
    if (!name.trim() || !baseUrl.trim() || models.length === 0) {
      setResult('أكمل جميع الحقول المطلوبة')
      return
    }
    const validModels = models.filter((m) => m.modelId.trim())
    if (validModels.length === 0) {
      setResult('أضف نموذجًا واحدًا على الأقل')
      return
    }
    setBusy(true)
    setResult('')
    try {
      const res = await window.rCode.customProviders.save({
        id: editing?.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey || undefined,
        apiStyle,
        models: validModels.map((m) => ({
          modelId: m.modelId.trim(),
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        })),
      })
      saved(res)
      close()
    } catch (error) {
      setResult(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const canSave = name.trim() && baseUrl.trim() && models.some((m) => m.modelId.trim()) && !busy

  return (
    <div className="modal-backdrop" onClick={close}>
      <div ref={focusRef} className="modal modal-wide provider-modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="add-provider-title" onClick={(e) => e.stopPropagation()}>
        <header className="provider-modal-header">
          <div className="provider-modal-title">
            <span className="provider-modal-icon"><Server size={18} /></span>
            <div>
              <h2 id="add-provider-title">{editing ? 'تعديل المزود' : 'إضافة مزود جديد'}</h2>
              <p>{editing ? 'عدّل بيانات المزود ونماذجه ثم احفظ' : 'اربط أي مزود بتنسيق OpenAI أو Anthropic أو Responses'}</p>
            </div>
          </div>
          <button aria-label="إغلاق" onClick={close}><X size={18} /></button>
        </header>

        <div className="provider-modal-body">
          {/* ─── العمود الأيمن: بيانات المزود ─── */}
          <section className="provider-column">
            <div className="provider-column-title"><Layers size={14} /> بيانات المزود</div>

            <label className="provider-field">
              <span className="provider-field-label"><Server size={13} /> اسم المزود</span>
              <input dir="rtl" type="text" placeholder="مثال: DeepSeek" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>

            <label className="provider-field">
              <span className="provider-field-label"><Link2 size={13} /> Base URL</span>
              <input dir="ltr" type="url" placeholder="https://api.deepseek.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              <small>يُستخدم مباشرةً مع مسار النمط المختار</small>
            </label>

            <label className="provider-field">
              <span className="provider-field-label"><KeyRound size={13} /> مفتاح API</span>
              <input dir="ltr" type="password" placeholder={editing?.hasApiKey ? 'مفتاح محفوظ — اكتب لاستبداله' : 'sk-...'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <small>{editing?.hasApiKey ? 'سيبقى المفتاح الحالي إذا تركت الحقل فارغًا' : 'اختياري — يُطلب عند أول اختبار'}</small>
            </label>

            <div className="provider-field">
              <span className="provider-field-label"><Braces size={13} /> نمط API</span>
              <div className="api-style-grid">
                {API_STYLES.map((style) => (
                  <button
                    key={style.value}
                    type="button"
                    className={`api-style-card ${apiStyle === style.value ? 'active' : ''}`}
                    onClick={() => setApiStyle(style.value)}
                  >
                    <span className="api-style-name">{style.label}</span>
                    <span className="api-style-path" dir="ltr">{style.path}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ─── العمود الأيسر: النماذج ─── */}
          <section className="provider-column models-column">
            <div className="provider-column-title">
              <span><Zap size={14} /> النماذج</span>
              <button className="btn-ghost btn-sm" onClick={addModel} type="button"><Plus size={13} /> إضافة نموذج</button>
            </div>

            <div className="models-list">
              {models.map((model, index) => (
                <div key={model.id} className={`model-card ${model.testStatus === 'error' ? 'has-error' : ''}`}>
                  <div className="model-card-head">
                    <span className="model-card-index">{index + 1}</span>
                    <label className="model-id-input-wrap">
                      <input dir="ltr" type="text" placeholder="model-id (مثال: deepseek-chat)" value={model.modelId} onChange={(e) => updateModel(index, { modelId: e.target.value, testStatus: 'idle' })} />
                    </label>
                    {models.length > 1 && (
                      <button className="model-remove-btn" onClick={() => removeModel(index)} type="button" aria-label="حذف النموذج"><Trash2 size={14} /></button>
                    )}
                  </div>

                  <div className="model-card-inputs">
                    <label className="model-num-input">
                      <span>نافذة السياق</span>
                      <input dir="ltr" type="number" min={32000} max={2000000} step={1000} value={model.contextWindow} onChange={(e) => updateModel(index, { contextWindow: Math.min(2000000, Math.max(32000, Number(e.target.value) || 32000)) })} />
                    </label>
                    <label className="model-num-input">
                      <span>أقصى إخراج</span>
                      <input dir="ltr" type="number" min={256} max={1000000} step={256} value={model.maxOutputTokens} onChange={(e) => updateModel(index, { maxOutputTokens: Math.min(1000000, Math.max(256, Number(e.target.value) || 256)) })} />
                    </label>
                  </div>

                  <div className="model-card-actions">
                    <button
                      className={`model-test-btn ${model.testStatus}`}
                      onClick={() => testModel(index)}
                      disabled={!model.modelId || !baseUrl || model.testStatus === 'testing'}
                      type="button"
                    >
                      {model.testStatus === 'testing' ? (
                        <><LoaderCircle size={14} className="spin" /> جارٍ الاختبار...</>
                      ) : model.testStatus === 'success' ? (
                        <><Check size={14} /> متصل ({model.testLatency}ms)</>
                      ) : model.testStatus === 'error' ? (
                        <><AlertCircle size={14} /> فشل — اضغط للتفاصيل</>
                      ) : (
                        <><TestTube size={14} /> اختبار الاتصال</>
                      )}
                    </button>
                    {model.testStatus === 'error' && model.testError && (
                      <div className="model-test-error">{model.testError}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {result && <div className="test-result" role="status">{result}</div>}

        <footer className="provider-modal-footer">
          <button className="btn-ghost" onClick={close} disabled={busy}>إلغاء</button>
          <button className="btn-primary" onClick={save} disabled={!canSave}>{busy ? 'جارٍ الحفظ...' : editing ? 'تحديث المزود' : 'حفظ المزود'}</button>
        </footer>
      </div>
    </div>
  )
}
