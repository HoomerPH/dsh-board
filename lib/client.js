/**
 * dsh-board client half — the Board main panel and its sidebar entry.
 *
 * Loaded as a lazy-CJS bundle through the shell's module system. Only React is
 * required from the platform table; all board data comes from the host half's
 * exact Fetch routes (`/api/board/state`, `/api/board/action`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-board',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef

    const CSS = `
.dshb-root { height: 100%; display: flex; flex-direction: column; min-height: 0;
  background: #fafafa; background: light-dark(#fafafa, #101012);
  color: #18181b; color: light-dark(#18181b, #e4e4e7);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.dshb-top { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-bottom: 1px solid #e4e4e7; border-bottom-color: light-dark(#e4e4e7, #27272a);
  flex: 0 0 auto; }
.dshb-title { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
.dshb-sub { color: #71717a; color: light-dark(#71717a, #a1a1aa); font-size: 12px; }
.dshb-spacer { flex: 1 1 auto; }
.dshb-btn { appearance: none; border: 1px solid #d4d4d8; border-color: light-dark(#d4d4d8, #3f3f46);
  background: #fff; background: light-dark(#fff, #18181b); color: inherit;
  font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer; }
.dshb-btn:hover { border-color: #a1a1aa; border-color: light-dark(#a1a1aa, #52525b); }
.dshb-btn-primary { background: #18181b; background: light-dark(#18181b, #fafafa);
  color: #fff; color: light-dark(#fff, #18181b); border-color: transparent; font-weight: 550; }
.dshb-btn-primary:hover { opacity: 0.88; }
.dshb-btn-danger { color: #b91c1c; color: light-dark(#b91c1c, #fca5a5);
  border-color: #fecaca; border-color: light-dark(#fecaca, #7f1d1d); }
.dshb-btn:disabled { opacity: 0.45; cursor: default; }
.dshb-error { margin: 10px 16px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
  background: #fef2f2; background: light-dark(#fef2f2, #2a1215); color: #b91c1c;
  color: light-dark(#b91c1c, #fca5a5); }
.dshb-warn { margin: 10px 16px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
  background: #fffbeb; background: light-dark(#fffbeb, #2a2103); color: #b45309;
  color: light-dark(#b45309, #fcd34d); }
.dshb-cols { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; padding: 14px 16px 18px;
  overflow-x: auto; align-items: stretch; }
.dshb-col { box-sizing: border-box; flex: 1 1 150px; min-width: 146px; max-width: 340px; display: flex; flex-direction: column; min-height: 0;
  background: #f4f4f5; background: light-dark(#f4f4f5, #161618); border-radius: 10px; padding: 8px; }
.dshb-colhead { display: flex; align-items: center; gap: 8px; padding: 2px 6px 8px; flex: 0 0 auto; }
.dshb-collabel { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em;
  color: #71717a; color: light-dark(#71717a, #a1a1aa); }
.dshb-count { font-size: 11px; color: #a1a1aa; color: light-dark(#a1a1aa, #71717a);
  background: #fff; background: light-dark(#fff, #232326); border-radius: 99px; padding: 0 7px; line-height: 18px; }
.dshb-cards { display: flex; flex-direction: column; gap: 7px; overflow-y: auto; min-height: 0; padding: 1px; }
.dshb-empty { color: #71717a; color: light-dark(#71717a, #a1a1aa); font-size: 12px; padding: 8px 6px; }
.dshb-card { text-align: left; appearance: none; font: inherit; color: inherit; cursor: pointer;
  background: #fff; background: light-dark(#fff, #1e1e21); border: 1px solid #e4e4e7;
  border-color: light-dark(#e4e4e7, #2c2c30); border-radius: 9px; padding: 9px 10px;
  display: flex; flex-direction: column; gap: 6px; }
.dshb-card:hover { border-color: #a1a1aa; border-color: light-dark(#a1a1aa, #52525b); }
.dshb-cardkey { font-size: 10.5px; font-weight: 650; letter-spacing: 0.04em;
  color: #71717a; color: light-dark(#71717a, #a1a1aa); font-variant-numeric: tabular-nums; }
.dshb-cardtitle { font-size: 12.5px; line-height: 1.35; font-weight: 500; }
.dshb-cardmeta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshb-chip { font-size: 10.5px; border-radius: 99px; padding: 1px 7px; background: #f4f4f5;
  background: light-dark(#f4f4f5, #27272a); color: #52525b; color: light-dark(#52525b, #d4d4d8); }
.dshb-chip-agent { background: #eef2ff; background: light-dark(#eef2ff, #1e1b4b); color: #4338ca;
  color: light-dark(#4338ca, #a5b4fc); }
.dshb-chip-run { background: #ecfdf5; background: light-dark(#ecfdf5, #052e1b); color: #047857;
  color: light-dark(#047857, #6ee7b7); }
.dshb-chip-review { background: #fffbeb; background: light-dark(#fffbeb, #2a2103); color: #b45309;
  color: light-dark(#b45309, #fcd34d); }
.dshb-dot { width: 5px; height: 5px; border-radius: 50%; background: #a1a1aa;
  background: light-dark(#a1a1aa, #52525b); display: inline-block; }
.dshb-overlay { position: fixed; inset: 0; background: rgba(9,9,11,.24); z-index: 40; }
.dshb-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(460px, 94vw); z-index: 41;
  display: flex; flex-direction: column; background: #fff; background: light-dark(#fff, #131316);
  border-left: 1px solid #e4e4e7; border-left-color: light-dark(#e4e4e7, #27272a);
  box-shadow: -18px 0 40px rgba(0,0,0,.12); }
.dshb-dhead { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 10px;
  border-bottom: 1px solid #f0f0f1; border-bottom-color: light-dark(#f0f0f1, #232326); }
.dshb-dtitle { font-size: 14px; font-weight: 600; line-height: 1.35; }
.dshb-dbody { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px 20px; display: flex;
  flex-direction: column; gap: 14px; }
.dshb-section { display: flex; flex-direction: column; gap: 6px; }
.dshb-seclabel { font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em;
  color: #71717a; color: light-dark(#71717a, #a1a1aa); }
.dshb-text { font-size: 12.5px; white-space: pre-wrap; }
.dshb-accept { margin: 0; padding-left: 16px; font-size: 12.5px; }
.dshb-input, .dshb-textarea { font: inherit; font-size: 12.5px; color: inherit;
  background: #fafafa; background: light-dark(#fafafa, #1a1a1d); border: 1px solid #e4e4e7;
  border-color: light-dark(#e4e4e7, #2c2c30); border-radius: 7px; padding: 6px 8px; width: 100%;
  box-sizing: border-box; }
.dshb-textarea { resize: vertical; min-height: 64px; }
.dshb-row { display: flex; gap: 8px; align-items: center; }
.dshb-row > * { flex: 1 1 auto; }
.dshb-row .dshb-btn { flex: 0 0 auto; }
.dshb-runbox { border: 1px solid #e4e4e7; border-color: light-dark(#e4e4e7, #2c2c30);
  border-radius: 9px; padding: 9px 10px; display: flex; flex-direction: column; gap: 6px;
  background: #fafafa; background: light-dark(#fafafa, #18181b); }
.dshb-runmeta { font-size: 11.5px; color: #71717a; color: light-dark(#71717a, #a1a1aa);
  font-variant-numeric: tabular-nums; word-break: break-all; }
.dshb-timeline { display: flex; flex-direction: column; gap: 7px; }
.dshb-event { display: flex; flex-direction: column; gap: 1px; font-size: 12px; }
.dshb-eventby { color: #71717a; color: light-dark(#71717a, #a1a1aa); font-size: 11px; }
.dshb-form { display: flex; flex-direction: column; gap: 8px; }
.dshb-sel { font: inherit; font-size: 12px; padding: 5px 7px; border-radius: 7px;
  border: 1px solid #d4d4d8; border-color: light-dark(#d4d4d8, #3f3f46);
  background: #fff; background: light-dark(#fff, #18181b); color: inherit; }
.dshb-link { color: #4338ca; color: light-dark(#4338ca, #a5b4fc); text-decoration: none; word-break: break-all; }
.dshb-link:hover { text-decoration: underline; }
.dshb-review { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-radius: 10px;
  border: 1px solid #fde68a; border-color: light-dark(#fde68a, #78350f);
  background: #fffdf5; background: light-dark(#fffdf5, #1c1708); }
.dshb-check { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 7px;
  border: 1px solid #e4e4e7; border-color: light-dark(#e4e4e7, #2c2c30);
  background: #fff; background: light-dark(#fff, #1a1a1d); }
.dshb-check-pass { border-left: 3px solid #22c55e; }
.dshb-check-fail { border-left: 3px solid #ef4444; }
.dshb-check-skip { border-left: 3px solid #a1a1aa; }
.dshb-checkhead { display: flex; align-items: center; gap: 8px; }
.dshb-checkhead > .dshb-btn { margin-left: auto; flex: 0 0 auto; }
.dshb-checkname { font-size: 12px; font-weight: 600; }
.dshb-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: #52525b; color: light-dark(#52525b, #d4d4d8); word-break: break-all; }
.dshb-diffbox { max-height: 320px; overflow: auto; border-radius: 8px; padding: 6px 8px;
  border: 1px solid #e4e4e7; border-color: light-dark(#e4e4e7, #2c2c30);
  background: #fafafa; background: light-dark(#fafafa, #101012); }
.dshb-diffline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.dshb-diffadd { color: #15803d; color: light-dark(#15803d, #86efac); background: #f0fdf4; background: light-dark(#f0fdf4, #052e16); }
.dshb-diffdel { color: #b91c1c; color: light-dark(#b91c1c, #fca5a5); background: #fef2f2; background: light-dark(#fef2f2, #2a1215); }
.dshb-diffhunk { color: #4338ca; color: light-dark(#4338ca, #a5b4fc); }
.dshb-hist { display: flex; flex-direction: column; gap: 4px; }
.dshb-histrow { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.dshb-chip-fail { background: #fef2f2; background: light-dark(#fef2f2, #2a1215); color: #b91c1c; color: light-dark(#b91c1c, #fca5a5); }
.dshb-chip-pass { background: #f0fdf4; background: light-dark(#f0fdf4, #052e16); color: #15803d; color: light-dark(#15803d, #86efac); }
.dshb-iconwrap { position: relative; display: inline-flex; }
.dshb-badge { position: absolute; top: -4px; right: -7px; min-width: 15px; height: 15px; padding: 0 3px;
  border-radius: 99px; background: #b45309; color: #fff; font-size: 9.5px; line-height: 15px;
  text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
.dshb-badge-dot { width: 8px; height: 8px; min-width: 8px; top: -2px; right: -4px; }
.dshb-badge-live { background: light-dark(#1d4ed8, #3b82f6); }
.dshb-filters { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 0 16px 8px; }
.dshb-filterinput, .dshb-filterselect { padding: 5px 8px; border-radius: 6px; font: inherit; font-size: 12px; color: inherit;
  border: 1px solid light-dark(#d4d4d8, #3f3f46); background: light-dark(#fff, #18181b); }
.dshb-filterinput { flex: 1 1 200px; min-width: 150px; }
.dshb-card-focused { outline: 2px solid light-dark(#1d4ed8, #60a5fa); outline-offset: 1px; }
.dshb-card-selected { outline: 2px solid light-dark(#059669, #34d399); outline-offset: 1px; }
.dshb-md { font-size: 12px; line-height: 1.55; display: flex; flex-direction: column; gap: 2px; }
.dshb-md-h1 { font-size: 15px; font-weight: 700; margin-top: 6px; }
.dshb-md-h2 { font-size: 13.5px; font-weight: 700; margin-top: 6px; }
.dshb-md-h3, .dshb-md-h4 { font-size: 12.5px; font-weight: 650; margin-top: 4px; }
.dshb-md-p { margin: 0; }
.dshb-md-li { padding-left: 4px; }
.dshb-md-gap { height: 5px; }
.dshb-md-code { margin: 4px 0; padding: 7px 9px; border-radius: 6px; overflow: auto;
  background: light-dark(#f4f4f5, #1c1c1f); font-size: 11.5px; line-height: 1.45; }
.dshb-md-inline { padding: 1px 4px; border-radius: 4px; font-size: 11.5px;
  background: light-dark(#f1f1f3, #262629); }
.dshb-ticketlink { padding: 0; border: 0; background: none; cursor: pointer; font: inherit;
  color: inherit; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
.dshb-live { color: #047857; color: light-dark(#047857, #6ee7b7); font-size: 11px; }
.dshb-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`

    const STATUS_LABEL = {
      backlog: 'Backlog',
      ready: 'Ready',
      in_progress: 'In Progress',
      in_review: 'In Review',
      done: 'Done',
      blocked: 'Blocked',
    }

    const DEFAULT_WORKFLOW = {
      initial: 'backlog',
      dispatch: 'ready',
      active: 'in_progress',
      gate: 'in_review',
      done: 'done',
      blocked: 'blocked',
      transitions: null,
    }

    function workflowOf(board) {
      return (board && board.workflow) || DEFAULT_WORKFLOW
    }

    function labelOf(board, id) {
      const states = (board && board.states) || []
      const found = states.find(state => state.id === id)
      return found ? found.label : STATUS_LABEL[id] || id
    }

    function transitionsFrom(board, status) {
      const workflow = workflowOf(board)
      const all = workflow.transitions
        ? workflow.transitions[status] || []
        : ((board && board.states) || []).map(state => state.id).filter(id => id !== status)
      // The done state is never a generic move: it is only reachable through Approve.
      return all.filter(id => id !== workflow.done)
    }

    function boardUrl(leaf) {
      const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
      return new URL('api/board/' + leaf, base).toString()
    }

    async function fetchBoard({ summary = true } = {}) {
      const response = await fetch(boardUrl('state') + (summary ? '?summary=1' : ''), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('board state failed: ' + response.status)
      return response.json()
    }

    async function fetchTicket(id) {
      const response = await fetch(boardUrl('ticket') + '?id=' + encodeURIComponent(id), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value && value.error ? value.error : 'ticket failed: ' + response.status)
      return value.ticket
    }

    function eventsUrl() {
      const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
      return new URL('board/events', base).toString()
    }

    // One EventSource for the whole panel: every successful save on the host
    // pushes a revision, and subscribers refetch. Falls back to a slow poll when
    // EventSource is unavailable or the connection is down.
    const live = {
      listeners: new Set(),
      source: null,
      starting: false,
      connected: false,
      retryDelay: 3000,
      subscribe(listener) {
        this.listeners.add(listener)
        this.start()
        listener()
        return () => this.listeners.delete(listener)
      },
      start() {
        if (this.source || this.starting) return
        if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return
        this.starting = true
        try {
          const source = new window.EventSource(eventsUrl())
          source.onopen = () => {
            this.connected = true
            this.retryDelay = 3000
          }
          source.onmessage = () => {
            for (const listener of [...this.listeners]) listener()
          }
          source.onerror = () => {
            this.connected = false
            if (source.readyState === 2) {
              source.close()
              this.source = null
              this.starting = false
              const wait = this.retryDelay
              this.retryDelay = Math.min(this.retryDelay * 2, 30000)
              setTimeout(() => this.start(), wait)
            }
          }
          this.source = source
        } catch {
          this.source = null
        } finally {
          this.starting = false
        }
      },
      stop() {
        if (this.source) this.source.close()
        this.source = null
        this.connected = false
      },
    }

    let presetsPromise = null
    let presetsFailedAt = 0
    function fetchPresets() {
      if (presetsPromise) return presetsPromise
      if (presetsFailedAt && Date.now() - presetsFailedAt < 30000) return Promise.resolve([])
      presetsPromise = fetch(boardUrl('presets'), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
        .then(response => (response.ok ? response.json() : { presets: [] }))
        .then(value => (Array.isArray(value && value.presets) ? value.presets : []))
        .catch(() => {
          presetsFailedAt = Date.now()
          return []
        })
        .then(list => {
          if (!list.length) presetsPromise = null
          return list
        })
      return presetsPromise
    }

    async function fetchDiff(ticketId) {
      const response = await fetch(boardUrl('diff') + '?id=' + encodeURIComponent(ticketId), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value && value.error ? value.error : 'diff failed: ' + response.status)
      return value
    }

    async function sendAction(payload) {
      const response = await fetch(boardUrl('action'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value && value.error ? value.error : 'board action failed: ' + response.status)
      return value
    }

    function readFilterPrefs() {
      try {
        return JSON.parse((window.localStorage && window.localStorage.getItem('dshb-filters')) || '{}') || {}
      } catch {
        return {}
      }
    }

    function readSavedViews() {
      try {
        const value = JSON.parse((window.localStorage && window.localStorage.getItem('dshb-saved-views')) || '[]')
        return Array.isArray(value) ? value.filter(view => view && typeof view.name === 'string') : []
      } catch {
        return []
      }
    }

    function writeSavedViews(views) {
      try {
        window.localStorage.setItem('dshb-saved-views', JSON.stringify(views))
      } catch {
        /* saved views are optional */
      }
    }

    function csvCell(value) {
      const text = String(value ?? '')
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
    }

    function ticketsToCsv(tickets) {
      const columns = ['key', 'title', 'status', 'assignee', 'plan', 'priority', 'blocked_by', 'updated']
      const rows = tickets.map(ticket =>
        [
          ticket.key,
          ticket.title,
          ticket.status,
          ticket.assignee ?? '',
          ticket.planStatus ?? 'none',
          ticket.priority ?? 0,
          (ticket.blockedBy ?? []).length,
          ticket.updatedAt ?? '',
        ].map(csvCell).join(','),
      )
      return [columns.join(','), ...rows].join('\n') + '\n'
    }

    function downloadText(filename, text, mime) {
      try {
        const blob = new Blob([text], { type: mime })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.rel = 'noopener'
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (error) {
        console.warn('[dsh-board] export failed', error)
      }
    }

    function timeAgo(iso) {
      const then = new Date(iso).getTime()
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return seconds + 's'
      if (seconds < 3600) return Math.round(seconds / 60) + 'm'
      if (seconds < 86400) return Math.round(seconds / 3600) + 'h'
      return Math.round(seconds / 86400) + 'd'
    }

    /** Inline markdown: bold, code, and clickable ticket references (B-3). */
    function renderInline(source, onOpenTicket) {
      const text = String(source ?? '')
      const parts = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\bB-\d+\b)/g
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(text))) {
        if (match.index > last) parts.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          parts.push(h('strong', { key: index++ }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          parts.push(h('code', { key: index++, className: 'dshb-md-inline' }, token.slice(1, -1)))
        } else if (onOpenTicket) {
          parts.push(
            h(
              'button',
              { key: index++, className: 'dshb-ticketlink', type: 'button', onClick: () => onOpenTicket(token) },
              token,
            ),
          )
        } else {
          parts.push(h('code', { key: index++, className: 'dshb-md-inline' }, token))
        }
        last = match.index + token.length
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    /** Small safe markdown renderer (headings, bullets, fenced code, paragraphs). */
    function renderMarkdown(source, onOpenTicket) {
      const lines = String(source ?? '').split('\n')
      const blocks = []
      let key = 0
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (/^```/.test(line)) {
          const code = []
          index += 1
          while (index < lines.length && !/^```/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push(h('pre', { key: key++, className: 'dshb-md-code' }, code.join('\n')))
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push(h('div', { key: key++, className: 'dshb-md-h' + heading[1].length }, renderInline(heading[2], onOpenTicket)))
          index += 1
          continue
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        if (bullet) {
          blocks.push(h('div', { key: key++, className: 'dshb-md-li' }, '• ', renderInline(bullet[1], onOpenTicket)))
          index += 1
          continue
        }
        if (!line.trim()) {
          blocks.push(h('div', { key: key++, className: 'dshb-md-gap' }))
          index += 1
          continue
        }
        blocks.push(h('div', { key: key++, className: 'dshb-md-p' }, renderInline(line, onOpenTicket)))
        index += 1
      }
      return blocks
    }

    function fmtTokens(count) {
      const tokens = Number(count) || 0
      if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M'
      if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'k'
      return String(tokens)
    }

    function currentRun(ticket) {
      if (!ticket) return null
      if (ticket.run) return ticket.run
      if (!ticket.currentRunId || !Array.isArray(ticket.runs)) return null
      return ticket.runs.find(run => run.id === ticket.currentRunId) || null
    }

    function runChip(ticket) {
      const run = currentRun(ticket)
      if (!run) return null
      const cls = run.status === 'awaiting_review' ? 'dshb-chip dshb-chip-review' : 'dshb-chip dshb-chip-run'
      const label = run.status === 'awaiting_review' ? 'awaiting review' : run.status
      return h('span', { className: cls }, label + (run.tokens ? ' · ' + fmtTokens(run.tokens) : ''))
    }

    function boardPanelDecorator(ctx) {
      const click = () => {
        try {
          ctx.get('layout')?.selectPanel('board')
        } catch {
          /* the side panel still works if the layout service is unavailable */
        }
      }
      const commands = ctx.get('commandUi')
      if (!commands || typeof commands.decorate !== 'function') return
      ctx.effect(
        () =>
          commands.decorate({
            name: 'board',
            available: () => true,
            ui: { kind: 'action', run: () => click() },
          }),
        'dsh-board: open the board from /board',
      )
    }

    function BoardIcon(props) {
      const size = (props && props.size) || 20
      const active = !!(props && props.active)
      const [badge, setBadge] = useState({ ongoing: 0, attention: 0 })
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const data = await fetchBoard()
            if (!alive) return
            const workflow = workflowOf(data && data.board)
            const tickets = (data && data.tickets) || []
            const attentionStates = new Set()
            if (workflow.gate) attentionStates.add(workflow.gate)
            if (workflow.blocked && workflow.blocked !== workflow.done) attentionStates.add(workflow.blocked)
            const planReview = tickets.filter(ticket => ticket.planStatus === 'submitted' || ticket.needsInput).length
            const ongoing = tickets.filter(
              ticket =>
                (ticket.run && (ticket.run.status === 'running' || ticket.run.status === 'starting')) ||
                (workflow.active && ticket.status === workflow.active),
            ).length
            setBadge({ ongoing, attention: tickets.filter(ticket => attentionStates.has(ticket.status)).length + planReview })
          } catch {
            /* the badge is informational; failures are silent */
          }
        }
        const unsubscribe = live.subscribe(load)
        return () => {
          alive = false
          unsubscribe()
        }
      }, [])
      const icon = h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { opacity: active ? 1 : 0.72 },
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 5, height: 16, rx: 1.4 }),
        h('rect', { x: 9.5, y: 4, width: 5, height: 10, rx: 1.4 }),
        h('rect', { x: 16, y: 4, width: 5, height: 6.5, rx: 1.4 }),
      )
      return h(
        'span',
        {
          className: 'dshb-iconwrap',
          role: 'img',
          'aria-label': badge.ongoing
            ? 'Board, ' + badge.ongoing + ' work' + (badge.ongoing === 1 ? '' : 's') + ' in progress'
            : badge.attention
              ? 'Board, ' + badge.attention + ' ticket' + (badge.attention === 1 ? '' : 's') + ' need attention'
              : 'Board',
        },
        icon,
        badge.ongoing || badge.attention
          ? h(
              'span',
              {
                className: 'dshb-badge' + (badge.ongoing ? ' dshb-badge-live' : ''),
                'aria-hidden': 'true',
                title: badge.ongoing
                  ? badge.ongoing + ' work' + (badge.ongoing === 1 ? '' : 's') + ' in progress'
                  : badge.attention + ' ticket' + (badge.attention === 1 ? '' : 's') + ' need attention',
              },
              (badge.ongoing || badge.attention) > 9 ? '9+' : String(badge.ongoing || badge.attention),
            )
          : null,
      )
    }

    function TicketCard(props) {
      const ticket = props.ticket
      const latestRun = currentRun(ticket) || (Array.isArray(ticket.runs) && ticket.runs.length ? ticket.runs[ticket.runs.length - 1] : null)
      const latestChecks = latestRun && Array.isArray(latestRun.checks) ? latestRun.checks : []
      const failedCount = latestRun && typeof latestRun.checksFailed === 'number' ? latestRun.checksFailed : failedChecks(latestChecks).length
      const ranCount = latestRun && typeof latestRun.checksRan === 'number' ? latestRun.checksRan : latestChecks.length
      const metaChips = []
      if (ticket.planStatus === 'submitted') metaChips.push(h('span', { className: 'dshb-chip dshb-chip-review' }, 'plan review'))
      if (ticket.planStatus === 'approved') metaChips.push(h('span', { className: 'dshb-chip dshb-chip-pass' }, 'planned'))
      if (ticket.subtaskCount) metaChips.push(h('span', { className: 'dshb-chip' }, ticket.subtaskCount + ' subtasks'))
      if (ticket.run && ticket.run.subagentsCount) metaChips.push(h('span', { className: 'dshb-chip' }, ticket.run.subagentsCount + ' subagents'))
      if (ticket.priority) metaChips.push(h('span', { className: 'dshb-chip' }, 'p' + ticket.priority))
      if (ticket.blockedBy && ticket.blockedBy.length) metaChips.push(h('span', { className: 'dshb-chip dshb-chip-review' }, 'blocked by ' + ticket.blockedBy.length))
      if (ticket.archivedAt) metaChips.push(h('span', { className: 'dshb-chip' }, 'archived'))
      const checksChip = failedCount
        ? h('span', { className: 'dshb-chip dshb-chip-fail' }, 'checks ✗')
        : ranCount
          ? h('span', { className: 'dshb-chip dshb-chip-pass' }, 'checks ✓')
          : null
      return h(
        'button',
        {
          className: 'dshb-card' + (props.focused ? ' dshb-card-focused' : '') + (props.selected ? ' dshb-card-selected' : ''),
          type: 'button',
          onClick: () => (props.selectMode && props.onToggle ? props.onToggle(ticket.id) : props.onOpen(ticket.id)),
        },
        h('span', { className: 'dshb-cardkey' }, ticket.key),
        h('span', { className: 'dshb-cardtitle' }, ticket.title),
        h(
          'span',
          { className: 'dshb-cardmeta' },
          ticket.assignee
            ? h('span', { className: 'dshb-chip dshb-chip-agent' }, '@' + ticket.assignee)
            : h('span', { className: 'dshb-chip' }, 'unassigned'),
          props.queued ? h('span', { className: 'dshb-chip dshb-chip-review' }, props.queuePosition ? '#' + props.queuePosition + ' queued' : 'queued') : null,
          runChip(ticket),
          checksChip,
          ...metaChips,
          (ticket.activityCount ?? (Array.isArray(ticket.activity) ? ticket.activity.length : 0))
            ? h('span', { className: 'dshb-chip' }, (ticket.activityCount ?? ticket.activity.length) + ' events')
            : null,
          h('span', { className: 'dshb-dot' }),
          h('span', { className: 'dshb-chip' }, 'updated ' + timeAgo(ticket.updatedAt)),
        ),
      )
    }

    function RunSection(props) {
      const ticket = props.ticket
      const current = currentRun(ticket)
      const lastRun = Array.isArray(ticket.runs) && ticket.runs.length ? ticket.runs[ticket.runs.length - 1] : null
      const run = current || (ticket.status === 'done' || ticket.status === 'blocked' ? lastRun : null)
      const [budget, setBudget] = useState(ticket.budget && ticket.budget.tokens ? String(ticket.budget.tokens) : '')
      const [budgetMinutes, setBudgetMinutes] = useState(ticket.budget && ticket.budget.minutes ? String(ticket.budget.minutes) : '')
      useEffect(() => {
        setBudget(ticket.budget && ticket.budget.tokens ? String(ticket.budget.tokens) : '')
        setBudgetMinutes(ticket.budget && ticket.budget.minutes ? String(ticket.budget.minutes) : '')
      }, [ticket.id, ticket.budget && ticket.budget.tokens, ticket.budget && ticket.budget.minutes])
      const workflow = workflowOf(props.board)
      const canStart = ticket.status === workflow.dispatch && Boolean(ticket.assignee) && !current && !props.busy
      // Cancelling is not an exit from the review gate; Reject is.
      const canCancel = Boolean(current) && ticket.status !== workflow.gate && !props.busy
      const canRetry = ticket.status === workflow.blocked && !current && !props.busy
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dshb-section' },
          h('div', { className: 'dshb-seclabel' }, 'Run'),
          run
            ? h(
                'div',
                { className: 'dshb-runbox' },
                h('div', null, h('span', { className: 'dshb-chip dshb-chip-run' }, String(run.status).replace(/_/g, ' ')), ' ', h('span', { className: 'dshb-chip' }, fmtTokens(run.tokens) + ' tokens')),
                run.sessionId ? h('div', { className: 'dshb-runmeta' }, 'session: ' + run.sessionId) : null,
                run.worktree ? h('div', { className: 'dshb-runmeta' }, 'branch: ' + run.worktree.branch) : null,
                run.worktree && !run.merge ? h('div', { className: 'dshb-runmeta' }, 'checkout: ' + run.worktree.path) : null,
                run.worktreeError ? h('div', { className: 'dshb-runmeta' }, 'shared checkout: ' + run.worktreeError) : null,
                run.merge ? h('div', { className: 'dshb-runmeta' }, 'merged as ' + run.merge.short + ' on ' + run.merge.baseBranch) : null,
                run.subagents && run.subagents.length ? h('div', { className: 'dshb-runmeta' }, run.subagents.length + ' subagent session(s): ' + run.subagents.map(item => item.sessionId).join(', ')) : null,
                run.reason ? h('div', { className: 'dshb-runmeta' }, 'reason: ' + run.reason) : null,
              )
            : h(
                'div',
                { className: 'dshb-runmeta' },
                ticket.assignee
                  ? `No active run — start one when the ticket is ${labelOf(props.board, workflow.dispatch)}.`
                  : `Assign an agent, then move the ticket to ${labelOf(props.board, workflow.dispatch)} to let the board dispatch a worker.`,
              ),
          run && run.sessionId
            ? h(
                'div',
                { className: 'dshb-row' },
                h(
                  'button',
                  {
                    className: 'dshb-btn',
                    type: 'button',
                    onClick: () => props.onOpenSession && props.onOpenSession(run.sessionId),
                  },
                  'View run transcript',
                ),
              )
            : null,
          props.queued ? h('div', { className: 'dshb-runmeta' }, `Queued — waiting for a worker slot (${props.maxWorkers || 2} busy).`) : null,
          props.board && props.board.workspace
            ? h('div', { className: 'dshb-runmeta' }, 'workspace: ' + props.board.workspace)
            : null,
          h(
            'div',
            { className: 'dshb-row' },
            canStart ? h('button', { className: 'dshb-btn dshb-btn-primary', type: 'button', onClick: () => props.onAction({ action: 'start', id: ticket.id }) }, 'Start run') : null,
            canCancel ? h('button', { className: 'dshb-btn dshb-btn-danger', type: 'button', onClick: () => props.onAction({ action: 'cancel', id: ticket.id }) }, 'Cancel run') : null,
            canRetry ? h('button', { className: 'dshb-btn', type: 'button', onClick: () => props.onAction({ action: 'retry', id: ticket.id }) }, 'Retry') : null,
          ),
        ),
        h(
          'div',
          { className: 'dshb-section' },
          h('div', { className: 'dshb-seclabel' }, 'Token budget'),
          h(
            'div',
            { className: 'dshb-row' },
            h('input', {
              className: 'dshb-input',
              placeholder: 'unlimited',
              value: budget,
              onChange: event => setBudget(event.target.value),
            }),
            h('button', { className: 'dshb-btn', type: 'button', onClick: () => props.onAction({ action: 'budget', id: ticket.id, tokens: budget }) }, 'Save'),
          ),
          h(
            'div',
            { className: 'dshb-row' },
            h('input', {
              className: 'dshb-input',
              placeholder: 'wall-clock minutes (empty = unlimited)',
              value: budgetMinutes,
              onChange: event => setBudgetMinutes(event.target.value),
            }),
            h(
              'button',
              {
                className: 'dshb-btn',
                type: 'button',
                onClick: () => props.onAction({ action: 'update', id: ticket.id, budgetMinutes: budgetMinutes }),
              },
              'Save',
            ),
          ),
        ),
      )
    }

    function failedChecks(checks) {
      return (Array.isArray(checks) ? checks : []).filter(
        check => !check.skipped && !(check.exitCode === 0 && !check.timedOut && !check.aborted && !check.signal),
      )
    }

    function checksSignature(checks) {
      return JSON.stringify(
        (Array.isArray(checks) ? checks : []).map(check => ({ name: check.name ?? '', command: check.command ?? '', timeoutMs: check.timeoutMs ?? null })),
      )
    }

    function CheckList(props) {
      const checks = Array.isArray(props.checks) ? props.checks : []
      const [open, setOpen] = useState({})
      if (!checks.length) {
        return h(
          'div',
          { className: 'dshb-runmeta' },
          props.expected
            ? `No check has run yet (${props.expected} configured). Approving runs them first.`
            : 'No checks configured for this ticket.',
        )
      }
      return h(
        'div',
        { className: 'dshb-timeline' },
        checks.map((check, index) => {
          const failed = !check.skipped && !(check.exitCode === 0 && !check.timedOut && !check.aborted && !check.signal)
          const state = check.skipped ? 'skip' : failed ? 'fail' : 'pass'
          const label = check.skipped
            ? 'skipped' + (check.skippedReason === 'no-shell' ? ' (no shell service)' : '')
            : check.timedOut
              ? 'timed out'
              : check.aborted
                ? 'aborted'
                : check.signal
                  ? 'killed (' + check.signal + ')'
                  : 'exit ' + check.exitCode
          const output = [check.stdout, check.stderr, check.error].filter(Boolean).join('\n')
          return h(
            'div',
            { className: 'dshb-check dshb-check-' + state, key: check.name + ':' + index },
            h(
              'div',
              { className: 'dshb-checkhead' },
              h('span', { className: 'dshb-checkname' }, check.name),
              h('span', { className: 'dshb-runmeta' }, label + (check.durationMs ? ' · ' + (Math.round(check.durationMs / 100) / 10).toFixed(1) + 's' : '')),
              output
                ? h(
                    'button',
                    { className: 'dshb-btn', type: 'button', onClick: () => setOpen({ ...open, [index]: !open[index] }) },
                    open[index] ? 'Hide output' : 'Output',
                  )
                : null,
            ),
            h('div', { className: 'dshb-cmd' }, '$ ' + check.command),
            open[index] && output
              ? h('pre', { className: 'dshb-diffbox dshb-diffline', style: { margin: 0 } }, output)
              : null,
          )
        }),
      )
    }

    function DiffView(props) {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const [showPatch, setShowPatch] = useState(false)
      useEffect(() => {
        let alive = true
        setState({ loading: true, data: null, error: null })
        setShowPatch(false)
        fetchDiff(props.ticketId)
          .then(data => {
            if (alive) setState({ loading: false, data, error: null })
          })
          .catch(failure => {
            if (alive) setState({ loading: false, data: null, error: String(failure && failure.message ? failure.message : failure) })
          })
        return () => {
          alive = false
        }
      }, [props.ticketId])
      if (state.loading) return h('div', { className: 'dshb-runmeta' }, 'Loading the diff…')
      if (state.error) return h('div', { className: 'dshb-error', style: { margin: 0 } }, state.error)
      const data = state.data
      if (!data || !data.available) return h('div', { className: 'dshb-runmeta' }, (data && data.reason) || 'No diff available.')
      const files = Array.isArray(data.files) ? data.files : []
      const added = files.reduce((total, file) => total + (Number(file.added) || 0), 0)
      const removed = files.reduce((total, file) => total + (Number(file.removed) || 0), 0)
      const lines = String(data.patch || '').split('\n')
      const rendered = lines.slice(0, 1500).map((line, index) => {
        const cls = line.startsWith('@@')
          ? 'dshb-diffline dshb-diffhunk'
          : line.startsWith('+')
            ? 'dshb-diffline dshb-diffadd'
            : line.startsWith('-')
              ? 'dshb-diffline dshb-diffdel'
              : 'dshb-diffline'
        return h('div', { className: cls, key: index }, line || ' ')
      })
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dshb-runmeta' },
          (data.branch || 'branch') + ' → ' + (data.baseBranch || 'base') + ' · ' + files.length + ' files · +' + added + ' −' + removed,
        ),
        h(
          'div',
          { className: 'dshb-timeline' },
          files.slice(0, 40).map(file =>
            h(
              'div',
              { className: 'dshb-histrow', key: file.path },
              h('span', { className: 'dshb-cmd' }, file.path),
              h('span', { className: 'dshb-runmeta' }, file.added === null ? 'binary' : '+' + file.added + ' −' + file.removed),
            ),
          ),
          files.length > 40 ? h('div', { className: 'dshb-runmeta' }, '… ' + (files.length - 40) + ' more files') : null,
        ),
        h(
          'button',
          { className: 'dshb-btn', type: 'button', onClick: () => setShowPatch(!showPatch) },
          (showPatch ? 'Hide patch' : 'Show patch') + (data.truncated ? ' (truncated)' : ''),
        ),
        showPatch
          ? h(
              'div',
              { className: 'dshb-diffbox' },
              rendered,
              lines.length > 1500 ? h('div', { className: 'dshb-runmeta' }, '… preview capped at 1500 lines') : null,
            )
          : null,
      )
    }

    function RunHistory(props) {
      const runs = Array.isArray(props.runs) ? [...props.runs].reverse() : []
      if (runs.length < 2) return null
      return h(
        'div',
        { className: 'dshb-hist' },
        runs.map((run, index) =>
          h(
            'div',
            { className: 'dshb-histrow', key: run.id || index },
            h('span', { className: 'dshb-chip' }, String(run.status).replace(/_/g, ' ')),
            h('span', { className: 'dshb-runmeta' }, fmtTokens(run.tokens) + ' tok'),
            run.merge ? h('span', { className: 'dshb-runmeta' }, 'merged ' + run.merge.short) : null,
            run.reason ? h('span', { className: 'dshb-runmeta' }, run.reason) : null,
          ),
        ),
      )
    }

    function ArtifactList(props) {
      const artifacts = Array.isArray(props.artifacts) ? props.artifacts : []
      if (!artifacts.length) return null
      return h(
        'div',
        { className: 'dshb-timeline' },
        artifacts.map((artifact, index) =>
          h(
            'div',
            { className: 'dshb-event', key: index },
            h(
              'span',
              null,
              artifact.kind + ': ',
              /^https?:\/\//i.test(artifact.uri)
                ? h('a', { className: 'dshb-link', href: artifact.uri, target: '_blank', rel: 'noreferrer' }, artifact.label || artifact.uri)
                : h('span', null, artifact.label || artifact.uri),
            ),
            h('span', { className: 'dshb-eventby' }, artifact.uri),
          ),
        ),
      )
    }

    function ReviewGate(props) {
      const ticket = props.ticket
      const run = props.run
      const board = props.board
      const workflow = workflowOf(board)
      const checks = run && Array.isArray(run.checks) ? run.checks : []
      const failed = failedChecks(checks)
      const checksStale = Boolean(run) && checks.length > 0 && run.checksKey !== checksSignature(ticket.checks)
      const [rejecting, setRejecting] = useState(false)
      const [reason, setReason] = useState('')
      const [overrideChecks, setOverrideChecks] = useState(false)
      const [overrideReason, setOverrideReason] = useState('')
      const [error, setError] = useState(null)
      const call = async payload => {
        setError(null)
        try {
          await props.onAction(payload)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        }
      }
      const approve = async () => {
        const branch = run && run.worktree ? run.worktree.branch : null
        const base = run && run.worktree ? run.worktree.baseBranch || 'the base checkout' : null
        const question = branch
          ? 'Squash-merge ' + branch + ' into ' + base + ' and delete the branch?'
          : 'Approve this ticket as ' + labelOf(board, workflow.done) + '?'
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) return
        await call({
          action: 'approve',
          id: ticket.id,
          ...(failed.length && overrideChecks ? { overrideChecks: true, reason: overrideReason } : {}),
        })
      }
      const submitReject = async () => {
        await call({ action: 'reject', id: ticket.id, reason })
        setReason('')
        setRejecting(false)
      }
      return h(
        'div',
        { className: 'dshb-review' },
        h('div', { className: 'dshb-seclabel' }, 'Review'),
        error ? h('div', { className: 'dshb-error', style: { margin: 0 } }, error) : null,
        ticket.acceptance && ticket.acceptance.length
          ? h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Acceptance criteria'),
              h('ul', { className: 'dshb-accept' }, ticket.acceptance.map((item, index) => h('li', { key: index }, item))),
            )
          : null,
        h(
          'div',
          { className: 'dshb-section' },
          h('div', { className: 'dshb-seclabel' }, 'Checks'),
          checksStale
            ? h('div', { className: 'dshb-runmeta' }, 'The checks changed since they last ran; they will run again when you approve.')
            : null,
          run && run.checksMeta && run.checksMeta.dirty
            ? h('div', { className: 'dshb-error', style: { margin: 0 } }, 'The run checkout has uncommitted tracked changes; approval is refused until the worker commits.')
            : null,
          h(CheckList, { checks, expected: Array.isArray(ticket.checks) ? ticket.checks.length : 0 }),
        ),
        h('div', { className: 'dshb-section' }, h('div', { className: 'dshb-seclabel' }, 'Change'), h(DiffView, { ticketId: ticket.id })),
        ticket.artifacts && ticket.artifacts.length
          ? h('div', { className: 'dshb-section' }, h('div', { className: 'dshb-seclabel' }, 'Artifacts'), h(ArtifactList, { artifacts: ticket.artifacts }))
          : null,
        ticket.runs && ticket.runs.length > 1
          ? h('div', { className: 'dshb-section' }, h('div', { className: 'dshb-seclabel' }, 'Run history'), h(RunHistory, { runs: ticket.runs }))
          : null,
        failed.length
          ? h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-runmeta' }, failed.length + ' check' + (failed.length === 1 ? '' : 's') + ' failed (' + failed.map(check => check.name).join(', ') + ').'),
              h(
                'label',
                { className: 'dshb-histrow', style: { gap: '6px' } },
                h('input', { type: 'checkbox', checked: overrideChecks, onChange: event => setOverrideChecks(event.target.checked) }),
                h('span', null, 'Approve despite the failing checks'),
              ),
              overrideChecks
                ? h('input', {
                    className: 'dshb-input',
                    placeholder: 'Required: why is it safe to approve anyway? (recorded on the ticket)',
                    value: overrideReason,
                    onChange: event => setOverrideReason(event.target.value),
                  })
                : null,
            )
          : null,
        rejecting
          ? h(
              React.Fragment,
              null,
              h('textarea', {
                className: 'dshb-textarea',
                placeholder: 'Why is this rejected? The reason is sent back to the same worker session.',
                value: reason,
                onChange: event => setReason(event.target.value),
              }),
              h(
                'div',
                { className: 'dshb-row' },
                h(
                  'button',
                  { className: 'dshb-btn dshb-btn-danger', type: 'button', disabled: !reason.trim() || props.busy, onClick: submitReject },
                  'Reject and resume',
                ),
                h('button', { className: 'dshb-btn', type: 'button', onClick: () => setRejecting(false) }, 'Back'),
              ),
            )
          : h(
              React.Fragment,
              null,
              run && run.worktree
                ? h('div', { className: 'dshb-runmeta' }, 'Approving squash-merges ' + run.worktree.branch + ' into ' + (run.worktree.baseBranch || 'the base checkout') + ' and deletes the branch.')
                : null,
              h(
                'div',
                { className: 'dshb-row' },
                h(
                  'button',
                  {
                    className: 'dshb-btn dshb-btn-primary',
                    type: 'button',
                    disabled: props.busy || Boolean(failed.length && (!overrideChecks || !overrideReason.trim())),
                    title:
                      failed.length && !overrideChecks
                        ? 'A check failed: fix it or tick the override above'
                        : failed.length && !overrideReason.trim()
                          ? 'An override reason is required'
                          : undefined,
                    onClick: approve,
                  },
                  (failed.length && overrideChecks ? 'Approve despite failures → ' : 'Approve → ') + labelOf(board, workflow.done),
                ),
                h('button', { className: 'dshb-btn dshb-btn-danger', type: 'button', disabled: props.busy, onClick: () => setRejecting(true) }, 'Reject…'),
              ),
            ),
      )
    }

    function TicketDrawer(props) {
      const ticket = props.ticket
      const workflow = workflowOf(props.board)
      const pullRequest = [...(ticket.runs ?? [])].reverse().find(run => run.pullRequest)?.pullRequest ?? null
      const workerRun = currentRun(ticket) ?? [...(ticket.runs ?? [])].reverse().find(run => run.sessionId)
      const transcriptSessions = []
      if (workerRun?.sessionId) transcriptSessions.push({ id: workerRun.sessionId, label: 'worker' })
      if (ticket.plan?.sessionId) transcriptSessions.push({ id: ticket.plan.sessionId, label: 'planning' })
      if (ticket.reviewSessionId) transcriptSessions.push({ id: ticket.reviewSessionId, label: 'reviewer' })
      if (ticket.needsInput?.sessionId && !transcriptSessions.some(item => item.id === ticket.needsInput.sessionId)) {
        transcriptSessions.push({ id: ticket.needsInput.sessionId, label: 'paused worker' })
      }
      const [transcriptChoice, setTranscriptChoice] = useState('')
      const transcriptSessionId = transcriptSessions.find(item => item.id === transcriptChoice)?.id ?? transcriptSessions[0]?.id ?? null
      const [transcript, setTranscript] = useState(null)
      const [transcriptBusy, setTranscriptBusy] = useState(false)
      const [transcriptError, setTranscriptError] = useState(null)
      const [transcriptLive, setTranscriptLive] = useState(false)
      useEffect(() => {
        setTranscript(null)
        setTranscriptError(null)
        setTranscriptChoice('')
      }, [ticket.id])
      const loadTranscript = async () => {
        if (!transcriptSessionId) return
        setTranscriptBusy(true)
        setTranscriptError(null)
        try {
          const response = await fetch('/api/board/transcript?sessionId=' + encodeURIComponent(transcriptSessionId))
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || 'transcript request failed (' + response.status + ')')
          setTranscript(body)
        } catch (error) {
          setTranscriptError(String(error && error.message ? error.message : error))
        } finally {
          setTranscriptBusy(false)
        }
      }
      useEffect(() => {
        if (!transcriptLive || !transcriptSessionId) return undefined
        const timer = setInterval(() => {
          void loadTranscript()
        }, 3000)
        return () => clearInterval(timer)
      }, [transcriptLive, transcriptSessionId])
      const statusOptions = [ticket.status, ...transitionsFrom(props.board, ticket.status)].filter(
        (value, index, all) => all.indexOf(value) === index,
      )
      // A gate ticket with a live run or an unmerged branch has one way out:
      // Approve or Reject. One parked by hand with no work can be moved back.
      const openWork =
        Boolean(ticket.currentRunId) ||
        (Array.isArray(ticket.runs) &&
          ticket.runs.some(run => run.worktree && !run.merge && !run.prunedAt && !run.worktree.superseded))
      const statusLocked = ticket.status === workflow.gate && openWork
      const [comment, setComment] = useState('')
      const [assignee, setAssignee] = useState(ticket.assignee || '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [titleDraft, setTitleDraft] = useState(ticket.title || '')
      const [descriptionDraft, setDescriptionDraft] = useState(ticket.description || '')
      const [acceptanceDraft, setAcceptanceDraft] = useState(Array.isArray(ticket.acceptance) ? ticket.acceptance.join('\n') : '')
      const ticketIndex = Array.isArray(props.tickets) ? props.tickets : []
      const dependencyLabel = id => {
        const dependency = ticketIndex.find(item => item.id === id)
        return dependency ? dependency.key : id
      }
      const [dependenciesDraft, setDependenciesDraft] = useState(
        Array.isArray(ticket.blockedBy) ? ticket.blockedBy.map(dependencyLabel).join(', ') : '',
      )
      const [priorityDraft, setPriorityDraft] = useState(String(ticket.priority || 0))
      const [presets, setPresets] = useState([])
      const [dirty, setDirty] = useState({ title: false, description: false, acceptance: false, dependencies: false, priority: false, assignee: false })
      const [notice, setNotice] = useState(null)
      const [planFeedback, setPlanFeedback] = useState('')
      const closeRef = useRef(null)
      const drawerRef = useRef(null)
      const returnFocusRef = useRef(null)
      const checksText = Array.isArray(ticket.checks)
        ? ticket.checks
            .map(check => (check.name && check.name !== check.command ? check.name + ' :: ' : '') + check.command + (check.timeoutMs ? ' :: ' + check.timeoutMs : ''))
            .join('\n')
        : ''
      const [checksDraft, setChecksDraft] = useState(checksText)
      const [checksDirty, setChecksDirty] = useState(false)
      useEffect(() => {
        setAssignee(ticket.assignee || '')
        setDirty({ title: false, description: false, acceptance: false, dependencies: false, priority: false, assignee: false })
        setNotice(null)
      }, [ticket.id])
      useEffect(() => {
        setChecksDraft(checksText)
        setChecksDirty(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ticket.id])
      useEffect(() => {
        if (!checksDirty) setChecksDraft(checksText)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [checksText, checksDirty])
      useEffect(() => {
        if (!dirty.title) setTitleDraft(ticket.title || '')
        if (!dirty.description) setDescriptionDraft(ticket.description || '')
        if (!dirty.acceptance) setAcceptanceDraft(Array.isArray(ticket.acceptance) ? ticket.acceptance.join('\n') : '')
        if (!dirty.dependencies) setDependenciesDraft(Array.isArray(ticket.blockedBy) ? ticket.blockedBy.map(dependencyLabel).join(', ') : '')
        if (!dirty.priority) setPriorityDraft(String(ticket.priority || 0))
        if (!dirty.assignee) setAssignee(ticket.assignee || '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ticket.title, ticket.description, ticket.acceptance, ticket.assignee, dirty])
      useEffect(() => {
        let alive = true
        fetchPresets().then(list => {
          if (alive) setPresets(list)
        })
        return () => {
          alive = false
        }
      }, [])
      // Dialog hygiene: remember focus, move it in, close on Escape, contain Tab.
      useEffect(() => {
        returnFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null
        if (closeRef.current && typeof closeRef.current.focus === 'function') closeRef.current.focus()
        const onKeyDown = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            props.onClose()
            return
          }
          if (event.key !== 'Tab' || !drawerRef.current) return
          const focusable = drawerRef.current.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
          )
          if (!focusable.length) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          const target = returnFocusRef.current
          if (target && typeof target.focus === 'function') target.focus()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      const isGate = ticket.status === workflow.gate
      const activeRun = currentRun(ticket)
      const unmergedRun = Array.isArray(ticket.runs) ? [...ticket.runs].reverse().find(candidate => candidate.worktree && !candidate.merge) : null
      const reviewRun = (activeRun && activeRun.worktree ? activeRun : null) || unmergedRun || activeRun || null
      const isLive = Boolean(activeRun && (activeRun.status === 'running' || activeRun.status === 'starting'))
      const run = async payload => {
        setBusy(true)
        setError(null)
        try {
          const next = await props.onAction(payload)
          return next || true
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
          return false
        } finally {
          setBusy(false)
        }
      }
      const saveDetails = async () => {
        const payload = { action: 'update', id: ticket.id }
        if (dirty.title) payload.title = titleDraft
        if (dirty.description) payload.description = descriptionDraft
        if (dirty.acceptance) payload.acceptance = acceptanceDraft
        if (dirty.dependencies) payload.blockedBy = dependenciesDraft
        if (dirty.priority) payload.priority = priorityDraft
        if (!dirty.title && !dirty.description && !dirty.acceptance && !dirty.dependencies && !dirty.priority) {
          setNotice('Nothing to save.')
          return
        }
        const ok = await run(payload)
        if (ok) {
          setDirty(current => ({ ...current, title: false, description: false, acceptance: false, dependencies: false, priority: false }))
          setNotice('Details saved.')
        }
      }
      const addComment = async event => {
        event.preventDefault()
        const text = comment.trim()
        if (!text) return
        const result = await run({ action: 'comment', id: ticket.id, text })
        if (!result) return
        setComment('')
        const delivery = result.delivery
        if (delivery && !delivery.delivered) {
          setNotice('Saved as a note — ' + delivery.reason + '. It will reach the worker in the next run.')
        } else {
          setNotice(delivery && delivery.delivered ? 'Delivered to the running worker.' : null)
        }
      }
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dshb-overlay', onClick: props.onClose }),
        h(
          'aside',
          { ref: drawerRef, className: 'dshb-drawer', role: 'dialog', 'aria-modal': 'true', tabIndex: -1, 'aria-label': ticket.key + ' ' + ticket.title },
          h(
            'div',
            { className: 'dshb-dhead' },
            h(
              'div',
              { style: { flex: '1 1 auto' } },
              h('div', { className: 'dshb-cardkey' }, ticket.key),
              h('div', { className: 'dshb-dtitle' }, ticket.title),
            ),
            h(
              'button',
              {
                className: 'dshb-btn',
                type: 'button',
                onClick: async () => {
                  try {
                    const url = window.location.origin + window.location.pathname + window.location.search + '#' + ticket.key
                    await navigator.clipboard.writeText(url)
                    setNotice('Ticket link copied.')
                  } catch {
                    setNotice('Could not copy the link.')
                  }
                },
              },
              'Copy link',
            ),
            h('button', { ref: closeRef, className: 'dshb-btn', type: 'button', onClick: props.onClose }, 'Close'),
          ),
          h(
            'div',
            { className: 'dshb-dbody' },
            error ? h('div', { className: 'dshb-error' }, error) : null,
            notice ? h('div', { className: 'dshb-warn' }, notice) : null,
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Status'),
              h(
                'select',
                {
                  className: 'dshb-sel',
                  'aria-label': 'Status',
                  value: ticket.status,
                  disabled: busy || statusLocked,
                  onChange: event => run({ action: 'update', id: ticket.id, status: event.target.value }),
                },
                statusOptions.map(status => h('option', { key: status, value: status }, labelOf(props.board, status))),
              ),
              statusLocked
                ? h('div', { className: 'dshb-runmeta' }, 'Approve or Reject closes this ticket; the status dropdown is locked while the run is open.')
                : null,
            ),
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Assignee'),
              h(
                'div',
                { className: 'dshb-row' },
                h('input', {
                  className: 'dshb-input',
                  placeholder: 'agent id (empty to unassign)',
                  list: 'dshb-presets-' + ticket.id,
                  value: assignee,
                  onChange: event => {
                    setAssignee(event.target.value)
                    setDirty(current => ({ ...current, assignee: true }))
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dshb-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: async () => {
                      const ok = await run({ action: 'assign', id: ticket.id, assignee: assignee.trim() })
                      if (ok) setDirty(current => ({ ...current, assignee: false }))
                    },
                  },
                  'Assign',
                ),
              ),
              presets.length
                ? h(
                    'datalist',
                    { id: 'dshb-presets-' + ticket.id },
                    presets.map(preset => h('option', { key: preset.id, value: preset.id }, (preset.name || preset.id) + (preset.broken ? ' (broken)' : ''))),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Plan'),
              h(
                'div',
                { className: 'dshb-runmeta' },
                ticket.plan
                  ? 'v' + ticket.plan.version + ' · ' + ticket.plan.status + (ticket.plan.decomposition.length ? ' · ' + ticket.plan.decomposition.length + ' proposed subtask(s)' : '')
                  : 'No plan yet — open a planning session to brainstorm this ticket.',
              ),
              ticket.teamTaskId ? h('div', { className: 'dshb-runmeta' }, 'team task: ' + ticket.teamTaskId) : null,
              ticket.review
                ? h(
                    'div',
                    { className: ticket.review.verdict === 'approved' ? 'dshb-live' : 'dshb-warn', style: { margin: 0 } },
                    'reviewer: ' + ticket.review.verdict + (ticket.review.notes ? ' — ' + ticket.review.notes : ''),
                  )
                : null,
              props.board && props.board.pullRequest && props.board.pullRequest.enabled && ticket.status === workflow.gate && !pullRequest
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h(
                      'button',
                      {
                        className: 'dshb-btn',
                        type: 'button',
                        disabled: busy,
                        onClick: async () => {
                          try {
                            const next = await run({ action: 'open-pr', id: ticket.id })
                            const url = next && next.pullRequest && next.pullRequest.url
                            setNotice(url ? 'Pull request opened: ' + url : 'Pull request opened.')
                          } catch (error) {
                            setNotice(String(error && error.message ? error.message : error))
                          }
                        },
                      },
                      'Open pull request',
                    ),
                  )
                : null,
              pullRequest
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h(
                      'a',
                      { className: 'dshb-btn', href: pullRequest.url || '#', target: '_blank', rel: 'noreferrer' },
                      'PR #' + (pullRequest.number ?? '?'),
                    ),
                    h(
                      'button',
                      {
                        className: 'dshb-btn',
                        type: 'button',
                        disabled: busy,
                        onClick: async () => {
                          if (typeof window.confirm === 'function' && !window.confirm('Mark the pull request merged?')) return
                          await run({ action: 'pr-merged', id: ticket.id })
                        },
                      },
                      'Mark PR merged',
                    ),
                  )
                : null,
              ticket.reviewSessionId && props.onOpenSession
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h(
                      'button',
                      { className: 'dshb-btn', type: 'button', onClick: () => props.onOpenSession(ticket.reviewSessionId) },
                      'Open reviewer session',
                    ),
                  )
                : null,
              ticket.needsInput
                ? h(
                    'div',
                    { className: 'dshb-warn', style: { margin: 0 } },
                    'Waiting for your answer: ' + ticket.needsInput.question,
                  )
                : null,
              ticket.needsInput && ticket.needsInput.sessionId && props.onOpenSession
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h(
                      'button',
                      { className: 'dshb-btn', type: 'button', onClick: () => props.onOpenSession(ticket.needsInput.sessionId) },
                      'Open worker session',
                    ),
                  )
                : null,
              ticket.plan && ticket.plan.markdown
                ? h('div', { className: 'dshb-md', style: { maxHeight: 260, overflow: 'auto' } }, renderMarkdown(ticket.plan.markdown, props.onOpenTicket))
                : null,
              ticket.plan && ticket.plan.feedback.length
                ? h('div', { className: 'dshb-runmeta' }, 'last feedback: ' + ticket.plan.feedback[ticket.plan.feedback.length - 1])
                : null,
              ticket.needsInput
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h('input', {
                      className: 'dshb-input',
                      placeholder: 'Answer the worker…',
                      value: planFeedback,
                      onChange: event => setPlanFeedback(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        className: 'dshb-btn dshb-btn-primary',
                        type: 'button',
                        disabled: busy || !planFeedback.trim(),
                        onClick: async () => {
                          const ok = await run({ action: 'answer', id: ticket.id, answer: planFeedback })
                          if (ok) setPlanFeedback('')
                        },
                      },
                      'Answer',
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'dshb-row' },
                !ticket.plan || !ticket.plan.sessionId
                  ? h(
                      'button',
                      {
                        className: 'dshb-btn',
                        type: 'button',
                        disabled: busy,
                        onClick: async () => {
                          const next = await run({ action: 'plan-start', id: ticket.id })
                          if (next && next.planSessionId && props.onOpenSession) props.onOpenSession(next.planSessionId)
                        },
                      },
                      'Start planning',
                    )
                  : h(
                      'button',
                      { className: 'dshb-btn', type: 'button', onClick: () => props.onOpenSession && props.onOpenSession(ticket.plan.sessionId) },
                      'Open planning session',
                    ),
                ticket.plan && ticket.plan.status === 'submitted'
                  ? h(
                      'button',
                      {
                        className: 'dshb-btn dshb-btn-primary',
                        type: 'button',
                        disabled: busy,
                        onClick: () => {
                          const extra = ticket.plan.decomposition.length ? ' and create ' + ticket.plan.decomposition.length + ' subtask(s)' : ''
                          if (typeof window !== 'undefined' && window.confirm && !window.confirm('Approve this plan? Work can start' + extra + '.')) return
                          void run({ action: 'plan-approve', id: ticket.id })
                        },
                      },
                      'Approve plan',
                    )
                  : null,
              ),
              ticket.plan && ticket.plan.status !== 'approved'
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h('input', {
                      className: 'dshb-input',
                      placeholder: 'Request plan changes…',
                      value: planFeedback,
                      onChange: event => setPlanFeedback(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        className: 'dshb-btn',
                        type: 'button',
                        disabled: busy || !planFeedback.trim(),
                        onClick: async () => {
                          const ok = await run({ action: 'plan-changes', id: ticket.id, feedback: planFeedback })
                          if (ok) setPlanFeedback('')
                        },
                      },
                      'Send',
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Transcript'),
              transcriptSessionId
                ? h(
                    'div',
                    { className: 'dshb-row' },
                    h(
                      'button',
                      { className: 'dshb-btn', type: 'button', disabled: transcriptBusy, onClick: () => void loadTranscript() },
                      transcriptBusy ? 'Loading…' : transcript ? 'Reload transcript' : 'Show transcript',
                    ),
                    h(
                      'button',
                      { className: 'dshb-btn', type: 'button', onClick: () => setTranscriptLive(value => !value) },
                      transcriptLive ? 'Live: on' : 'Live: off',
                    ),
                    transcriptSessions.length > 1
                      ? h(
                          'select',
                          {
                            className: 'dshb-sel',
                            'aria-label': 'Transcript session',
                            value: transcriptSessionId ?? '',
                            onChange: event => setTranscriptChoice(event.target.value),
                          },
                          transcriptSessions.map(item => h('option', { key: item.id, value: item.id }, item.label + ' · ' + item.id)),
                        )
                      : h('span', { className: 'dshb-runmeta' }, transcriptSessionId),
                  )
                : h('div', { className: 'dshb-runmeta' }, 'No worker session recorded for this ticket.'),
              transcriptError ? h('div', { className: 'dshb-error' }, transcriptError) : null,
              transcript && transcript.messages && transcript.messages.length
                ? h(
                    'div',
                    { className: 'dshb-timeline' },
                    transcript.messages.map((message, index) =>
                      h(
                        'div',
                        { className: 'dshb-event', key: index },
                        h('span', { className: 'dshb-chip' }, message.role),
                        h('div', { className: 'dshb-md', style: { marginTop: 3 } }, renderMarkdown(message.text, props.onOpenTicket)),
                      ),
                    ),
                  )
                : null,
              transcript && (!transcript.messages || transcript.messages.length === 0)
                ? h('div', { className: 'dshb-runmeta' }, 'No messages found in this session log.')
                : null,
              transcript && transcript.truncated ? h('div', { className: 'dshb-runmeta' }, 'showing the last 60 messages') : null,
            ),
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Ticket details'),
              h('input', {
                className: 'dshb-input',
                placeholder: 'Title',
                value: titleDraft,
                onChange: event => {
                  setTitleDraft(event.target.value)
                  setDirty(current => ({ ...current, title: true }))
                },
              }),
              h('textarea', {
                className: 'dshb-textarea',
                placeholder: 'Description',
                value: descriptionDraft,
                onChange: event => {
                  setDescriptionDraft(event.target.value)
                  setDirty(current => ({ ...current, description: true }))
                },
              }),
              h('textarea', {
                className: 'dshb-textarea',
                placeholder: 'Acceptance criteria, one per line',
                value: acceptanceDraft,
                onChange: event => {
                  setAcceptanceDraft(event.target.value)
                  setDirty(current => ({ ...current, acceptance: true }))
                },
              }),
              h('input', {
                className: 'dshb-input',
                placeholder: 'Priority (higher runs first)',
                value: priorityDraft,
                onChange: event => {
                  setPriorityDraft(event.target.value)
                  setDirty(current => ({ ...current, priority: true }))
                },
              }),
              h('textarea', {
                className: 'dshb-textarea',
                placeholder: 'Blocked by (ticket keys, comma separated)',
                value: dependenciesDraft,
                onChange: event => {
                  setDependenciesDraft(event.target.value)
                  setDirty(current => ({ ...current, dependencies: true }))
                },
              }),
              h(
                'div',
                { className: 'dshb-row' },
                h('button', { className: 'dshb-btn', type: 'button', disabled: busy, onClick: saveDetails }, 'Save details'),
                ticket.status === workflow.done || ticket.archivedAt
                  ? h(
                      'button',
                      {
                        className: 'dshb-btn',
                        type: 'button',
                        disabled: busy,
                        onClick: () => run({ action: ticket.archivedAt ? 'unarchive' : 'archive', id: ticket.id }),
                      },
                      ticket.archivedAt ? 'Restore' : 'Archive',
                    )
                  : null,
              ),
            ),
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Verification checks'),
              h('textarea', {
                className: 'dshb-textarea',
                placeholder: 'Verification commands, one per line: name :: command (:: timeoutMs)',
                value: checksDraft,
                onChange: event => {
                  setChecksDraft(event.target.value)
                  setChecksDirty(true)
                },
              }),
              h(
                'div',
                { className: 'dshb-row' },
                h(
                  'button',
                  {
                    className: 'dshb-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: async () => {
                      if (checksDraft === checksText) {
                        setNotice('Checks unchanged.')
                        return
                      }
                      const ok = await run({ action: 'update', id: ticket.id, checks: checksDraft })
                      if (ok) {
                        setChecksDirty(false)
                        setNotice('Checks saved.')
                      }
                    },
                  },
                  'Save checks',
                ),
              ),
              h('div', { className: 'dshb-runmeta' }, 'Checks run in the run checkout when a run settles to Review, and on approval when the run has no result yet.'),
            ),
            isGate
              ? h(ReviewGate, {
                  ticket,
                  run: reviewRun,
                  board: props.board,
                  busy,
                  onAction: run,
                })
              : null,
            h(RunSection, {
              ticket,
              board: props.board,
              queued: props.queued,
              maxWorkers: props.maxWorkers || (props.board && props.board.maxWorkers),
              onAction: run,
              busy,
              onOpenSession: props.onOpenSession,
            }),
            ticket.description
              ? h(
                  'div',
                  { className: 'dshb-section' },
                  h('div', { className: 'dshb-seclabel' }, 'Description'),
                  h('div', { className: 'dshb-md' }, renderMarkdown(ticket.description, props.onOpenTicket)),
                )
              : null,
            !isGate && ticket.acceptance && ticket.acceptance.length
              ? h(
                  'div',
                  { className: 'dshb-section' },
                  h('div', { className: 'dshb-seclabel' }, 'Acceptance criteria'),
                  h('ul', { className: 'dshb-accept' }, ticket.acceptance.map((item, index) => h('li', { key: index }, item))),
                )
              : null,
            !isGate && ticket.artifacts && ticket.artifacts.length
              ? h(
                  'div',
                  { className: 'dshb-section' },
                  h('div', { className: 'dshb-seclabel' }, 'Artifacts'),
                  h(
                    'div',
                    { className: 'dshb-timeline' },
                    ticket.artifacts.map((artifact, index) =>
                      h('div', { className: 'dshb-event', key: index }, h('span', null, artifact.kind + ': ' + artifact.label), h('span', { className: 'dshb-eventby' }, artifact.uri)),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'dshb-section' },
              h('div', { className: 'dshb-seclabel' }, 'Activity'),
              h(
                'div',
                { className: 'dshb-timeline' },
                ticket.activity.map((event, index) =>
                  h(
                    'div',
                    { className: 'dshb-event', key: index },
                    h('span', null, renderInline(event.text, props.onOpenTicket)),
                    h(
                      'span',
                      { className: 'dshb-eventby' },
                      event.by + ' · ' + event.kind + ' · ' + timeAgo(event.at) + (event.deliveredTo ? ' · delivered to worker' : ''),
                    ),
                  ),
                ),
              ),
            ),
            h(
              'form',
              { className: 'dshb-section', onSubmit: addComment },
              h('div', { className: 'dshb-seclabel' }, isLive ? 'Send to worker' : 'Comment'),
              isLive ? h('div', { className: 'dshb-live' }, 'The worker is running; this comment is delivered to it immediately.') : null,
              h('textarea', {
                className: 'dshb-textarea',
                placeholder: isLive ? 'Steer the running worker…' : 'Leave a note; it is replayed in the next worker brief…',
                value: comment,
                onChange: event => setComment(event.target.value),
              }),
              h('button', { className: 'dshb-btn dshb-btn-primary', type: 'submit', disabled: busy }, isLive ? 'Send to worker' : 'Comment'),
            ),
          ),
        ),
      )
    }

    function BoardPage(props) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState(null)
      const [showArchived, setShowArchived] = useState(false)
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState(null)
      const detailLoading = useRef(false)
      const [inboxOpen, setInboxOpen] = useState(false)
      const [inboxItems, setInboxItems] = useState([])
      const [inboxBusy, setInboxBusy] = useState(false)
      const [insightsOpen, setInsightsOpen] = useState(false)
      const [savedViews, setSavedViews] = useState(() => readSavedViews())
      const [activeView, setActiveView] = useState('')
      const [query, setQuery] = useState(() => readFilterPrefs().query || '')
      const [statusFilter, setStatusFilter] = useState(() => readFilterPrefs().status || '')
      const [assigneeFilter, setAssigneeFilter] = useState(() => readFilterPrefs().assignee || '')
      const [specialFilter, setSpecialFilter] = useState(() => readFilterPrefs().special || '')
      const [focusIndex, setFocusIndex] = useState(-1)
      const [selectMode, setSelectMode] = useState(false)
      const [selection, setSelection] = useState(() => new Set())
      const [batchBusy, setBatchBusy] = useState(false)
      const [batchNotice, setBatchNotice] = useState(null)
      const [batchAssignee, setBatchAssignee] = useState('')
      const pendingHash = useRef(false)
      const searchRef = useRef(null)

      const appliedRevision = useRef(-1)
      const inFlight = useRef(false)
      const pendingRefresh = useRef(false)
      const refresh = React.useCallback(async function load() {
        if (inFlight.current) {
          pendingRefresh.current = true
          return null
        }
        inFlight.current = true
        try {
          const next = await fetchBoard()
          const revision = typeof next.revision === 'number' ? next.revision : null
          // A slower, older response must never repaint over a newer one.
          if (revision !== null && revision < appliedRevision.current) return next
          if (revision !== null) appliedRevision.current = revision
          setData(next)
          setError(null)
          return next
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
          return null
        } finally {
          inFlight.current = false
          if (pendingRefresh.current) {
            pendingRefresh.current = false
            void load()
          }
        }
      }, [])

      useEffect(() => {
        let alive = true
        const reload = () => {
          if (!alive) return
          void refresh()
          if (selected) void loadDetail(selected)
        }
        const unsubscribe = live.subscribe(reload)
        // Safety net only while the push channel is down; with SSE this is idle.
        const timer = setInterval(() => {
          if (alive && !live.connected) void refresh()
        }, 15000)
        return () => {
          alive = false
          unsubscribe()
          clearInterval(timer)
        }
      }, [refresh])

      const loadDetail = React.useCallback(async id => {
        if (!id || detailLoading.current) return null
        detailLoading.current = true
        try {
          const ticket = await fetchTicket(id)
          setDetail(ticket)
          setDetailError(null)
          return ticket
        } catch (failure) {
          setDetailError(String(failure && failure.message ? failure.message : failure))
          return null
        } finally {
          detailLoading.current = false
        }
      }, [])

      useEffect(() => {
        if (!selected) {
          setDetail(null)
          setDetailError(null)
          return
        }
        void loadDetail(selected)
      }, [selected, loadDetail])

      const run = async payload => {
        const next = await sendAction(payload)
        if (next && typeof next.revision === 'number') {
          appliedRevision.current = Math.max(appliedRevision.current, next.revision)
        }
        setData(next)
        setError(null)
        if (selected) void loadDetail(selected)
        return next
      }

      const states = (data && data.board && data.board.states) || []
      const allTickets = (data && data.tickets) || []
      const archivedCount = allTickets.filter(ticket => ticket.archivedAt).length
      const scopedTickets = showArchived ? allTickets : allTickets.filter(ticket => !ticket.archivedAt)
      const assignees = [...new Set(allTickets.map(ticket => ticket.assignee).filter(Boolean))].sort()
      const queryText = query.trim().toLowerCase()
      const tickets = scopedTickets.filter(ticket => {
        if (queryText) {
          const haystack = [ticket.key, ticket.title, ticket.description || '', ticket.assignee || ''].join(' ').toLowerCase()
          if (!haystack.includes(queryText)) return false
        }
        if (statusFilter && ticket.status !== statusFilter) return false
        if (assigneeFilter && ticket.assignee !== assigneeFilter) return false
        if (specialFilter === 'plan_review' && ticket.planStatus !== 'submitted') return false
        if (specialFilter === 'needs_input' && !ticket.needsInput) return false
        if (specialFilter === 'blocked' && ticket.status !== workflowOf(data && data.board).blocked) return false
        return true
      })
      const queue = (data && data.queue) || []
      const queuedSet = new Set(queue)
      const health = (data && data.health) || null
      const insights = (data && data.board && data.board.insights) || null
      const grouped = {}
      for (const state of states) grouped[state.id] = []
      for (const ticket of tickets) (grouped[ticket.status] = grouped[ticket.status] || []).push(ticket)

      const selectedTicket = selected && detail && detail.id === selected ? detail : null
      const counts = states.map(state => ({ id: state.id, count: (grouped[state.id] || []).length }))
      const workflow = workflowOf(data && data.board)
      const awaitingCount = tickets.filter(ticket => ticket.status === workflow.gate).length
      const blockedCount =
        workflow.blocked && workflow.blocked !== workflow.done ? tickets.filter(ticket => ticket.status === workflow.blocked).length : 0
      const running = tickets.filter(ticket => { const run = currentRun(ticket); return Boolean(run) && (run.status === 'running' || run.status === 'starting') }).length

      useEffect(() => {
        try {
          window.localStorage.setItem(
            'dshb-filters',
            JSON.stringify({ query, status: statusFilter, assignee: assigneeFilter, special: specialFilter }),
          )
        } catch {
          /* preferences are optional */
        }
      }, [query, statusFilter, assigneeFilter, specialFilter])

      useEffect(() => {
        const onKeyDown = event => {
          const target = event.target
          const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
          if (event.key === '/' && !typing) {
            event.preventDefault()
            searchRef.current?.focus()
            return
          }
          if (typing) return
          if (event.key === 'j' || event.key === 'k') {
            event.preventDefault()
            setFocusIndex(index => {
              const next = event.key === 'j' ? index + 1 : index - 1
              return Math.max(0, Math.min(next, tickets.length - 1))
            })
          } else if (event.key === 'Enter' && focusIndex >= 0 && tickets[focusIndex]) {
            setSelected(tickets[focusIndex].id)
          } else if (event.key === 'Escape') {
            setSelected(null)
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [tickets, focusIndex])

      useEffect(() => {
        if (focusIndex < 0) return
        const card = document.querySelector('.dshb-card-focused')
        if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
      }, [focusIndex])

      useEffect(() => {
        const openFromHash = () => {
          const match = String(window.location.hash || '').match(/^#([A-Za-z]+-\d+)$/)
          if (!match) return
          const found = ((data && data.tickets) || []).find(ticket => ticket.key === match[1])
          if (found) {
            pendingHash.current = true
            setSelected(found.id)
          }
        }
        openFromHash()
        window.addEventListener('hashchange', openFromHash)
        return () => window.removeEventListener('hashchange', openFromHash)
      }, [data])

      useEffect(() => {
        if (!data) return
        try {
          const open = selected && detail && detail.id === selected ? detail : null
          if (open) {
            pendingHash.current = false
            const hash = '#' + open.key
            if (window.location.hash !== hash) window.history.replaceState(null, '', hash)
          } else if (pendingHash.current) {
            return
          } else if (window.location.hash) {
            window.history.replaceState(null, '', window.location.pathname + window.location.search)
          }
        } catch {
          /* URL sync is a convenience, never a blocker */
        }
      }, [selected, detail, data])

      const focusedTicket = focusIndex >= 0 && focusIndex < tickets.length ? tickets[focusIndex] : null

      const applyView = name => {
        const view = savedViews.find(entry => entry.name === name)
        setActiveView(name)
        if (!view) return
        setQuery(view.query || '')
        setStatusFilter(view.status || '')
        setAssigneeFilter(view.assignee || '')
        setSpecialFilter(view.special || '')
      }

      const saveCurrentView = () => {
        const name = typeof window.prompt === 'function' ? window.prompt('Save this view as…', activeView || '') : null
        if (name === null) return
        const trimmed = String(name).trim()
        if (!trimmed) return
        const next = [...savedViews.filter(view => view.name !== trimmed), { name: trimmed, query, status: statusFilter, assignee: assigneeFilter, special: specialFilter }]
        setSavedViews(next)
        setActiveView(trimmed)
        writeSavedViews(next)
      }

      const deleteView = () => {
        if (!activeView) return
        if (typeof window.confirm === 'function' && !window.confirm('Delete the view "' + activeView + '"?')) return
        const next = savedViews.filter(view => view.name !== activeView)
        setSavedViews(next)
        setActiveView('')
        writeSavedViews(next)
      }

      const toggleSelection = id => {
        setSelection(current => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const runBatch = async (op, extra = {}) => {
        if (!selection.size || batchBusy) return
        setBatchBusy(true)
        setBatchNotice(null)
        try {
          const next = await run({ action: 'batch', op, ids: [...selection], ...extra })
          const results = (next && next.batch) || []
          const failed = results.filter(result => !result.ok)
          setSelection(new Set())
          setBatchNotice(
            (results.length - failed.length) + ' ok' +
              (failed.length ? ', ' + failed.length + ' failed: ' + failed.map(result => result.error).slice(0, 3).join('; ') : ''),
          )
        } catch (error) {
          setBatchNotice(String(error && error.message ? error.message : error))
        } finally {
          setBatchBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dshb-root' },
        h(
          'header',
          { className: 'dshb-top' },
          h('div', { className: 'dshb-title' }, (data && data.board && data.board.name) || 'Board'),
          h(
            'div',
            { className: 'dshb-sub' },
            tickets.length +
              ' tickets · ' +
              counts.map(c => c.count + ' ' + labelOf(data && data.board, c.id)).join(' · ') +
              (running ? ' · ' + running + ' running' : '') +
              (queue.length ? ' · ' + queue.length + ' queued' : '') +
              (health && health.cycleHours !== null ? ' · cycle ' + (health.cycleHours < 1 ? Math.round(health.cycleHours * 60) + 'm' : health.cycleHours.toFixed(1) + 'h') : '') +
              (health && health.tokensPerMerge ? ' · ' + fmtTokens(health.tokensPerMerge) + ' tok/merge' : ''),
          ),
          h('div', { className: 'dshb-spacer' }),
          archivedCount
            ? h(
                'button',
                { className: 'dshb-btn', type: 'button', onClick: () => setShowArchived(!showArchived) },
                (showArchived ? 'Hide archived' : 'Show archived') + ' (' + archivedCount + ')',
              )
            : null,
          h(
            'button',
            {
              className: 'dshb-btn',
              type: 'button',
              onClick: () => setInsightsOpen(true),
            },
            'Insights',
          ),
          h(
            'button',
            {
              className: 'dshb-btn',
              type: 'button',
              onClick: async () => {
                const next = await fetchBoard({ summary: false })
                setInboxItems(Array.isArray(next.notifications) ? next.notifications.slice().reverse() : [])
                setInboxOpen(true)
              },
            },
            'Inbox' + (data && data.board && data.board.unreadNotifications ? ' (' + data.board.unreadNotifications + ')' : ''),
          ),
          h('button', { className: 'dshb-btn', type: 'button', onClick: () => refresh() }, 'Refresh'),
          h(
            'button',
            {
              className: 'dshb-btn',
              type: 'button',
              onClick: async () => {
                const dry = await run({ action: 'gc' })
                const report = dry && dry.gc
                const worktrees = (report && report.worktrees) || []
                const branches = (report && report.branches) || []
                if (!worktrees.length && !branches.length) {
                  setBatchNotice('GC: nothing to clean.')
                  return
                }
                if (!window.confirm('Remove ' + worktrees.length + ' orphan worktree(s) and ' + branches.length + ' orphan branch(es)?')) return
                const applied = await run({ action: 'gc', apply: true })
                const removed = (applied && applied.gc && applied.gc.removed) || {}
                setBatchNotice('GC removed ' + (removed.worktrees || 0) + ' worktree(s), ' + (removed.branches || 0) + ' branch(es)')
              },
            },
            'GC',
          ),
        ),
        h(
          'div',
          { className: 'dshb-sr', role: 'status', 'aria-live': 'polite' },
          tickets.length + ' tickets, ' + awaitingCount + ' awaiting review, ' + blockedCount + ' blocked',
        ),
        h(
          'div',
          { className: 'dshb-filters' },
          h('input', {
            ref: searchRef,
            className: 'dshb-filterinput',
            placeholder: 'Search tickets… (/)',
            value: query,
            onChange: event => setQuery(event.target.value),
            'aria-label': 'Search tickets',
          }),
          h(
            'select',
            {
              className: 'dshb-filterselect',
              value: statusFilter,
              onChange: event => setStatusFilter(event.target.value),
              'aria-label': 'Filter by status',
            },
            h('option', { value: '' }, 'All states'),
            states.map(state => h('option', { key: state.id, value: state.id }, state.label)),
          ),
          h(
            'select',
            {
              className: 'dshb-filterselect',
              value: assigneeFilter,
              onChange: event => setAssigneeFilter(event.target.value),
              'aria-label': 'Filter by assignee',
            },
            h('option', { value: '' }, 'Anyone'),
            assignees.map(name => h('option', { key: name, value: name }, '@' + name)),
          ),
          h(
            'button',
            {
              className: 'dshb-btn' + (specialFilter === 'plan_review' ? ' dshb-btn-primary' : ''),
              type: 'button',
              onClick: () => setSpecialFilter(specialFilter === 'plan_review' ? '' : 'plan_review'),
            },
            'Plan review',
          ),
          h(
            'button',
            {
              className: 'dshb-btn' + (specialFilter === 'needs_input' ? ' dshb-btn-primary' : ''),
              type: 'button',
              onClick: () => setSpecialFilter(specialFilter === 'needs_input' ? '' : 'needs_input'),
            },
            'Needs input',
          ),
          h(
            'select',
            {
              className: 'dshb-filterselect',
              'aria-label': 'Saved views',
              value: activeView,
              onChange: event => applyView(event.target.value),
            },
            h('option', { value: '' }, 'Saved views'),
            savedViews.map(view => h('option', { key: view.name, value: view.name }, view.name)),
          ),
          h('button', { className: 'dshb-btn', type: 'button', onClick: () => saveCurrentView() }, 'Save view'),
          activeView ? h('button', { className: 'dshb-btn', type: 'button', onClick: () => deleteView() }, 'Delete view') : null,
          h(
            'button',
            {
              className: 'dshb-btn',
              type: 'button',
              disabled: tickets.length === 0,
              onClick: () => downloadText('board-' + new Date().toISOString().slice(0, 10) + '.csv', ticketsToCsv(tickets), 'text/csv;charset=utf-8'),
            },
            'Export CSV',
          ),
          h(
            'button',
            {
              className: 'dshb-btn',
              type: 'button',
              disabled: tickets.length === 0,
              onClick: () =>
                downloadText(
                  'board-' + new Date().toISOString().slice(0, 10) + '.json',
                  JSON.stringify({ exportedAt: new Date().toISOString(), count: tickets.length, tickets }, null, 2),
                  'application/json',
                ),
            },
            'Export JSON',
          ),
          h(
            'button',
            {
              className: 'dshb-btn' + (selectMode ? ' dshb-btn-primary' : ''),
              type: 'button',
              onClick: () => {
                setSelectMode(!selectMode)
                setSelection(new Set())
                setBatchNotice(null)
              },
            },
            selectMode ? 'Done selecting' : 'Select',
          ),
          selectMode
            ? h(
                'span',
                { className: 'dshb-row' },
                h('span', { className: 'dshb-runmeta' }, selection.size + ' selected'),
                h(
                  'button',
                  { className: 'dshb-btn', type: 'button', disabled: batchBusy || selection.size === 0, onClick: () => runBatch('approve') },
                  'Approve',
                ),
                h(
                  'button',
                  { className: 'dshb-btn', type: 'button', disabled: batchBusy || selection.size === 0, onClick: () => runBatch('archive') },
                  'Archive',
                ),
                h('input', {
                  className: 'dshb-filterinput',
                  style: { flex: '0 1 130px', minWidth: 90 },
                  placeholder: 'assignee',
                  value: batchAssignee,
                  onChange: event => setBatchAssignee(event.target.value),
                }),
                h(
                  'button',
                  {
                    className: 'dshb-btn',
                    type: 'button',
                    disabled: batchBusy || !selection.size || !batchAssignee.trim(),
                    onClick: () => runBatch('assign', { assignee: batchAssignee.trim() }),
                  },
                  'Assign',
                ),
              )
            : null,
          h('span', { className: 'dshb-runmeta' }, tickets.length + ' / ' + scopedTickets.length + ' shown · j/k move · Enter open'),
          batchNotice ? h('span', { className: 'dshb-runmeta' }, batchNotice) : null,
          query || statusFilter || assigneeFilter || specialFilter
            ? h(
                'button',
                {
                  className: 'dshb-btn',
                  type: 'button',
                  onClick: () => {
                    setQuery('')
                    setStatusFilter('')
                    setAssigneeFilter('')
                    setSpecialFilter('')
                  },
                },
                'Clear',
              )
            : null,
        ),
        data && data.board && data.board.warning
          ? h('div', { className: 'dshb-warn' }, 'Board storage warning: ' + data.board.warning)
          : null,
        tickets.length === 0
          ? h(
              'div',
              { className: 'dshb-empty', style: { margin: '10px 16px' } },
              'No tickets yet — type /board <what you want to work on> in the chat to create one.',
            )
          : null,
        error ? h('div', { className: 'dshb-error' }, error) : null,
        h(
          'div',
          { className: 'dshb-cols' },
          states.map(state =>
            h(
              'section',
              { className: 'dshb-col', key: state.id },
              h(
                'div',
                { className: 'dshb-colhead' },
                h('span', { className: 'dshb-collabel' }, state.label),
                h('span', { className: 'dshb-count' }, (grouped[state.id] || []).length),
              ),
              h(
                'div',
                { className: 'dshb-cards' },
                (grouped[state.id] || []).length === 0
                  ? h('div', { className: 'dshb-empty' }, 'Nothing here')
                  : (grouped[state.id] || []).map(ticket =>
                      h(TicketCard, {
                        key: ticket.id,
                        ticket,
                        queued: queuedSet.has(ticket.id),
                        queuePosition: queue.indexOf(ticket.id) + 1,
                        focused: Boolean(focusedTicket && focusedTicket.id === ticket.id),
                        selectMode,
                        selected: selection.has(ticket.id),
                        onToggle: toggleSelection,
                        onOpen: setSelected,
                      }),
                    ),
              ),
            ),
          ),
        ),
        insightsOpen
          ? h(
              React.Fragment,
              null,
              h('div', { className: 'dshb-overlay', onClick: () => setInsightsOpen(false) }),
              h(
                'aside',
                { className: 'dshb-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Insights' },
                h(
                  'div',
                  { className: 'dshb-dhead' },
                  h('div', { className: 'dshb-dtitle' }, 'Insights'),
                  h('div', { style: { flex: '1 1 auto' } }),
                  h('button', { className: 'dshb-btn', type: 'button', onClick: () => setInsightsOpen(false) }, 'Close'),
                ),
                h(
                  'div',
                  { className: 'dshb-dbody' },
                  !insights
                    ? h('div', { className: 'dshb-runmeta' }, 'No data yet.')
                    : h(
                        React.Fragment,
                        null,
                        h(
                          'div',
                          { className: 'dshb-section' },
                          h('div', { className: 'dshb-seclabel' }, 'Tickets'),
                          h('div', { className: 'dshb-runmeta' }, insights.tickets + ' live · ' + insights.archived + ' archived'),
                          h(
                            'div',
                            { className: 'dshb-runmeta' },
                            Object.entries(insights.byStatus)
                              .map(([status, count]) => labelOf(data && data.board, status) + ' ' + count)
                              .join(' · ') || 'empty board',
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dshb-section' },
                          h('div', { className: 'dshb-seclabel' }, 'Flow'),
                          h('div', { className: 'dshb-runmeta' }, 'throughput: ' + insights.throughput7d + ' in 7d · ' + insights.throughput30d + ' in 30d'),
                          h(
                            'div',
                            { className: 'dshb-runmeta' },
                            'cycle: ' + (insights.cycleHoursAvg === null ? '—' : insights.cycleHoursAvg.toFixed(1) + 'h avg') + ' · ' + (insights.cycleHoursP50 === null ? '—' : insights.cycleHoursP50.toFixed(1) + 'h p50'),
                          ),
                          h('div', { className: 'dshb-runmeta' }, 'tokens/merge: ' + (insights.tokensPerMergeAvg === null ? '—' : fmtTokens(insights.tokensPerMergeAvg))),
                          h('div', { className: 'dshb-runmeta' }, 'reviews/ticket: ' + (insights.reviewsPerTicketAvg === null ? '—' : insights.reviewsPerTicketAvg.toFixed(1))),
                        ),
                        h(
                          'div',
                          { className: 'dshb-section' },
                          h('div', { className: 'dshb-seclabel' }, 'Runs & checks'),
                          h('div', { className: 'dshb-runmeta' }, insights.runsTotal + ' runs · ' + insights.runsFailed + ' failed' + (insights.failedRunRate === null ? '' : ' (' + Math.round(insights.failedRunRate * 100) + '%)')),
                          h(
                            'div',
                            { className: 'dshb-runmeta' },
                            insights.checksRan + ' checks · ' + insights.checksFailed + ' failed' + (insights.checksPassRate === null ? '' : ' (' + Math.round(insights.checksPassRate * 100) + '% pass)'),
                          ),
                        ),
                      ),
                ),
              ),
            )
          : null,
        inboxOpen
          ? h(
              React.Fragment,
              null,
              h('div', { className: 'dshb-overlay', onClick: () => setInboxOpen(false) }),
              h(
                'aside',
                { className: 'dshb-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Notifications' },
                h(
                  'div',
                  { className: 'dshb-dhead' },
                  h('div', { className: 'dshb-dtitle' }, 'Notifications'),
                  h('div', { style: { flex: '1 1 auto' } }),
                  h(
                    'button',
                    {
                      className: 'dshb-btn',
                      type: 'button',
                      disabled: inboxBusy || !inboxItems.some(item => !item.readAt),
                      onClick: async () => {
                        setInboxBusy(true)
                        try {
                          await run({ action: 'notifications-read' })
                          setInboxItems(items => items.map(item => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })))
                        } finally {
                          setInboxBusy(false)
                        }
                      },
                    },
                    'Mark all read',
                  ),
                  h('button', { className: 'dshb-btn', type: 'button', onClick: () => setInboxOpen(false) }, 'Close'),
                ),
                h(
                  'div',
                  { className: 'dshb-dbody' },
                  inboxItems.length === 0
                    ? h('div', { className: 'dshb-empty' }, 'No notifications.')
                    : inboxItems.map(item =>
                        h(
                          'button',
                          {
                            key: item.id,
                            className: 'dshb-btn',
                            type: 'button',
                            style: { display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, opacity: item.readAt ? 0.6 : 1 },
                            onClick: async () => {
                              setInboxOpen(false)
                              if (item.ticketId) setSelected(item.ticketId)
                              if (!item.readAt) {
                                await run({ action: 'notifications-read', ids: [item.id] })
                                setInboxItems(items => items.map(entry => (entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry)))
                              }
                            },
                          },
                          h('span', { className: 'dshb-chip' }, (item.ticketKey || 'board') + ' · ' + item.kind),
                          h('span', { style: { display: 'block', marginTop: 3 } }, item.text),
                          h('span', { className: 'dshb-runmeta' }, timeAgo(item.at)),
                        ),
                      ),
                ),
              ),
            )
          : null,
        detailError ? h('div', { className: 'dshb-error' }, detailError) : null,
        selectedTicket
          ? h(TicketDrawer, {
              key: selectedTicket.id,
              ticket: selectedTicket,
              board: data && data.board,
              tickets: allTickets,
              maxWorkers: data && data.board && data.board.maxWorkers,
              queued: queuedSet.has(selectedTicket.id),
              onClose: () => setSelected(null),
              onAction: run,
              onOpenSession: props.openSession,
              onOpenTicket: key => {
                const target = allTickets.find(item => item.key === key || item.id === key)
                if (target) setSelected(target.id)
              },
            })
          : null,
      )
    }

    function injectStyles(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-board', '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-board: styles')
    }

    function apply(ctx) {
      injectStyles(ctx)
      // Selecting the worker's Session and revealing the Conversation is one
      // navigation action owned by the Workspace UI; the board only supplies the id.
      const openSession = sessionId => {
        try {
          const workspace = ctx.get('uiWorkspace')
          if (workspace && typeof workspace.openSession === 'function') {
            workspace.openSession(sessionId)
            return
          }
          console.warn('[dsh-board] uiWorkspace is unavailable; cannot open the run session')
        } catch (error) {
          console.warn('[dsh-board] failed to open the run session', error)
        }
      }
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'board', inject: () => ({ openSession }) }, BoardPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: 'board', order: 30, label: () => 'Board' }, BoardIcon),
      )
      if (typeof ctx.inject === 'function') {
        ctx.inject(['commandUi', 'layout'], scope => boardPanelDecorator(scope))
      }
      // A shared ticket link (#B-3) should reveal the board panel so its drawer
      // can open; without this the hash only works while the board is mounted.
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        const revealForHash = () => {
          if (!/#[A-Za-z]+-\d+$/.test(window.location.hash || '')) return
          try {
            ctx.get('layout')?.selectPanel('board')
          } catch {
            /* the sidebar still works if the layout service is unavailable */
          }
        }
        revealForHash()
        window.addEventListener('hashchange', revealForHash)
        ctx.effect(() => () => window.removeEventListener('hashchange', revealForHash), 'dsh-board: hash reveal listener')
      }
    }

    // Pure helpers exposed for the offline unit tests (not part of the plugin API).
    exports.__test = { csvCell, ticketsToCsv, renderInline, renderMarkdown, TicketCard }

    exports.name = 'dsh-board-ui'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
