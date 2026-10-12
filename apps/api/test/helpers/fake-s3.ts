import { createServer, type Server } from 'node:http';

export interface FakeS3 {
  endpoint: string;
  close(): Promise<void>;
}

/** Minimal S3 double: HEAD /<bucket> answers 200 for known buckets, 404 otherwise. */
export async function startFakeS3(buckets: string[]): Promise<FakeS3> {
  const server: Server = createServer((req, res) => {
    const bucket = (req.url ?? '').split('?')[0]?.replaceAll('/', '') ?? '';
    res.statusCode = req.method === 'HEAD' && buckets.includes(bucket) ? 200 : 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
