// Built-in help docs (#383): /v1/help/*, public like /v1/config, with the same answers as packages/server/src/routes/index.ts.
import { Hono } from 'hono';
import { getPage, listTopics } from '../help';

export const helpRoutes = new Hono();

helpRoutes.get('/v1/help/topics', (c) => c.json({ topics: listTopics() }));
helpRoutes.get('/v1/help/pages/:slug', (c) => c.json(getPage(c.req.param('slug'))));
