import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { prisma } from '@auctioncraze/database';
import { config } from './config/env';
import { checkRedisHealth } from './lib/redis';
import { errorHandler } from './middleware/errorHandler';
import sessionRoutes from './modules/sessions/sessionRoutes';
import roomRoutes from './modules/rooms/roomRoutes';
import playerRoutes from './modules/players/playerRoutes';
import intelligenceRoutes from './modules/intelligence/intelligenceRoutes';
import seasonRoutes from './modules/seasons/seasonRoutes';

export interface CreateAppOptions {
  trustProxyHops?: number;
}

export function createApp(options?: CreateAppOptions): express.Application {
  const app = express();
  const trustProxyHops = options?.trustProxyHops ?? config.trustProxyHops;
  app.set('trust proxy', trustProxyHops);

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server / curl / test clients with no Origin header, plus explicit allowlist
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin '${origin}' not allowed by CORS policy.`));
      },
      credentials: true
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (config.nodeEnv !== 'test') {
    app.use(morgan('dev'));
  }

  app.get('/health', async (_req, res) => {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const redisOk = await checkRedisHealth();

    const healthy = dbOk && redisOk;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      service: 'auctioncraze-api',
      dependencies: {
        postgres: dbOk ? 'up' : 'down',
        redis: redisOk ? 'up' : 'down'
      },
      timestamp: new Date().toISOString()
    });
  });

  app.use('/api/v1/sessions', sessionRoutes);
  app.use('/api/v1/rooms', roomRoutes);
  app.use('/api/v1/players', playerRoutes);
  app.use('/api/v1/intelligence', intelligenceRoutes);
  app.use('/api/v1/seasons', seasonRoutes);

  app.use(errorHandler);

  return app;
}
