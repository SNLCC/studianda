import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  AskJobManager,
  ScopeError,
  assertDocumentAllowed,
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
const envScope =
  process.env.STUDIANDA_AGENT_SCOPE === undefined
    ? null
    : scopeFromEnv(process.env.STUDIANDA_AGENT_SCOPE);
const api = new CoreHttpApi(dataDir);
const askJobs = new AskJobManager();

async function currentScope(agentName: string) {
  return envScope ?? (await api.getScope(agentName));
}

/** MCP clientInfo.name：写入笔记/批注/变更审计的 Agent 名字。 */
function clientName(): string {
  const low = (server as unknown as {
    server?: { getClientVersion?: () => { name?: string } };
  }).server;
  const name = low?.getClientVersion?.()?.name?.trim();
  return name ? name.slice(0, 80) : 'agent';
}

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
  note_id: z.string().optional().describe('笔记 id'),
  annotation_id: z.string().optional().describe('批注 id'),
  query: z.string().optional().describe('检索词'),
  types: z.string().optional().describe('检索类型，逗号分隔：document,tag,annotation,note,chunk'),
  tags: z.array(z.string()).optional().describe('笔记标签'),
  folder_path: z.string().optional().describe('笔记文件夹路径'),
  folder_id: z.string().optional().describe('文献文件夹 id'),
  folder_name: z.string().optional().describe('文献文件夹名称'),
  project_id: z.string().optional().describe('项目 id'),
  project_name: z.string().optional().describe('项目名称'),
  description: z.string().optional().describe('项目描述'),
  before_id: z.string().optional().describe('排序：放到该文献之后'),
  after_id: z.string().optional().describe('排序：放到该文献之前'),
  document_ids: z.array(z.string()).optional().describe('项目批量加入/移出的文献 id'),
  archived: z.boolean().optional().describe('项目是否归档'),
  pages: z.array(z.number().int()).optional().describe('compute translate 指定页'),
  language: z.string().optional().describe('compute translate 目标语言'),
  force: z.boolean().optional().describe('compute 是否强制重算'),
  job_id: z.string().optional().describe('compute 任务 id（ask 必填）'),
  question: z.string().optional().describe('compute ask 的问题'),
  selection: z.string().optional().describe('问题关联的选文'),
  chat_session_id: z.string().optional().describe('阅读会话 id（可选）'),
  page: z.number().int().min(0).optional().describe('页码（写笔记可为 0 表示整篇）'),
  from: z.number().int().min(1).optional().describe('起始页（含）'),
  to: z.number().int().min(1).optional().describe('结束页（含）'),
  limit: z.number().int().min(1).max(50).optional().describe('返回条数'),
  content: z.string().optional().describe('写笔记/批注的正文（Markdown）'),
  quote: z.string().optional().describe('写笔记/批注关联的原文摘录'),
  color: z.string().optional().describe('批注颜色'),
  style: z.string().optional().describe('批注样式'),
  kind: z.string().optional().describe('organize 的变更类型：tags / metadata / folder'),
  items: z.array(z.unknown()).optional().describe('organize 的 items：documentId + 目标字段'),
  operation_id: z.string().optional().describe('organize undo 的变更记录 id')
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
        const agentName = clientName();
        const result = await executeTool(spec.name, args, {
          scope: await currentScope(agentName),
          api,
          agentName,
          jobs: askJobs
        });
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

// ---------------------------------------------------------------------------
// MCP Resources：把共享范围/文献目录暴露为可读资源，客户端无需额外工具即可预览。
// 资源读取同样受 scope 约束；Core 未运行时返回空目录、读取正文报错。
// ---------------------------------------------------------------------------
async function scopedDocuments(): Promise<Array<{ id: string; name: string }>> {
  try {
    const scope = await currentScope(clientName());
    const rows = await api.request<Array<{ id?: unknown; name?: unknown }>>('GET', '/documents');
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row.id === 'string')
      .filter((row) =>
        scope.kind === 'library'
          ? true
          : scope.kind === 'documents'
            ? scope.documentIds.includes(String(row.id))
            : false
      )
      .map((row) => ({ id: String(row.id), name: String(row.name ?? '') }));
  } catch {
    return [];
  }
}

server.registerResource(
  'scope',
  'studianda://scope',
  {
    title: '当前共享范围',
    description: '勘读 Agent 工作台写入的共享范围 JSON（kind/documentIds/caps/expiresAt）。',
    mimeType: 'application/json'
  },
  async (uri) => {
    const scope = await currentScope(clientName());
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(scope) }]
    };
  }
);

server.registerResource(
  'library',
  'studianda://library',
  {
    title: '共享文献目录',
    description: '当前 scope 内可见文献的 id 与标题。',
    mimeType: 'application/json'
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await scopedDocuments())
      }
    ]
  })
);

server.registerResource(
  'document',
  new ResourceTemplate('studianda://document/{id}', {
    list: async () => ({
      resources: (await scopedDocuments()).map((document) => ({
        uri: `studianda://document/${document.id}`,
        name: document.name || document.id,
        mimeType: 'application/json'
      }))
    })
  }),
  {
    title: '文献元数据',
    description: '单篇文献的元数据（标题/作者/页数/标签等）；需在共享范围内。',
    mimeType: 'application/json'
  },
  async (uri, variables) => {
    const documentId = String(variables.id ?? '');
    const scope = await currentScope(clientName());
    assertDocumentAllowed(scope, documentId);
    const document = await api.request('GET', `/documents/${encodeURIComponent(documentId)}`);
    return {
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(document) }
      ]
    };
  }
);

// ---------------------------------------------------------------------------
// MCP Prompts：把常用交接模板做成 prompt，客户端可直接选择，不必手写说明。
// ---------------------------------------------------------------------------
server.registerPrompt(
  'read_document',
  {
    title: '读一篇共享文献',
    description: '按页读取并给出带文献 id / 页码的引用。',
    argsSchema: {
      document_id: z.string().describe('文献 id（studianda://library 可查）'),
      pages: z.string().optional().describe('页码范围，例如 1-5；省略则先读第 1 页')
    }
  },
  ({ document_id, pages }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `请用 studianda MCP 工具阅读文献 ${document_id}。` +
            `先 library.get 看页数与元数据，再用 library.pages 读 ${pages ?? '第 1 页'}。` +
            '引用必须带文献 id 与页码；材料没有覆盖的结论要明确说未覆盖。'
        }
      }
    ]
  })
);

server.registerPrompt(
  'summarize_document',
  {
    title: '生成全书摘要',
    description: '启动 Core 的书本摘要任务并轮询结果。',
    argsSchema: {
      document_id: z.string().describe('文献 id')
    }
  },
  ({ document_id }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `请用 compute 工具为文献 ${document_id} 生成全书摘要：` +
            "compute.start（kind=summary），然后轮询 compute.status（kind=summary）直到完成。" +
            '摘要只能基于原文；不要编造未被材料覆盖的内容。'
        }
      }
    ]
  })
);

await server.connect(transport);
console.error('[agent-bridge] ready (stdio)');
