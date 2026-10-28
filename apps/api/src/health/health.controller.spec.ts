import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';

describe('GET /api/v1/health', () => {
  let app: INestApplication;
  const database = {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(ConfigService).useValue(new ConfigService({
      AUTH_MODE: 'local-mock', NODE_ENV: 'test',
    })).overrideProvider(DatabaseService).useValue(database).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the API health response', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'ai-performance-agent-api',
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });

  it('reports readiness when PostgreSQL is reachable', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      service: 'ai-performance-agent-api',
      dependencies: { database: 'ok' },
      timestamp: expect.any(String),
    });
  });

  it('returns unavailable without exposing database errors when PostgreSQL is down', async () => {
    database.query.mockRejectedValueOnce(
      new Error('sensitive database connection detail'),
    );

    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);

    expect(JSON.stringify(response.body)).not.toContain(
      'sensitive database connection detail',
    );
  });
});
