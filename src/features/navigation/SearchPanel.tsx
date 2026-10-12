import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  hitContext,
  IconButton,
  useDocState,
  type DocumentModel,
  type PageText,
  type SearchHit
} from '@renderer/sdk'
import { SEARCH_FOCUS_EVENT } from './state'
import { tidyContext } from './util'

const PAGE_SIZE = 400
const CONTEXT = 40

export function SearchPanel({ doc }: { doc: DocumentModel }) {
  const search = useDocState(doc, (s) => s.search)
  const info = useDocState(doc, (s) => s.info)
  const [query, setQuery] = useState(search.query)
  const [wholeWords, setWholeWords] = useState(!!search.options.wholeWords)
  const [matchCase, setMatchCase] = useState(!!search.options.matchCase)
  const [texts, setTexts] = useState<Map<number, PageText>>(new Map())
  const [limit, setLimit] = useState(PAGE_SIZE)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    focus()
    window.addEventListener(SEARCH_FOCUS_EVENT, focus)
    return () => window.removeEventListener(SEARCH_FOCUS_EVENT, focus)
  }, [])

  // Keep the box in sync with searches started elsewhere (e.g. the Find bar).
  useEffect(() => {
    if (search.query && search.query !== query && !search.running) setQuery(search.query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.query])

  useEffect(() => setLimit(PAGE_SIZE), [search.query])

  // Load page text for the context of each result.
  const shown = search.hits.slice(0, limit)
  const pagesNeeded = useMemo(() => [...new Set(shown.map((h) => h.page))], [shown])
  useEffect(() => {
    let alive = true
    const missing = pagesNeeded.filter((p) => !texts.has(p))
    if (!missing.length) return
    void Promise.all(missing.map((p) => doc.pageText(p).then((t) => [p, t] as const).catch(() => null))).then((loaded) => {
      if (!alive) return
      setTexts((prev) => {
        const next = new Map(prev)
        for (const e of loaded) if (e) next.set(e[0], e[1])
        return next
      })
    })
    return () => {
      alive = false
    }
  }, [doc, pagesNeeded, texts])

  // Page text changes when pages are edited; drop the cache.
  const globalVersion = useDocState(doc, (s) => s.globalVersion)
  const docVersion = useDocState(doc, (s) => s.docVersion)
  useEffect(() => setTexts(new Map()), [globalVersion, docVersion])

  const run = () => {
    const q = query.trim()
    if (!q) return
    void doc.search(q, { wholeWords, matchCase })
  }

  const reset = () => {
    doc.cancelSearch()
    setQuery('')
    inputRef.current?.focus()
  }

  const groups = useMemo(() => {
    const out: { page: number; items: { hit: SearchHit; index: number }[] }[] = []
    shown.forEach((hit, index) => {
      const last = out[out.length - 1]
      if (last && last.page === hit.page) last.items.push({ hit, index })
      else out.push({ page: hit.page, items: [{ hit, index }] })
    })
    return out
  }, [shown])

  const total = search.hits.length
  const pageCount = new Set(search.hits.map((h) => h.page)).size
  const progress = info.pageCount ? search.pagesSearched / info.pageCount : 0

  const moveFocus = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('.fc-navigation-result') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[e.key === 'ArrowDown' ? i + 1 : i - 1]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  return (
    <div className="fc-navigation-panel fc-navigation-search">
      <form
        className="fc-navigation-search-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
      >
        <label className="fc-navigation-search-label" htmlFor={`fc-navigation-q-${doc.id}`}>
          What word or phrase would you like to search for?
        </label>
        <div className="fc-navigation-search-row">
          <input
            id={`fc-navigation-q-${doc.id}`}
            ref={inputRef}
            className="ui-input"
            value={query}
            placeholder="Search this document"
            aria-label="Search for"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                e.stopPropagation()
                reset()
              } else if (e.key === 'ArrowDown') {
                const first = resultsRef.current?.querySelector<HTMLButtonElement>('.fc-navigation-result')
                if (first) {
                  e.preventDefault()
                  first.focus()
                }
              }
            }}
          />
          {query && <IconButton icon={X} label="Clear" size={14} onClick={reset} />}
        </div>
        <div className="fc-navigation-search-options">
          <Checkbox checked={wholeWords} onChange={setWholeWords} label="Whole words only" />
          <Checkbox checked={matchCase} onChange={setMatchCase} label="Case-sensitive" />
        </div>
        <div className="fc-navigation-search-actions">
          <Button type="submit" variant="primary" size="sm" icon={Search} disabled={!query.trim()}>
            Search
          </Button>
          {search.query && (
            <Button size="sm" variant="quiet" onClick={reset}>
              New search
            </Button>
          )}
        </div>
      </form>
      {search.query && (
        <div className="fc-navigation-search-status" aria-live="polite">
          {search.running ? (
            <>
              <span>
                Searching… page {Math.min(info.pageCount, search.pagesSearched + 1)} of {info.pageCount}
                {total ? ` · ${total} found` : ''}
              </span>
              <div className="fc-navigation-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </>
          ) : total ? (
            <span className="fc-navigation-search-count">
              {total} {total === 1 ? 'result' : 'results'} in {pageCount} {pageCount === 1 ? 'page' : 'pages'}
            </span>
          ) : (
            <span className="fc-navigation-search-count">No results for “{search.query}”.</span>
          )}
        </div>
      )}
      <div className="fc-navigation-results" ref={resultsRef} onKeyDown={moveFocus} aria-label="Search results">
        {groups.map((g) => {
          const t = texts.get(g.page)
          const label = info.pages[g.page]?.label ?? String(g.page + 1)
          return (
            <Fragment key={g.page}>
              <div className="fc-navigation-results-page">
                <span>Page {label}</span>
                <span className="fc-navigation-results-count">{g.items.length}</span>
              </div>
              {g.items.map(({ hit, index }) => {
                const c = t
                  ? tidyContext(hitContext(t, hit, CONTEXT), hit.start > CONTEXT, hit.end + CONTEXT < t.text.length)
                  : null
                return (
                  <button
                    key={index}
                    type="button"
                    className={`fc-navigation-result ${index === search.active ? 'is-active' : ''}`}
                    aria-current={index === search.active ? 'true' : undefined}
                    onClick={() => void doc.revealHit(index)}
                  >
                    {c ? (
                      <>
                        {c.before && <span className="fc-navigation-result-ctx">{hit.start > CONTEXT ? '…' : ''}{c.before}</span>}
                        <mark>{c.match}</mark>
                        {c.after && <span className="fc-navigation-result-ctx">{c.after}{t && hit.end + CONTEXT < t.text.length ? '…' : ''}</span>}
                      </>
                    ) : (
                      <mark>{search.query}</mark>
                    )}
                  </button>
                )
              })}
            </Fragment>
          )
        })}
        {total > limit && (
          <div className="fc-navigation-results-more">
            <Button size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              Show more results ({total - limit} more)
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
