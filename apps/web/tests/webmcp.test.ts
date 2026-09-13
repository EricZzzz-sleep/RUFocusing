// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { registerStudyTools } from '../src/webmcp'
it('uses real action callbacks, validates inputs, and cleans up optional WebMCP tools',async()=>{
 const tools:any[]=[]; let signal:AbortSignal|undefined
 const command=vi.fn().mockResolvedValue({session:{id:'saved'}}), navigate=vi.fn()
 const cleanup=registerStudyTools(()=>({active:null}),command,navigate,{registerTool(tool,options){tools.push(tool);signal=options.signal}})
 expect(tools.map(t=>t.name)).toEqual(['read_study_session','start_study_session'])
 expect(tools[0].execute({})).toEqual({active:null}); expect(()=>tools[0].execute({bad:true})).toThrow()
 await expect(tools[1].execute({task:'',mode:'Math'})).rejects.toThrow()
 await expect(tools[1].execute({task:'Read',mode:'Reading'})).resolves.toEqual({session:{id:'saved'}})
 expect(command).toHaveBeenCalledWith('start',{task:'Read',mode:'Reading',camera:false}); expect(navigate).toHaveBeenCalledWith('/record')
 cleanup(); expect(signal?.aborted).toBe(true)
})
