import { Module } from '@nestjs/common';
import { LinksOrigemController, LinksOrigemPublicController } from './links-origem.controller';
import { LinksOrigemService } from './links-origem.service';

@Module({
  controllers: [LinksOrigemController, LinksOrigemPublicController],
  providers: [LinksOrigemService],
})
export class LinksOrigemModule {}
