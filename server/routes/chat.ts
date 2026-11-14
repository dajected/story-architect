import { Router } from 'express';
import { z } from 'zod';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
} from '../store/chat.js';
import { getProject } from '../store/projects.js';
import { startChatGeneration } from '../generation.js';
import { activeChatJob } from '../jobs.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const chatRouter = Router();

chatRouter.get(
  '/projects/:id/conversations',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    res.json({ conversations: listConversations(projectId) });
  }),
);

chatRouter.post(
  '/projects/:id/conversations',
  wrap((req, res) => {
    const projectId = stringParam(req.params.id, 'project id');
    getProject(projectId);
    const body = parseBody(
      z.object({ title: z.string().max(120).optional() }).default({}),
      req.body,
    );
    res.status(201).json({ conversation: createConversation(projectId, body.title?.trim() || undefined) });
  }),
);

chatRouter.delete(
  '/conversations/:id',
  wrap((req, res) => {
    deleteConversation(stringParam(req.params.id, 'conversation id'));
    res.status(204).end();
  }),
);

chatRouter.get(
  '/conversations/:id/messages',
  wrap((req, res) => {
    const conversationId = stringParam(req.params.id, 'conversation id');
    res.json({
      conversation: getConversation(conversationId),
      messages: listMessages(conversationId),
      activeJob: activeChatJob(conversationId),
    });
  }),
);

chatRouter.post(
  '/conversations/:id/messages',
  wrap((req, res) => {
    const conversationId = stringParam(req.params.id, 'conversation id');
    const body = parseBody(
      z.object({
        content: z.string().min(1, 'Write a message before sending.').max(20000),
        chapterId: z.string().nullable().optional(),
      }),
      req.body,
    );
    const result = startChatGeneration({
      conversationId,
      content: body.content,
      chapterId: body.chapterId ?? null,
    });
    res.status(202).json({
      job: result.job,
      messageId: result.messageId,
      conversation: getConversation(conversationId),
    });
  }),
);
