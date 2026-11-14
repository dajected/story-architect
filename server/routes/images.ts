import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import type { ImageConnectionInput, ImageProviderSettings } from '../../shared/types.js';
import {
  createImageConnection,
  deleteImageConnection,
  getProviderImageConnection,
  listImageConnections,
  updateImageConnection,
} from '../store/image-connections.js';
import {
  createImagePromptTemplate,
  deleteImagePromptTemplate,
  listImagePromptTemplates,
  setDefaultImagePromptTemplate,
  updateImagePromptTemplate,
} from '../store/image-templates.js';
import {
  deleteImageAsset,
  getImageAssetRow,
  imageFilePath,
  listProjectImageAssets,
  selectChapterImage,
} from '../store/images.js';
import { setCharacterPortrait, getCharacter } from '../store/characters.js';
import { getChapter } from '../store/chapters.js';
import { getProject } from '../store/projects.js';
import { testImageConnection } from '../image-providers.js';
import {
  cancelChapterPortraitRequest,
  cancelImageGeneration,
  chapterPortraitOverview,
  characterImageOverview,
  retryImageJob,
  startChapterPortraitRequest,
  startImageGeneration,
  startImagePromptGeneration,
} from '../image-generation.js';
import { getImageJob } from '../store/images.js';
import { latestPortraitBatch } from '../store/portrait-batches.js';
import { cancelPortraitBatch, startPortraitBatch } from '../portrait-batch.js';
import { AppError } from '../errors.js';
import { parseBody, stringParam, wrap } from './helpers.js';

export const imagesRouter = Router();

imagesRouter.get('/projects/:id/images', wrap((req, res) => {
  const id = stringParam(req.params.id, 'project id');
  getProject(id);
  res.json({ assets: listProjectImageAssets(id) });
}));
imagesRouter.post('/chapters/:id/selected-image', wrap((req, res) => {
  const body = parseBody(z.object({assetId: z.string().min(1)}), req.body);
  res.json({asset: selectChapterImage(stringParam(req.params.id, 'chapter id'), body.assetId)});
}));

const imageConnectionSchema = z.object({
  name: z.string().min(1, 'Connection name is required.').max(120),
  kind: z.enum(['openai-images', 'comfyui']),
  baseUrl: z.string().min(1, 'Base URL is required.').max(2000),
  apiKey: z.string().max(10000).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

imagesRouter.get('/image-connections', (_req, res) => {
  res.json({ connections: listImageConnections() });
});

imagesRouter.post(
  '/image-connections',
  wrap((req, res) => {
    const body = parseBody(imageConnectionSchema, req.body);
    res.status(201).json({
      connection: createImageConnection({
        ...body,
        settings: body.settings as ImageProviderSettings | undefined,
      } satisfies ImageConnectionInput),
    });
  }),
);

imagesRouter.patch(
  '/image-connections/:id',
  wrap((req, res) => {
    const id = stringParam(req.params.id, 'image connection id');
    const body = parseBody(imageConnectionSchema.partial(), req.body);
    res.json({
      connection: updateImageConnection(id, {
        ...body,
        settings: body.settings as ImageProviderSettings | undefined,
      }),
    });
  }),
);

imagesRouter.delete(
  '/image-connections/:id',
  wrap((req, res) => {
    deleteImageConnection(stringParam(req.params.id, 'image connection id'));
    res.status(204).end();
  }),
);

imagesRouter.post(
  '/image-connections/:id/test',
  wrap(async (req, res) => {
    const connection = getProviderImageConnection(
      stringParam(req.params.id, 'image connection id'),
    );
    res.json(await testImageConnection(connection));
  }),
);

const imageTemplateSchema = z.object({
  projectId: z.string().nullable().optional(),
  name: z.string().min(1, 'Template name is required.').max(200),
  content: z.string().min(1, 'Template content is required.').max(100000),
  isDefault: z.boolean().optional(),
});

imagesRouter.get(
  '/image-prompt-templates',
  wrap((req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    if (projectId) getProject(projectId);
    res.json({ templates: listImagePromptTemplates(projectId) });
  }),
);

imagesRouter.post(
  '/image-prompt-templates',
  wrap((req, res) => {
    const body = parseBody(imageTemplateSchema, req.body);
    if (body.projectId) getProject(body.projectId);
    res.status(201).json({
      template: createImagePromptTemplate({
        projectId: body.projectId ?? null,
        name: body.name,
        content: body.content,
        isDefault: body.isDefault,
      }),
    });
  }),
);

imagesRouter.patch(
  '/image-prompt-templates/:id',
  wrap((req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(100000).optional(),
        isDefault: z.boolean().optional(),
      }),
      req.body,
    );
    res.json({
      template: updateImagePromptTemplate(
        stringParam(req.params.id, 'image prompt template id'),
        body,
      ),
    });
  }),
);

imagesRouter.post(
  '/image-prompt-templates/:id/default',
  wrap((req, res) => {
    res.json({
      template: setDefaultImagePromptTemplate(
        stringParam(req.params.id, 'image prompt template id'),
      ),
    });
  }),
);

imagesRouter.delete(
  '/image-prompt-templates/:id',
  wrap((req, res) => {
    deleteImagePromptTemplate(stringParam(req.params.id, 'image prompt template id'));
    res.status(204).end();
  }),
);

imagesRouter.get(
  '/characters/:id/images',
  wrap((req, res) => {
    res.json(characterImageOverview(stringParam(req.params.id, 'character id')));
  }),
);

imagesRouter.get(
  '/chapters/:id/portraits',
  wrap((req, res) => {
    res.json(chapterPortraitOverview(stringParam(req.params.id, 'chapter id')));
  }),
);

