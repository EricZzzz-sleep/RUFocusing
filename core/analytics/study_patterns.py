"""Versioned, recorded-behavior summaries. No mental states are inferred here."""
import math
from collections import Counter, defaultdict
from typing import Literal, TypedDict

ANALYSIS_VERSION = 'study-patterns-v1'
SUSTAINED_SECONDS = 600
AnnotationKind = Literal['focused', 'distracted', 'flow']


class Reflection(TypedDict):
    concentration: int | None
    distraction: int | None
    flow: Literal['yes', 'no', 'unsure'] | None


class Annotation(TypedDict):
    start: float
    end: float
    kind: AnnotationKind


class Availability(TypedDict):
    available: bool
    reasons: list[str]


class AnalysisSummary(TypedDict):
    version: str
    availability: Availability
    sustained_count: int | None
    sustained_seconds: float | None
    longest_sustained: float | None
    interruption_count: int | None
    interruption_seconds: float | None
    eligible_seconds: float | None
    observed_seconds: float | None
    observation_coverage: float | None
    tagged_seconds: dict[str, float]
    self_reported_sustained_seconds: float
    reflection: Reflection


class SessionAnalysis(TypedDict):
    session_id: str
    summary: AnalysisSummary
    threshold_seconds: int
    intervals: list[dict]
    sustained_periods: list[dict]
    interruptions: list[dict]
    exclusions: list[dict]
    reflection: Reflection
    annotations: list[Annotation]


def validate_reflection(data) -> Reflection:
    if not isinstance(data, dict) or set(data) - {'concentration', 'distraction', 'flow'}:
        raise ValueError('Provide concentration, distraction, and flow answers only.')
    result = {key: data.get(key) for key in ('concentration', 'distraction', 'flow')}
    for key in ('concentration', 'distraction'):
        value = result[key]
        if value is not None and (type(value) is not int or not 1 <= value <= 5):
            raise ValueError('Ratings must be whole numbers from 1 to 5, or skipped.')
    if result['flow'] is not None and result['flow'] not in ('yes', 'no', 'unsure'):
        raise ValueError('Choose Yes, No, Unsure, or skip self-reported flow.')
    return result


def validate_annotations(data, elapsed, timeline, exclusions) -> list[Annotation]:
    # Leaves room in the existing 4 KiB request limit for the complete replacement.
    if not isinstance(data, list) or len(data) > 30:
        raise ValueError('Provide up to 30 timeline tags.')
    blocked = [row for row in timeline if row['state'] == 'break'] + exclusions
    result = []
    for row in data:
        if not isinstance(row, dict) or set(row) != {'start', 'end', 'kind'} or row['kind'] not in ('focused', 'distracted', 'flow'):
            raise ValueError('Each tag needs a start, end, and Focused, Distracted, or Flow label.')
        start, end = row['start'], row['end']
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end)) or not 0 <= start < end <= elapsed:
            raise ValueError('Tags must have a positive duration within the saved session.')
        if any(start < interval['end'] and end > interval['start'] for interval in blocked):
            raise ValueError('Tags cannot overlap breaks or recorded diagnostic windows.')
        result.append({'start': start, 'end': end, 'kind': row['kind']})
    result.sort(key=lambda row: row['start'])
    if any(previous['end'] > current['start'] for previous, current in zip(result, result[1:])):
        raise ValueError('Timeline tags cannot overlap one another.')
    return result


def analyze_session(session, exclusions=(), provenance_reason=None, reflection=None, annotations=()) -> SessionAnalysis:
    """Partition elapsed time, keeping gaps unknown and diagnostics as a separate layer."""
    elapsed = session['elapsed']
    reflection = validate_reflection(reflection or {})
    exclusions = [{**row, 'start': max(0, min(elapsed, row['start'])),
                   'end': max(0, min(elapsed, row['end'] if row['end'] is not None else elapsed))} for row in exclusions]
    exclusions = [row for row in exclusions if row['end'] > row['start']]
    timeline = session['timeline']
    # A sweep keeps long, fragmented histories from blocking camera polling with
    # a quadratic scan. Overlapping source records conservatively stay unknown.
    events = defaultdict(list)
    events[0] = []
    events[elapsed] = []
    for rows, diagnostic in ((timeline, False), (exclusions, True)):
        for row in rows:
            start, end = (max(0, min(elapsed, row[key])) for key in ('start', 'end'))
            if end > start:
                state = 'diagnostic' if diagnostic else row['state']
                events[start].append((diagnostic, state, 1))
                events[end].append((diagnostic, state, -1))
    bounds = sorted(events)
    states = Counter()
    active_count = diagnostic_count = 0
    intervals = []
    for start, end in zip(bounds, bounds[1:]):
        for diagnostic, state, change in events[start]:
            if diagnostic:
                diagnostic_count += change
            else:
                active_count += change
                states[state] += change
                if states[state] == 0:
                    del states[state]
        state = 'diagnostic' if diagnostic_count else next(iter(states)) if active_count == 1 else 'unknown'
        if intervals and intervals[-1]['state'] == state and intervals[-1]['end'] == start:
            intervals[-1]['end'] = end
        else:
            intervals.append({'start': start, 'end': end, 'state': state})
    sustained = [row for row in intervals if row['state'] == 'present' and row['end'] - row['start'] >= SUSTAINED_SECONDS]
    interruptions = [row for row in intervals if row['state'] == 'away']
    eligible = sum(row['end'] - row['start'] for row in intervals if row['state'] not in ('break', 'diagnostic'))
    observed = sum(row['end'] - row['start'] for row in intervals if row['state'] in ('present', 'away'))
    reasons = [provenance_reason] if provenance_reason else []
    if eligible == 0:
        reasons.append('no_eligible_study_time')
    elif observed == 0:
        reasons.append('no_presence_observations')
    available = not reasons
    tagged = {kind: sum(row['end'] - row['start'] for row in annotations if row['kind'] == kind) for kind in ('focused', 'distracted', 'flow')}
    total = lambda rows: sum(row['end'] - row['start'] for row in rows)
    summary: AnalysisSummary = {
        'version': ANALYSIS_VERSION, 'availability': {'available': available, 'reasons': reasons},
        'sustained_count': len(sustained) if available else None,
        'sustained_seconds': total(sustained) if available else None,
        'longest_sustained': max((row['end'] - row['start'] for row in sustained), default=0) if available else None,
        'interruption_count': len(interruptions) if available else None,
        'interruption_seconds': total(interruptions) if available else None,
        'eligible_seconds': eligible if not provenance_reason else None,
        'observed_seconds': observed if not provenance_reason else None,
        'observation_coverage': observed / eligible if eligible > 0 and not provenance_reason else None,
        'tagged_seconds': tagged,
        'self_reported_sustained_seconds': total([row for row in annotations if row['kind'] in ('focused', 'flow') and row['end'] - row['start'] >= SUSTAINED_SECONDS]),
        'reflection': reflection,
    }
    return {'session_id': session['id'], 'summary': summary, 'threshold_seconds': SUSTAINED_SECONDS,
            'intervals': intervals, 'sustained_periods': sustained if available else [],
            'interruptions': interruptions if available else [], 'exclusions': exclusions,
            'reflection': reflection, 'annotations': list(annotations)}
