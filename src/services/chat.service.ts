import { PrismaClient, ChatChannel, ChatMessage, ChatChannelType, ChatMemberRole, User } from '@prisma/client';
import { prisma as db } from '../config/db';
import { rbacService } from './rbac.service';
import { entitlementsService } from './entitlements.service';

class ChatService {
  /**
   * Create a new chat channel
   */
  async createChannel(
    name: string,
    slug: string,
    type: ChatChannelType,
    creatorId: string,
    options?: {
      description?: string;
      minRole?: string;
      entitlement?: string;
    }
  ): Promise<ChatChannel> {
    return db.chatChannel.create({
      data: {
        name,
        slug,
        type,
        created_by: creatorId,
        description: options?.description,
        min_role_required: options?.minRole,
        entitlement_required: options?.entitlement,
        participants: {
          create: {
            user_id: creatorId,
            role: ChatMemberRole.OWNER
          }
        }
      }
    });
  }

  /**
   * Get all channels a user has access to
   */
  async getChannelsForUser(userId: string): Promise<ChatChannel[]> {
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        plan: { include: { entitlements: { include: { entitlement: true } } } },
        rbac_roles: { include: { role: true } }
      }
    });

    if (!user) throw new Error('User not found');

    const allChannels = await db.chatChannel.findMany({
      where: { is_archived: false },
      include: {
        participants: {
          where: { user_id: userId }
        }
      }
    });

    // Filter channels based on access logic
    const accessibleChannels = [];

    for (const channel of allChannels) {
      if (await this.canAccessChannel(user, channel)) {
        accessibleChannels.push(channel);
      }
    }

    return accessibleChannels;
  }

  /**
   * Check if a user can access a specific channel
   */
  async canAccessChannel(user: any, channel: any): Promise<boolean> {
    // 1. If user is already a participant, they have access
    const isParticipant = channel.participants && channel.participants.some((p: any) => p.user_id === user.id);
    if (isParticipant) return true;

    // 2. Public channels are open to all
    if (channel.type === 'PUBLIC') return true;

    // 3. System channels might be restricted
    if (channel.type === 'SYSTEM') {
        // Only admins can see system channels unless invited
        return user.role === 'ADMIN'; 
    }

    // 4. Role Check
    if (channel.min_role_required) {
      // Simple check: does user have this specific role or is global admin?
      const hasRole = user.rbac_roles.some((r: any) => r.role.name === channel.min_role_required) || user.role === 'ADMIN';
      if (!hasRole) return false;
    }

    // 5. Entitlement Check
    if (channel.entitlement_required) {
        // Use the entitlement service to check
        const hasEntitlement = await entitlementsService.check(user.id, channel.entitlement_required);
        if (!hasEntitlement) return false;
    }

    return true;
  }

  /**
   * Join a channel
   */
  async joinChannel(userId: string, channelId: string): Promise<void> {
    const channel = await db.chatChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new Error('Channel not found');

    const user = await db.user.findUnique({
        where: { id: userId },
        include: { rbac_roles: { include: { role: true } } }
    });

    if (!await this.canAccessChannel(user, channel)) {
        throw new Error('Access denied');
    }

    await db.chatParticipant.create({
      data: {
        channel_id: channelId,
        user_id: userId,
        role: ChatMemberRole.MEMBER
      }
    });
  }

  /**
   * Send a message
   */
  async sendMessage(
    channelId: string,
    userId: string,
    content: string,
    type: 'TEXT' | 'IMAGE' | 'SYSTEM' = 'TEXT'
  ): Promise<ChatMessage> {
    // Validate membership
    const membership = await db.chatParticipant.findUnique({
      where: {
        channel_id_user_id: {
          channel_id: channelId,
          user_id: userId
        }
      }
    });

    if (!membership && !(await this.isAdmin(userId))) {
       // Auto-join if public? For now enforce join first.
       throw new Error('Must join channel to post');
    }

    const msg = await db.chatMessage.create({
      data: {
        channel_id: channelId,
        user_id: userId,
        content,
        type: type
      },
      include: {
        sender: {
            select: { id: true, name: true, email: true, avatar_url: true }
        }
      }
    });

    // Create notifications for other participants
    await this.createNotifications(msg.id, channelId, userId);

    return msg;
  }

  /**
   * Get messages for a channel
   */
  async getMessages(channelId: string, limit = 50, before?: Date): Promise<ChatMessage[]> {
    return db.chatMessage.findMany({
      where: {
        channel_id: channelId,
        created_at: before ? { lt: before } : undefined
      },
      take: limit,
      orderBy: { created_at: 'desc' },
      include: {
        sender: {
          select: { id: true, name: true, email: true, avatar_url: true }
        }
      }
    });
  }

  /**
   * Mark a channel as read for a user
   */
  async markAsRead(userId: string, channelId: string): Promise<void> {
    await db.chatParticipant.update({
      where: {
        channel_id_user_id: {
          channel_id: channelId,
          user_id: userId
        }
      },
      data: {
        last_read_at: new Date()
      }
    });
  }

  /**
   * Get total unread message count for a user across all joined channels
   */
  async getUnreadCount(userId: string): Promise<number> {
    const participations = await db.chatParticipant.findMany({
      where: { user_id: userId },
      select: { channel_id: true, last_read_at: true }
    });

    let totalUnread = 0;
    for (const p of participations) {
      const count = await db.chatMessage.count({
        where: {
          channel_id: p.channel_id,
          created_at: {
            gt: p.last_read_at || new Date(0)
          },
          user_id: { not: userId } // Don't count own messages
        }
      });
      totalUnread += count;
    }

    return totalUnread;
  }

  /**
   * Create notifications for all participants except sender
   */
  async createNotifications(messageId: string, channelId: string, senderId: string): Promise<void> {
    const participants = await db.chatParticipant.findMany({
      where: { 
        channel_id: channelId,
        user_id: { not: senderId }
      }
    });

    if (participants.length === 0) return;

    await db.chatNotification.createMany({
      data: participants.map(p => ({
        user_id: p.user_id,
        message_id: messageId,
        channel_id: channelId
      }))
    });
  }

  /**
   * Get pending notifications for a user
   */
  async getPendingNotifications(userId: string) {
    return db.chatNotification.findMany({
      where: { user_id: userId, is_sent: false },
      include: {
        message: {
          include: { sender: { select: { name: true, email: true } } }
        },
        channel: { select: { name: true } }
      },
      orderBy: { created_at: 'asc' }
    });
  }

  /**
   * Mark notifications as sent
   */
  async markNotificationsAsSent(ids: string[]) {
    await db.chatNotification.updateMany({
      where: { id: { in: ids } },
      data: { is_sent: true }
    });
  }

  private async isAdmin(userId: string): Promise<boolean> {
      const user = await db.user.findUnique({ where: { id: userId } });
      return user?.role === 'ADMIN';
  }
}

export const chatService = new ChatService();