imagesRouter.post(
  '/chapters/:id/portraits',
  wrap((req, res) => {
    const body = parseBody(
      z.object({
        characterId: z.string().min(1),
        connectionId: z.string().min(1).nullable().optional(),
        templateId: z.string().min(1).nullable().optional(),
        instructions: z.string().max(4000).optional(),
        moment: z.enum(['start', 'end', 'custom']).optional(),
        scene: z.string().max(8000).optional(),
        visualStyle: z.string().max(4000).optional(),
      }),
      req.body,
    );
    res.status(202).json({
      request: startChapterPortraitRequest(stringParam(req.params.id, 'chapter id'), {
        characterId: body.characterId,
        connectionId: body.connectionId ?? null,
        templateId: body.templateId ?? null,
        instructions: body.instructions,
        moment: body.moment,
        scene: body.scene,
        visualStyle: body.visualStyle,
      }),
    });
  }),
);

imagesRouter.post(
  '/chapter-portrait-requests/:id/cancel',
  wrap((req, res) => {
    res.json({
      request: cancelChapterPortraitRequest(stringParam(req.params.id, 'portrait request id')),
    });
  }),
);

const portraitBatchSchema = z
  .object({
    connectionId: z.string().min(1).nullable().optional(),
    templateId: z.string().min(1).nullable().optional(),
    instructions: z.string().max(4000).optional(),
    moment: z.enum(['start', 'end', 'custom']).optional(),
    scene: z.string().max(8000).optional(),
    visualStyle: z.string().max(4000).optional(),
    skipExisting: z.boolean().optional(),
    selectForChapter: z.boolean().optional(),
  })
  .default({});

imagesRouter.get(
  '/characters/:id/portrait-batch',
  wrap((req, res) => {
    const characterId = stringParam(req.params.id, 'character id');
    getCharacter(characterId);
    res.json({ batch: latestPortraitBatch(characterId) });
  }),
);

imagesRouter.post(
  '/characters/:id/portrait-batch',
  wrap((req, res) => {
    const body = parseBody(portraitBatchSchema, req.body);
    res.status(202).json({
      batch: startPortraitBatch(stringParam(req.params.id, 'character id'), body),
    });
  }),
);

imagesRouter.post(
  '/portrait-batches/:id/cancel',
  wrap((req, res) => {
    res.json({ batch: cancelPortraitBatch(stringParam(req.params.id, 'portrait batch id')) });
  }),
);

imagesRouter.post(
  '/characters/:id/images/prompt',
  wrap((req, res) => {
    const body = parseBody(
      z
        .object({
          chapterId: z.string().nullable().optional(),
          templateId: z.string().nullable().optional(),
          scene: z.string().max(8000).optional(),
          clothing: z.string().max(4000).optional(),
          visualStyle: z.string().max(4000).optional(),
          instructions: z.string().max(4000).optional(),
          moment: z.enum(['start', 'end', 'custom']).optional(),
        })
        .default({}),
      req.body,
    );
    res.status(202).json({
      job: startImagePromptGeneration(stringParam(req.params.id, 'character id'), body),
    });
  }),
);

imagesRouter.post(
  '/characters/:id/images',
  wrap((req, res) => {
    const body = parseBody(
      z.object({
        connectionId: z.string().min(1),
        prompt: z.string().min(1).max(8000),
        negativePrompt: z.string().max(4000).optional(),
        chapterId: z.string().nullable().optional(),
        templateId: z.string().nullable().optional(),
        templateName: z.string().max(200).nullable().optional(),
        templateContent: z.string().max(100000).nullable().optional(),
        moment: z.enum(['start', 'end', 'custom']).optional(),
        sourceRevisionId: z.string().nullable().optional(),
        sourceTextHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        referenceAssetId: z.string().nullable().optional(),
      }),
      req.body,
    );
    res.status(202).json({
      job: startImageGeneration(stringParam(req.params.id, 'character id'), body),
    });
  }),
);

imagesRouter.post(
  '/characters/:id/portrait',
  wrap((req, res) => {
    const body = parseBody(z.object({ assetId: z.string().nullable() }), req.body);
    res.json({
      character: setCharacterPortrait(
        stringParam(req.params.id, 'character id'),
        body.assetId,
      ),
    });
  }),
);

imagesRouter.get(
  '/image-jobs/:id',
  wrap((req, res) => {
    res.json({ job: getImageJob(stringParam(req.params.id, 'image job id')) });
  }),
);

imagesRouter.post(
  '/image-jobs/:id/cancel',
  wrap((req, res) => {
    res.json({ job: cancelImageGeneration(stringParam(req.params.id, 'image job id')) });
  }),
);

imagesRouter.post(
  '/image-jobs/:id/retry',
  wrap((req, res) => {
    res.status(202).json({ job: retryImageJob(stringParam(req.params.id, 'image job id')) });
  }),
);

imagesRouter.get(
  '/image-assets/:id/file',
  wrap((req, res, next) => {
    const row = getImageAssetRow(stringParam(req.params.id, 'image asset id'));
    const fileName = imageFilePath(row.file_name);
    if (!fs.existsSync(fileName)) {
      throw new AppError(404, 'The image file is missing from the data directory.');
    }
    res.setHeader('Content-Type', row.mime_type);
    if (req.query.download === '1') {
      const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
      const name = `${slug(getCharacter(row.character_id).name) || 'character'}-${row.chapter_id ? slug(getChapter(row.chapter_id).title) : 'reference'}-${row.id.slice(0,8)}.${row.mime_type.split('/')[1]}`;
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(fileName, { dotfiles: 'allow' }, (error) => {
      if (error) next(error);
    });
  }),
);

imagesRouter.delete(
  '/image-assets/:id',
  wrap((req, res) => {
    deleteImageAsset(stringParam(req.params.id, 'image asset id'));
    res.status(204).end();
  }),
);
