// Vercel Serverless Function entrypoint routing all /api/* traffic to @nv3d/backend
import handler from '../backend/dist/serverless.js';

export default handler;
