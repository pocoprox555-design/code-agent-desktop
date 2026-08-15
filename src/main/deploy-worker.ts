import ghPages from 'gh-pages'

interface PublishPayload {
  artifactDir: string
  repoUrl: string
  branch: string
}

process.on('message', (value: unknown) => {
  const payload = value as Partial<PublishPayload>
  if (!payload || typeof payload.artifactDir !== 'string' || typeof payload.repoUrl !== 'string' || typeof payload.branch !== 'string') {
    finish(new Error('بيانات عامل النشر غير صالحة'))
    return
  }
  ghPages.publish(payload.artifactDir, {
    branch: payload.branch,
    repo: payload.repoUrl,
    message: 'نشر Code Agent',
    dotfiles: true,
    nojekyll: true,
    silent: true,
  }, (error) => finish(error ?? null))
})

function finish(error: Error | null): void {
  if (typeof process.send === 'function') process.send(error ? { ok: false, error: error.message } : { ok: true })
  process.exit(error ? 1 : 0)
}
