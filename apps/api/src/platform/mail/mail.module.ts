import { Global, Module } from '@nestjs/common';
import { SecretBox } from '../crypto/secret-box.js';
import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';

@Global()
@Module({
  providers: [SecretBox, MailService, MailProcessor],
  exports: [SecretBox, MailService],
})
export class MailModule {}
