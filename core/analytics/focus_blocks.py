"""Summaries of observed presence intervals; no cognitive-focus inference."""


def summarize_timeline(intervals):
    totals = dict.fromkeys(('present', 'away', 'break', 'unknown'), 0.0)
    longest = current = 0.0
    previous_end = None
    for interval in intervals:
        length = interval['end'] - interval['start']
        totals[interval['state']] += length
        if interval['state'] == 'present':
            current = (current if previous_end == interval['start'] else 0) + length
            longest = max(longest, current)
        else:
            current = 0.0
        previous_end = interval['end']
    return {'totals': totals, 'longest_present': longest}
