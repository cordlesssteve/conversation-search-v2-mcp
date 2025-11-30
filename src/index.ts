#!/usr/bin/env node
/**
 * Conversation Search v2 - MCP Server
 *
 * MCP server for searching and organizing Claude Code conversation history.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getDatabase, closeDatabase, MigrationRunner } from './database/index.js';
import { SessionRepository, MessageRepository, TagRepository, ProjectRepository } from './repositories/index.js';
import { EmbeddingService, VectorStore } from './services/index.js';

// Initialize database and repositories
const db = getDatabase();
const sessionRepo = new SessionRepository(db);
const messageRepo = new MessageRepository(db);
const tagRepo = new TagRepository(db);
const projectRepo = new ProjectRepository(db);

// Lazy-initialize vector store (requires ChromaDB and Ollama)
let vectorStore: VectorStore | null = null;
const CHROMA_HOST = process.env.CHROMA_HOST || 'http://localhost:8000';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

async function getVectorStore(): Promise<VectorStore | null> {
  if (vectorStore) return vectorStore;

  try {
    const embeddingService = new EmbeddingService(OLLAMA_HOST);
    const health = await embeddingService.healthCheck();

    if (!health.available || !health.model_loaded) {
      console.error('Vector search unavailable:', health.error);
      return null;
    }

    vectorStore = new VectorStore(embeddingService, 'conversation_messages', CHROMA_HOST);
    await vectorStore.initialize();
    return vectorStore;
  } catch (error) {
    console.error('Failed to initialize vector store:', error);
    return null;
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'conversation-search-v2',
    version: '2.1.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: 'search_conversations',
    description: 'Search conversation history using full-text search. Returns sessions with matching messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (supports phrases in quotes)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant'],
          description: 'Filter by message role',
        },
        project: {
          type: 'string',
          description: 'Filter by project path (partial match)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_sessions',
    description: 'Browse recent conversation sessions with optional filtering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum sessions to return (default: 20)',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default: 0)',
        },
        project: {
          type: 'string',
          description: 'Filter by project path',
        },
        tag: {
          type: 'string',
          description: 'Filter by tag name',
        },
        has_title: {
          type: 'boolean',
          description: 'Filter sessions that have/lack titles',
        },
      },
    },
  },
  {
    name: 'get_session',
    description: 'Get details of a specific conversation session including messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID',
        },
        include_messages: {
          type: 'boolean',
          description: 'Include full message content (default: true)',
        },
        message_limit: {
          type: 'number',
          description: 'Maximum messages to include (default: 100)',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_messages',
    description: 'Get messages from a session with pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID',
        },
        limit: {
          type: 'number',
          description: 'Maximum messages to return (default: 50)',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default: 0)',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant'],
          description: 'Filter by role',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_tags',
    description: 'List all tags with usage counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'create_tag',
    description: 'Create a new tag.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Tag name (will be normalized to lowercase)',
        },
        color: {
          type: 'string',
          description: 'Hex color code (e.g., #ff0000)',
        },
        description: {
          type: 'string',
          description: 'Tag description',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'tag_session',
    description: 'Add a tag to a conversation session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID',
        },
        tag: {
          type: 'string',
          description: 'Tag name (creates if not exists)',
        },
      },
      required: ['session_id', 'tag'],
    },
  },
  {
    name: 'untag_session',
    description: 'Remove a tag from a conversation session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID',
        },
        tag: {
          type: 'string',
          description: 'Tag name',
        },
      },
      required: ['session_id', 'tag'],
    },
  },
  {
    name: 'get_session_tags',
    description: 'Get all tags for a specific session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'update_session',
    description: 'Update session metadata (title, summary).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session UUID',
        },
        title: {
          type: 'string',
          description: 'New title for the session',
        },
        summary: {
          type: 'string',
          description: 'New summary for the session',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_stats',
    description: 'Get database statistics.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_projects',
    description: 'List all projects with session/message counts and activity timestamps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum projects to return (default: 50)',
        },
        name_filter: {
          type: 'string',
          description: 'Filter projects by name (partial match)',
        },
      },
    },
  },
  {
    name: 'get_project',
    description: 'Get project details including recent sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'number',
          description: 'Project ID',
        },
        session_limit: {
          type: 'number',
          description: 'Maximum recent sessions to include (default: 10)',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'update_project',
    description: 'Update project name or description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'number',
          description: 'Project ID',
        },
        name: {
          type: 'string',
          description: 'New display name for the project',
        },
        description: {
          type: 'string',
          description: 'Project description',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'semantic_search',
    description: 'Search conversations using semantic similarity (requires ChromaDB + Ollama). Finds conceptually related content even without exact keyword matches.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query describing what you\'re looking for',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 10)',
        },
        session_id: {
          type: 'string',
          description: 'Optional: limit search to a specific session',
        },
        min_similarity: {
          type: 'number',
          description: 'Minimum similarity score 0-1 (default: 0.5)',
        },
      },
      required: ['query'],
    },
  },
];

// Prompt definitions - these appear as slash commands in Claude Code
const PROMPTS = [
  {
    name: 'search-history',
    description: 'Search your conversation history for a specific topic or keyword',
    arguments: [
      {
        name: 'topic',
        description: 'The topic, keyword, or phrase to search for',
        required: true,
      },
      {
        name: 'project',
        description: 'Optional: limit search to a specific project path',
        required: false,
      },
    ],
  },
  {
    name: 'recent-work',
    description: 'Find your recent work on a specific project or topic',
    arguments: [
      {
        name: 'project',
        description: 'Project name or path to find recent work in',
        required: true,
      },
      {
        name: 'days',
        description: 'Number of days to look back (default: 7)',
        required: false,
      },
    ],
  },
  {
    name: 'resume-session',
    description: 'Get context to resume a previous conversation session',
    arguments: [
      {
        name: 'session_id',
        description: 'Session ID to resume, or "latest" for most recent',
        required: false,
      },
      {
        name: 'project',
        description: 'Find latest session in this project',
        required: false,
      },
    ],
  },
  {
    name: 'find-decisions',
    description: 'Search for architectural decisions, design choices, or technical decisions',
    arguments: [
      {
        name: 'topic',
        description: 'The component, system, or topic to find decisions about',
        required: true,
      },
    ],
  },
  {
    name: 'tag-session',
    description: 'Tag the current or a specific conversation session for organization',
    arguments: [
      {
        name: 'tag',
        description: 'Tag name to apply (e.g., "important", "follow-up", "bug-fix")',
        required: true,
      },
      {
        name: 'session_id',
        description: 'Session ID to tag. Omit to tag current session (requires CLAUDE_SESSION_ID)',
        required: false,
      },
    ],
  },
];

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Register prompt handlers
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;

  switch (name) {
    case 'search-history': {
      const topic = promptArgs?.topic || '[topic]';
      const project = promptArgs?.project;

      const projectClause = project ? ` within the "${project}" project` : '';

      return {
        description: `Search conversation history for: ${topic}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Search my conversation history for discussions about "${topic}"${projectClause}.

Use the search_conversations tool with query: "${topic}"${project ? ` and project filter: "${project}"` : ''}.

Summarize the key findings, including:
- Which sessions discussed this topic
- Key decisions or conclusions reached
- Any code or implementations mentioned
- Links to relevant session IDs for deeper exploration`,
            },
          },
        ],
      };
    }

    case 'recent-work': {
      const project = promptArgs?.project || '[project]';
      const days = promptArgs?.days || '7';

      return {
        description: `Find recent work on: ${project}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Find my recent work on the "${project}" project from the last ${days} days.

Use the browse_sessions tool with project filter "${project}" to find recent sessions.

Provide a summary of:
- What tasks were worked on
- Current status of any ongoing work
- Any blockers or issues mentioned
- Suggested next steps based on the context`,
            },
          },
        ],
      };
    }

    case 'resume-session': {
      const sessionId = promptArgs?.session_id;
      const project = promptArgs?.project;

      let instruction: string;
      if (sessionId && sessionId !== 'latest') {
        instruction = `Use get_session with session_id: "${sessionId}" to retrieve the full conversation.`;
      } else if (project) {
        instruction = `Use browse_sessions with project: "${project}" to find the most recent session, then use get_session to retrieve it.`;
      } else {
        instruction = `Use browse_sessions to find the most recent session, then use get_session to retrieve it.`;
      }

      return {
        description: 'Resume a previous conversation session',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Help me resume a previous conversation session.

${instruction}

Then summarize:
- What was being worked on
- Where we left off
- Any pending tasks or decisions
- Suggested next actions to continue the work`,
            },
          },
        ],
      };
    }

    case 'find-decisions': {
      const topic = promptArgs?.topic || '[topic]';

      return {
        description: `Find decisions about: ${topic}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Search my conversation history for architectural decisions, design choices, or technical decisions related to "${topic}".

Use search_conversations with queries like:
- "decided ${topic}"
- "architecture ${topic}"
- "design ${topic}"
- "chose ${topic}"

Compile a summary of:
- Key decisions made about ${topic}
- The reasoning behind those decisions
- Any alternatives that were considered
- When these decisions were made (session dates)`,
            },
          },
        ],
      };
    }

    case 'tag-session': {
      const tag = promptArgs?.tag || 'important';
      const sessionId = promptArgs?.session_id;

      let tagInstruction: string;
      if (sessionId) {
        tagInstruction = `Use tag_session with session_id: "${sessionId}" and tag: "${tag}"`;
      } else {
        tagInstruction = `The current session ID should be available in the environment as CLAUDE_SESSION_ID.
If available, use tag_session with that session_id and tag: "${tag}".
If not available, ask the user for the session ID or use browse_sessions to find recent sessions.`;
      }

      return {
        description: `Tag session with: ${tag}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Tag a conversation session with "${tag}".

${tagInstruction}

After tagging, confirm:
- Which session was tagged
- The tag that was applied
- Other tags currently on this session`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_conversations': {
        const { query, limit = 20, role, project } = args as {
          query: string;
          limit?: number;
          role?: 'user' | 'assistant';
          project?: string;
        };

        const results = messageRepo.search(query, limit, {
          role,
          session_id: undefined,
        });

        // Filter by project if specified
        const filtered = project
          ? results.filter(r => r.session.project_path?.includes(project))
          : results;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query,
                total_results: filtered.length,
                results: filtered.map(r => ({
                  session_id: r.session.id,
                  title: r.session.title,
                  project: r.session.project_path,
                  started_at: r.session.started_at,
                  match_count: r.match_count,
                  relevance_score: r.relevance_score,
                  snippet: r.matching_content,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'browse_sessions': {
        const { limit = 20, offset = 0, project, tag, has_title } = args as {
          limit?: number;
          offset?: number;
          project?: string;
          tag?: string;
          has_title?: boolean;
        };

        // Get tag ID if filtering by tag
        let tagId: number | undefined;
        if (tag) {
          const tagObj = tagRepo.findByName(tag);
          if (tagObj) {
            tagId = tagObj.id;
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Tag not found: ${tag}` }),
                },
              ],
            };
          }
        }

        const sessions = sessionRepo.findRecentWithContext(limit, offset, {
          project_path: project,
          tag_id: tagId,
          has_title,
        });

        const total = sessionRepo.count({
          project_path: project,
          tag_id: tagId,
          has_title,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total,
                offset,
                limit,
                sessions: sessions.map(s => ({
                  id: s.id,
                  title: s.title,
                  display_name: s.display_name,
                  project: s.project_path,
                  started_at: s.started_at,
                  message_count: s.message_count,
                  tags: s.tags.map(t => t.name),
                  first_message: s.first_message,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'get_session': {
        const { session_id, include_messages = true, message_limit = 100 } = args as {
          session_id: string;
          include_messages?: boolean;
          message_limit?: number;
        };

        const session = sessionRepo.findById(session_id);
        if (!session) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Session not found: ${session_id}` }),
              },
            ],
          };
        }

        const tags = tagRepo.findBySession(session_id);
        const messages = include_messages
          ? messageRepo.findBySession(session_id, message_limit)
          : [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                session: {
                  ...session,
                  tags: tags.map(t => t.name),
                },
                messages: messages.map(m => ({
                  uuid: m.uuid,
                  role: m.role,
                  content: m.content,
                  timestamp: m.timestamp,
                  model: m.model,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'get_messages': {
        const { session_id, limit = 50, offset = 0, role } = args as {
          session_id: string;
          limit?: number;
          offset?: number;
          role?: 'user' | 'assistant';
        };

        const messages = messageRepo.find(
          { session_id, role },
          limit,
          offset
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                session_id,
                total: messageRepo.count({ session_id, role }),
                offset,
                limit,
                messages: messages.map(m => ({
                  uuid: m.uuid,
                  role: m.role,
                  content: m.content,
                  timestamp: m.timestamp,
                  model: m.model,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'list_tags': {
        const tags = tagRepo.findAllWithCounts();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total: tags.length,
                tags: tags.map(t => ({
                  id: t.id,
                  name: t.name,
                  color: t.color,
                  description: t.description,
                  session_count: t.session_count,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'create_tag': {
        const { name, color, description } = args as {
          name: string;
          color?: string;
          description?: string;
        };

        const existing = tagRepo.findByName(name);
        if (existing) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Tag already exists: ${name}`,
                  tag: existing,
                }),
              },
            ],
          };
        }

        const tag = tagRepo.create({ name, color, description });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                tag,
              }, null, 2),
            },
          ],
        };
      }

      case 'tag_session': {
        const { session_id, tag: tagName } = args as {
          session_id: string;
          tag: string;
        };

        if (!sessionRepo.exists(session_id)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Session not found: ${session_id}` }),
              },
            ],
          };
        }

        const tag = tagRepo.addToSessionByName(session_id, tagName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                session_id,
                tag: tag.name,
              }, null, 2),
            },
          ],
        };
      }

      case 'untag_session': {
        const { session_id, tag: tagName } = args as {
          session_id: string;
          tag: string;
        };

        const removed = tagRepo.removeFromSessionByName(session_id, tagName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: removed,
                session_id,
                tag: tagName,
                message: removed ? 'Tag removed' : 'Tag was not on this session',
              }, null, 2),
            },
          ],
        };
      }

      case 'get_session_tags': {
        const { session_id } = args as { session_id: string };

        const tags = tagRepo.findBySession(session_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                session_id,
                tags: tags.map(t => ({
                  id: t.id,
                  name: t.name,
                  color: t.color,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'update_session': {
        const { session_id, title, summary } = args as {
          session_id: string;
          title?: string;
          summary?: string;
        };

        if (!sessionRepo.exists(session_id)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Session not found: ${session_id}` }),
              },
            ],
          };
        }

        const updated = sessionRepo.update(session_id, {
          title,
          summary,
          is_title_auto_generated: false,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                session: updated,
              }, null, 2),
            },
          ],
        };
      }

      case 'get_stats': {
        const sessionCount = sessionRepo.count();
        const messageCount = messageRepo.count();
        const tagCount = tagRepo.count();
        const messagesByRole = messageRepo.countByRole();
        const dateRange = messageRepo.getDateRange();
        const dbStats = db.getStats();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sessions: sessionCount,
                messages: messageCount,
                tags: tagCount,
                messages_by_role: messagesByRole,
                date_range: dateRange,
                database: {
                  path: dbStats.path,
                  size_mb: (dbStats.size_bytes / 1024 / 1024).toFixed(2),
                  wal_mode: dbStats.wal_mode,
                },
              }, null, 2),
            },
          ],
        };
      }

      case 'list_projects': {
        const { limit = 50, name_filter } = args as {
          limit?: number;
          name_filter?: string;
        };

        const projects = projectRepo.findAll(
          { name_contains: name_filter },
          limit
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total: projectRepo.count({ name_contains: name_filter }),
                projects: projects.map(p => ({
                  id: p.id,
                  name: p.name,
                  path: p.path,
                  description: p.description,
                  session_count: p.session_count,
                  message_count: p.message_count,
                  last_activity_at: p.last_activity_at,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'get_project': {
        const { project_id, session_limit = 10 } = args as {
          project_id: number;
          session_limit?: number;
        };

        const project = projectRepo.findWithSessions(project_id, session_limit);
        if (!project) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Project not found: ${project_id}` }),
              },
            ],
          };
        }

        const stats = projectRepo.getStats(project_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                project: {
                  id: project.id,
                  name: project.name,
                  path: project.path,
                  description: project.description,
                  session_count: project.session_count,
                  message_count: project.message_count,
                  last_activity_at: project.last_activity_at,
                  created_at: project.created_at,
                },
                stats,
                recent_sessions: project.recent_sessions.map(s => ({
                  id: s.id,
                  title: s.title,
                  started_at: s.started_at,
                  message_count: s.message_count,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case 'update_project': {
        const { project_id, name, description } = args as {
          project_id: number;
          name?: string;
          description?: string;
        };

        const existing = projectRepo.findById(project_id);
        if (!existing) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Project not found: ${project_id}` }),
              },
            ],
          };
        }

        const updated = projectRepo.update(project_id, { name, description });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                project: updated,
              }, null, 2),
            },
          ],
        };
      }

      case 'semantic_search': {
        const { query, limit = 10, session_id, min_similarity = 0.5 } = args as {
          query: string;
          limit?: number;
          session_id?: string;
          min_similarity?: number;
        };

        const store = await getVectorStore();
        if (!store) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Vector search unavailable. Ensure ChromaDB and Ollama are running.',
                  hint: 'Start ChromaDB: docker run -p 8000:8000 chromadb/chroma\nStart Ollama: ollama serve && ollama pull nomic-embed-text',
                }),
              },
            ],
          };
        }

        const results = session_id
          ? await store.searchInSession(query, session_id, limit)
          : await store.search(query, limit);

        // Filter by similarity threshold and enrich with session data
        // Supports both chunk format (message pairs) and legacy message format
        const enrichedResults = results
          .filter(r => r.similarity >= min_similarity)
          .map(r => {
            const session = sessionRepo.findById(r.metadata.session_id);
            const meta = r.metadata as Record<string, unknown>;

            // Build result object - handle both chunk and legacy formats
            const result: Record<string, unknown> = {
              content: r.content,
              similarity: r.similarity.toFixed(3),
              session_id: meta.session_id,
              session_title: session?.title,
              project: session?.project_path || meta.project_path,
              timestamp: meta.timestamp,
            };

            // Chunk format fields (message pairs with topic detection)
            if (meta.topic_group) result.topic = meta.topic_group;
            if (meta.sequence_number) result.chunk_sequence = meta.sequence_number;
            if (meta.previous_chunk) result.has_context = true;

            // Legacy format fields (individual messages)
            if (meta.message_uuid) result.message_uuid = meta.message_uuid;
            if (meta.role) result.role = meta.role;

            return result;
          });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query,
                total_results: enrichedResults.length,
                min_similarity,
                results: enrichedResults,
              }, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    };
  }
});

// Main entry point
async function main(): Promise<void> {
  // Run pending migrations
  const runner = new MigrationRunner(db);
  const status = runner.getStatus();

  if (status.pending_count > 0) {
    console.error(`Applying ${status.pending_count} pending migration(s)...`);
    const result = runner.migrate();

    if (result.errors.length > 0) {
      console.error('Migration errors:', result.errors);
      process.exit(1);
    }
  }

  console.error(`Conversation Search v2 ready (schema v${runner.getCurrentVersion()})`);

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  closeDatabase();
  process.exit(1);
});
