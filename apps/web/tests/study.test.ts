import { describe, expect, it } from 'vitest'
import { AwayDetector, csvExport, emptyReflection, mergeIntervals, studyReport, validateAnnotations, validateReflection, withReport, type CloudSession } from '../../../packages/study'
const session=(timeline:CloudSession['timeline'],annotations:CloudSession['annotations']=[]):CloudSession=>({id:'session',task:'Study',mode:'Math',started_at:'2026-09-13T10:00:00Z',ended_at:'2026-09-13T11:00:00Z',status:'completed',elapsed:timeline.at(-1)?.end??0,camera_enabled:true,revision:1,checkpoint_at:'2026-09-13T11:00:00Z',lease_until:null,owner_tab:null,pause_reason:null,timeline,reflection:emptyReflection(),annotations})
describe('shared browser/server study rules',()=>{
 it('requires ten seconds of fresh absence and resets on stale/multiple-face evidence',()=>{
   const d=new AwayDetector(); expect(d.classify(0,0,0)).toBe('unknown'); expect(d.classify(0,9.9,9.9)).toBe('unknown'); expect(d.classify(0,10,10)).toBe('away')
   expect(d.classify(0,10,13)).toBe('unknown'); expect(d.classify(0,13,13)).toBe('unknown'); expect(d.classify(2,14,14)).toBe('unknown'); expect(d.classify(1,15,15)).toBe('present'); expect(d.classify(null,16,16)).toBe('unknown')
 })
 it('promotes the entire uninterrupted block at exactly ten minutes',()=>{
   expect(studyReport(session([{start:0,end:599.99,state:'present'}])).study_periods.totals.deep).toBe(0)
   expect(studyReport(session([{start:0,end:300,state:'present'},{start:300,end:600,state:'present'}])).study_periods.totals.deep).toBe(600)
 })
 it('breaks continuity at unknown intervals, breaks and away time',()=>{
   const r=studyReport(session([{start:0,end:500,state:'present'},{start:500,end:505,state:'unknown'},{start:505,end:1005,state:'present'},{start:1005,end:1100,state:'break'},{start:1100,end:1200,state:'away'}]))
   expect(r.study_periods.totals).toEqual({deep:0,normal:1000,distracted:100}); expect(r.summary.eligible_seconds).toBe(1105); expect(r.summary.observation_coverage).toBeCloseTo(1100/1105)
 })
 it('represents no evidence as unavailable without inventing focus',()=>{
   const r=studyReport(session([{start:0,end:30,state:'unknown'}])); expect(r.study_periods.available).toBe(false); expect(r.summary.sustained_seconds).toBeNull(); expect(r.study_periods.totals).toEqual({deep:0,normal:0,distracted:0})
 })
 it('keeps personal tags separate from the automatic timeline',()=>{
   const r=studyReport(session([{start:0,end:600,state:'unknown'}],[{start:0,end:600,kind:'focused'}])); expect(r.summary.self_reported_sustained_seconds).toBe(600); expect(r.study_periods.totals.deep).toBe(0)
 })
 it('rejects invalid ratings, overlapping tags and tags crossing breaks',()=>{
   expect(()=>validateReflection({concentration:1.2})).toThrow(); expect(()=>validateReflection({concentration:6})).toThrow(); expect(()=>validateReflection({flow:'maybe'})).toThrow()
   expect(validateReflection({})).toEqual(emptyReflection())
   const s=session([{start:0,end:10,state:'present'},{start:10,end:20,state:'break'}]); expect(()=>validateAnnotations([{start:8,end:12,kind:'focused'}],s)).toThrow(/breaks/)
   expect(()=>validateAnnotations([{start:0,end:5,kind:'focused'},{start:4,end:6,kind:'flow'}],s)).toThrow(/overlap/)
   expect(()=>validateAnnotations([{start:0,end:Infinity,kind:'focused'}],s)).toThrow()
 })
 it('escapes CSV quotes, newlines and formulas',()=>{
   const s=withReport({...session([]),task:'=HYPERLINK("bad")\nnext'}); const csv=csvExport([s]); expect(csv).toContain('"\'=HYPERLINK(""bad"")\nnext"'); expect(csv).toContain('\r\n')
 })
 it('does not mutate input intervals when merging',()=>{
   const rows=[{start:0,end:5,state:'present' as const},{start:5,end:10,state:'present' as const}]; expect(mergeIntervals(rows)).toHaveLength(1); expect(rows[0].end).toBe(5)
 })
})
import parity from './fixtures/study-parity.json'
it.each(parity)('matches the existing Python report for $session.id',fixture=>{
 const result=studyReport({...fixture.session,timeline:fixture.session.timeline as CloudSession['timeline'],reflection:emptyReflection(),annotations:[]})
 expect(result.study_periods).toEqual(fixture.study_periods);expect(result.summary).toEqual(fixture.summary)
})
