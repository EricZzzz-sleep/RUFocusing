interface Tool { name: string; description: string; inputSchema: object; annotations: {readOnlyHint: boolean}; execute(input: unknown): unknown }
interface Context { registerTool(tool: Tool, options: {signal: AbortSignal}): void | Promise<void> }
export function registerStudyTools(read: () => unknown, command: (action: string, data: Record<string, unknown>) => Promise<unknown>, navigate: (path: string) => void, context = (document as Document & {modelContext?: Context}).modelContext) {
  if (!context) return () => {}
  const lifecycle = new AbortController()
  const tools: Tool[] = [
    { name: 'read_study_session', description: 'Read the signed-in user’s active study session and connection status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: {readOnlyHint: true}, execute(input) { if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object.'); return read() } },
    { name: 'start_study_session', description: 'Start a camera-free study session for the signed-in user and open the Record page.', inputSchema: { type: 'object', properties: {task: {type:'string',minLength:1,maxLength:200},mode:{type:'string',enum:['Math','Coding','Reading','Lecture']}}, required:['task','mode'],additionalProperties:false }, annotations: {readOnlyHint: false}, async execute(input) {
      const value = input as {task?: unknown; mode?: unknown}
      if (!value || typeof value.task !== 'string' || !value.task.trim() || value.task.length>200 || typeof value.mode !== 'string' || !['Math','Coding','Reading','Lecture'].includes(value.mode) || Object.keys(value).some(key => !['task','mode'].includes(key))) throw new Error('Provide a task and valid study mode.')
      const result = await command('start', {task:value.task,mode:value.mode,camera:false}); navigate('/record'); return result
    } },
  ]
  for (const tool of tools) { try { void Promise.resolve(context.registerTool(tool, {signal:lifecycle.signal})).catch(() => {}) } catch { /* Optional browser capability. */ } }
  return () => lifecycle.abort()
}
