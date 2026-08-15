/**
 * DeployDialog — نافذة إعدادات النشر إلى GitHub Pages
 */
import { memo, useState } from 'react'
import { Rocket, LoaderCircle, CheckCircle, XCircle, X, ExternalLink } from 'lucide-react'
import type { DeployState } from '../../../shared/types'

interface Props {
  deploy: DeployState
  onDeploy(token: string, repoUrl: string, branch?: string): void
  onClose(): void
}

export const DeployDialog = memo(function DeployDialog({ deploy, onDeploy, onClose }: Props) {
  const [token, setToken] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('gh-pages')
  const [validationError, setValidationError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const value = repoUrl.trim()
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash || url.pathname.split('/').filter(Boolean).length !== 2) throw new Error('استخدم رابط GitHub HTTPS بالشكل https://github.com/owner/repo')
      if (branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/'))) throw new Error('اسم الفرع غير صالح')
    } catch (error) { setValidationError(error instanceof Error ? error.message : 'رابط المستودع غير صالح'); return }
    if (!token.trim()) return
    setValidationError(null)
    onDeploy(token.trim(), value, branch.trim() || undefined)
    setToken('')
  }

  function close(): void { setToken(''); onClose() }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="deploy-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="deploy-dialog-head">
          <h3><Rocket size={16} /> نشر إلى GitHub Pages</h3>
          <button className="deploy-close" onClick={close}><X size={16} /></button>
        </div>

        {deploy.status === 'building' || deploy.status === 'deploying' ? (
          <div className="deploy-status deploying">
            <LoaderCircle size={20} className="spin" />
            <span>{deploy.status === 'building' ? 'جارٍ بناء نسخة الإنتاج...' : 'جارٍ رفع artifact إلى gh-pages...'}</span>
            {deploy.buildSucceeded && <small>نجح build، وتبدأ الآن مرحلة الرفع.</small>}
          </div>
        ) : deploy.status === 'success' ? (
          <div className="deploy-status success">
            <CheckCircle size={20} />
            <span>تم الرفع إلى gh-pages بنجاح.</span>
            {deploy.url && (
              <a href={deploy.url} target="_blank" rel="noopener noreferrer" className="deploy-url-link">
                <ExternalLink size={14} /> {deploy.url}
              </a>
            )}
            <small>حالة Pages: {deploy.pagesStatus === 'pending' ? 'قيد الانتظار، لا يعني نجاح الرفع أن الموقع أصبح متاحًا فورًا.' : 'غير مؤكدة.'}</small>
          </div>
        ) : deploy.status === 'failed' ? (
          <div className="deploy-status failed">
            <XCircle size={20} />
            <span>فشل النشر</span>
            {deploy.error && <pre className="deploy-error">{deploy.error}</pre>}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="deploy-form">
            <label className="deploy-field">
              GitHub Token
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="deploy-input"
                autoFocus
              />
              <small>أنشئ token من GitHub Settings → Developer settings → Personal access tokens</small>
            </label>
            <label className="deploy-field">
              رابط المستودع
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/username/repo"
                className="deploy-input"
              />
              <small>يجب أن يكون المستودع موجودًا ولديك صلاحية push</small>
            </label>
            <label className="deploy-field">
              فرع النشر
              <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} className="deploy-input" placeholder="gh-pages" />
            </label>
            {validationError && <div className="deploy-error">{validationError}</div>}
            <button type="submit" className="deploy-submit" disabled={!token.trim() || !repoUrl.trim()}>
              <Rocket size={14} /> ابدأ النشر
            </button>
          </form>
        )}
      </div>
    </div>
  )
})
