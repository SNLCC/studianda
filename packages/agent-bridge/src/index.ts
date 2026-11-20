import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ScopeError,
  executeTool,
  scopeFromEnv,
  toolSpecs
} from '@studianda/agent-core';
import { CoreHttpApi, CoreUnavailableError, resolveDataDir } from './core-client.js';

/**
 * Studianda agent bridge（P0）：把 agent-core 的只读工具接到 MCP stdio。
 * - initialize / tools/list 不碰 Core（DSH 建连前有探测进程）；
 * - 只有 tools/call 才读 runtime.json 并请求 Core；
 * - 共享范围由 STUDIANDA_AGENT_SCOPE 表达（none / library / document:<id>,<id>）。
 */

const dataDir = resolveDataDir();
const scope = scopeFromEnv(process.env.STUDIANDA_AGENT_SCOPE);
const api = new CoreHttpApi(dataDir);

const server = new McpServer(
  { name: 'studianda', version: '0.1.3' },
  {
    instructions:
      '这是用户本机的文献库。先调用 scope(action=get) 查看共享范围；范围外先请求，不要猜。' +
      '引用必须带文献 id 与页码；P0 只开放只读工具，不要假设可以删改。'
  }
);

const inputSchema = {
  action: z.string().describe('动作名；见工具描述里的 actions'),
  document_id: z.string().optional().describe('文献 id'),
  from: z.number().int().min(1).optional().describe('起始页（含）'),
  to: z.number().int().min(1).optional().describe('结束页（含）'),
  limit: z.number().int().min(1).max(50).optional().describe('返回条数')
};

for (const spec of toolSpecs()) {
  server.registerTool(
    spec.name,
    {
      title: spec.name,
      description: `${spec.description} actions: ${spec.actions.join(' / ')}`,
      inputSchema
    },
    async (args) => {
      try {
        const result = await executeTool(spec.name, args, { scope, api });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        if (error instanceof ScopeError) {
          return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
        }
        if (error instanceof CoreUnavailableError) {
          return { isError: true, content: [{ type: 'text', text: `core_unavailable: ${error.message}` }] };
        }
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `${spec.name}_failed: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[agent-bridge] ready (stdio)');
