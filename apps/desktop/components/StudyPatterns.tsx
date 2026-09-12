import type { StudySession } from '../src/types'
import { duration } from '../src/types'
import { summarizePatterns } from '../src/study-patterns'

export default function StudyPatterns({ sessions, loading }: { sessions: StudySession[]; loading: boolean }) {
  const summary = summarizePatterns(sessions)
  const rating = (value: { average: number | null; count: number }) => `${value.average === null ? 'N/A' : `${value.average.toFixed(1)} / 5`} · ${value.count} responses`
  return <section className="panel patterns-panel" aria-labelledby="patterns-title">
    <span className="eyebrow">OBSERVATIONS & PERSONAL EXPERIENCE</span>
    <h2 id="patterns-title">Study patterns</h2>
    <p className="muted">Saved sessions in the selected date range. Presence may support sustained study; it does not prove deep concentration.</p>
    {loading ? <p role="status">Loading study patterns…</p> : !sessions.length ? <p>No saved sessions in this period. Save a session to see patterns and add an optional reflection.</p> : <>
      <h3>Observed behavior</h3>
      <div className="pattern-metrics">
        <div><span>Sustained at-desk periods</span><strong>{summary.available ? summary.sustainedCount : 'N/A'}</strong><small>{summary.available ? duration(summary.sustained) : 'No available evidence'} · at least 10 minutes each</small></div>
        <div><span>Longest sustained period</span><strong>{summary.available ? duration(summary.longest) : 'N/A'}</strong><small>Continuous recorded presence</small></div>
        <div><span>Possible interruptions</span><strong>{summary.available ? summary.interruptions : 'N/A'}</strong><small>{summary.available ? duration(summary.away) : 'No available evidence'} recorded away</small></div>
        <div><span>Observation coverage</span><strong>{summary.coverage === null ? 'N/A' : `${Math.round(summary.coverage * 100)}%`}</strong><small>Excludes breaks and diagnostics</small></div>
      </div>
      <p className="muted">Behavioral totals available for {summary.available} of {sessions.length} sessions. {summary.unavailable > 0 && `${summary.unavailable} lack sufficient presence evidence or exact diagnostic boundaries; open their reports for details.`} Coverage includes unknown study time when its boundaries are known.</p>
      <h3>Self-reported experience</h3>
      <div className="pattern-metrics personal-metrics">
        <div><span>Average concentration</span><strong>{rating(summary.concentration)}</strong></div>
        <div><span>Average distraction frequency</span><strong>{rating(summary.distraction)}</strong></div>
        <div><span>Self-reported flow</span><strong>{summary.flow.count ? `${summary.flow.yes} Yes · ${summary.flow.no} No · ${summary.flow.unsure} Unsure` : 'N/A'}</strong><small>{summary.flow.count} responses</small></div>
        <div><span>Self-reported sustained focus</span><strong>{duration(summary.sustainedReported)}</strong><small>Focused or Flow tags lasting at least 10 minutes</small></div>
      </div>
      <p>Tagged time: Focused {duration(summary.tagged.focused)} · Distracted {duration(summary.tagged.distracted)} · Flow {duration(summary.tagged.flow)}.</p>
      <p className="muted">Only submitted answers are averaged. Ratings describe whole sessions; tags describe the times you selected. No overall focus score is calculated.</p>
    </>}
  </section>
}
