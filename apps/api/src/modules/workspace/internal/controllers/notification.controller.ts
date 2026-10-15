import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Body as BodyOf, Ok } from 'shared';
import { requireUserId } from '../../../../platform/context/cls-store.js';
import { Authz } from '../../../../platform/http/operation.decorator.js';
import { NotificationService, type NotificationQuery } from '../services/notification.service.js';

/** The notification bell: the caller's list and read marks (FR-WORK-19). */
@Controller('v1/me/notifications')
export class NotificationController {
  constructor(
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ClsService) private readonly cls: ClsService,
  ) {}

  @Get()
  @Authz('listNotifications')
  listNotifications(@Query() query: NotificationQuery): Promise<Ok<'listNotifications'>> {
    return this.notifications.list(requireUserId(this.cls), query);
  }

  @Post('read-marks')
  @HttpCode(204)
  @Authz('markNotificationsRead')
  async markNotificationsRead(@Body() body: BodyOf<'markNotificationsRead'>): Promise<void> {
    await this.notifications.markRead(requireUserId(this.cls), body.ids);
  }
}
