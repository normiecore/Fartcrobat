import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useApp } from '../app/store'
import { useDocState, type DocumentModel } from '../document/DocumentModel'
import { Checkbox } from '../ui/Field'

export function FindBar({ doc }: { doc: DocumentModel }) {
  const search = useDocState(doc, (s) => s.search)
  const [query, setQuery] = useState(search.query)
  const [matchCase, setMatchCase] = useState(!!search.options.matchCase)
  const [wholeWords, setWholeWords] = useState(!!search.options.wholeWords)
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<number | null>(null)
  /** The last query this bar searched for; other queries come from elsewhere (Ctrl+F on a selection...). */
  const ownQuery = useRef(search.query)

  const cancelPending = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    const onFocus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('fartcrobat:focus-find', onFocus)
    return () => {
      window.removeEventListener('fartcrobat:focus-find', onFocus)
      cancelPending()
    }
  }, [])

  // A search started elsewhere (Find with selected text, "Find text or tools") shows its text here.
  useEffect(() => {
    if (search.query === ownQuery.current) return
    ownQuery.current = search.query
    cancelPending()
    setQuery(search.query)
    setMatchCase(!!search.options.matchCase)
    setWholeWords(!!search.options.wholeWords)
    if (document.activeElement === inputRef.current) inputRef.current?.select()
  }, [search.query, search.options])

  const searchNow = (q: string, mc = matchCase, ww = wholeWords) => {
    cancelPending()
    ownQuery.current = q
    void doc.search(q, { matchCase: mc, wholeWords: ww })
  }

  const run = (q: string, mc = matchCase, ww = wholeWords) => {
    cancelPending()
    timer.current = window.setTimeout(() => searchNow(q, mc, ww), 200)
  }

  const close = () => {
    cancelPending()
    doc.cancelSearch()
    useApp.setState({ findBarOpen: false })
    doc.view?.getViewportElement()?.focus()
  }

  const count = search.hits.length
  return (
    <div className="shell-findbar" role="search">
      <input
        ref={inputRef}
        className="ui-input"
        placeholder="Find in document"
        aria-label="Find in document"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          run(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (search.query !== query) searchNow(query)
            else {
              cancelPending()
              doc.nextHit(e.shiftKey ? -1 : 1)
            }
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      />
      <span className="shell-findbar-count" aria-live="polite">
        {search.query
          ? count
            ? `${search.active + 1} of ${count}${search.running ? '+' : ''}`
            : search.running
              ? 'Searching…'
              : 'No results'
          : ''}
      </span>
      <button className="ui-icon-btn" title="Previous result (Shift+Enter)" aria-label="Previous result" disabled={!count} onClick={() => doc.nextHit(-1)}>
        <ChevronUp size={16} />
      </button>
      <button className="ui-icon-btn" title="Next result (Enter)" aria-label="Next result" disabled={!count} onClick={() => doc.nextHit(1)}>
        <ChevronDown size={16} />
      </button>
      <Checkbox
        checked={matchCase}
        label="Match case"
        onChange={(v) => {
          setMatchCase(v)
          run(query, v, wholeWords)
        }}
      />
      <Checkbox
        checked={wholeWords}
        label="Whole words"
        onChange={(v) => {
          setWholeWords(v)
          run(query, matchCase, v)
        }}
      />
      <button className="ui-icon-btn" title="Close (Esc)" aria-label="Close find" onClick={close}>
        <X size={16} />
      </button>
    </div>
  )
}
