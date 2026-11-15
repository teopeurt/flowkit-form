import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { loadConfig } from '@flowkitform/demo-domain';

import { AppModule } from './app.module';
export async function createDemoApp() { const app = await NestFactory.create(AppModule); app.enableShutdownHooks(); return app; }
if (import.meta.main) { const config = loadConfig(); const app = await createDemoApp(); await app.listen(config.FLOWKITFORM_PORT); process.stdout.write(`flowkitform API listening on ${config.FLOWKITFORM_PORT}\n`); }
