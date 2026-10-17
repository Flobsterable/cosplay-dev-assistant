import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

export async function connectProject(projectRoot) {
  // Child process needs Git and system variables, never the model API key.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|home|userprofile|lang|lc_all)$/i.test(key)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url)), projectRoot],
    env, stderr: 'inherit'
  });
  const client = new Client({ name: 'cosplay-dev-assistant', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  async function call(name, args = {}) {
    const reply = await client.callTool({ name, arguments: args });
    if (reply.isError) throw new Error(`MCP ${name}: ${reply.content?.find(c => c.type === 'text')?.text || 'ошибка инструмента'}`);
    return JSON.parse(reply.content.find(c => c.type === 'text').text);
  }
  return {
    client,
    diff: base => call('get_project_diff', { base }),
    async context() {
      const { branch } = await call('get_current_branch');
      return { branch, tools: ['get_current_branch'] };
    },
    close: () => client.close()
  };
}
