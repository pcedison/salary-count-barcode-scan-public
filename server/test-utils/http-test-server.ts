import type { Express } from 'express';
import express from 'express';
import type { Server } from 'http';

export interface JsonResponse<T> {
  response: Response;
  body: T | null;
  text: string;
}

export interface TestHttpServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function createJsonTestServer(
  registerRoutes: (app: Express) => void | Promise<void>,
  options?: {
    setupApp?: (app: Express) => void | Promise<void>;
  }
): Promise<TestHttpServer> {
  const app = express();
  app.use(express.json());
  if (options?.setupApp) {
    await options.setupApp(app);
  }
  await registerRoutes(app);

  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine test server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

export async function jsonRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {}
): Promise<JsonResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();

  if (!text) {
    return {
      response,
      body: null,
      text
    };
  }

  try {
    return {
      response,
      body: JSON.parse(text) as T,
      text
    };
  } catch {
    return {
      response,
      body: null,
      text
    };
  }
}
