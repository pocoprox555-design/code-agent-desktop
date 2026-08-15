declare module 'gh-pages' {
  interface PublishOptions {
    branch?: string
    repo?: string
    message?: string
    dotfiles?: boolean
    nojekyll?: boolean
    silent?: boolean
    src?: string | string[]
    dest?: string
    remove?: string
    tag?: string
    remote?: string
    user?: { name: string; email: string }
  }
  function publish(
    dir: string,
    options: PublishOptions,
    callback: (err: Error | null) => void,
  ): void
  export = { publish }
}
