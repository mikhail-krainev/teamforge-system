import { S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';

export const S3 = Symbol('S3');

@Injectable()
class S3Lifecycle implements OnApplicationShutdown {
  constructor(@Inject(S3) private readonly client: S3Client) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/** S3-compatible client (MinIO): path-style addressing, no automatic retries on the hot path. */
@Global()
@Module({
  providers: [
    {
      provide: S3,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): S3Client =>
        new S3Client({
          endpoint: config.S3_ENDPOINT,
          region: 'us-east-1',
          forcePathStyle: true,
          maxAttempts: 1,
          credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
        }),
    },
    S3Lifecycle,
  ],
  exports: [S3],
})
export class S3Module {}
