import { PrismaClient, ChatChannel, ChatMessage, ChatChannelType, ChatMemberRole, User, ChatAuditAction } from '@prisma/client';
import { prisma as db } from '../config/db';
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
   * Get or Create a DM channel between two users
   */
  async getOrCreateDM(userId: string, targetUserId: string): Promise<ChatChannel> {
    // Check for blocks
    if (await this.isBlocked(targetUserId, userId)) {
        throw new Error('You have been blocked by this user.');
    }
    if (await this.isBlocked(userId, targetUserId)) {
        throw new Error('You have blocked this user. Unblock them to chat.');
    }

    // Check entitlement
    const hasAccess = await entitlementsService.check(userId, 'chat.access');
    if (!hasAccess) throw new Error('You do not have access to chat.');

    // 1. Check if a PRIVATE channel exists with EXACTLY these two participants
    const user1Channels = await db.chatParticipant.findMany({
        where: { user_id: userId },
        select: { channel_id: true }
    });
    
    const channelIds = user1Channels.map(p => p.channel_id);
    
    if (channelIds.length > 0) {
        const commonChannels = await db.chatChannel.findMany({
            where: {
                id: { in: channelIds },
                type: 'PRIVATE',
                participants: {
                    some: { user_id: targetUserId }
                }
            },
            include: { participants: true }
        });

        const existingDM = commonChannels.find(c => c.participants.length === 2 && c.name.startsWith('dm-'));
        
        if (existingDM) return existingDM;
    }

    // 2. Create new DM
    const targetUser = await db.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) throw new Error('Target user not found');
    
    const slug = `dm-${userId.substring(0,8)}-${targetUserId.substring(0,8)}-${Date.now()}`;
    const name = `dm-${targetUser.name || targetUser.email}`; // Internal name

    return db.chatChannel.create({
        data: {
            name,
            slug,
            type: 'PRIVATE',
            created_by: userId,
            participants: {
                create: [
                    { user_id: userId, role: ChatMemberRole.OWNER },
                    { user_id: targetUserId, role: ChatMemberRole.MEMBER }
                ]
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
    // 1. If user is already a participant, they have access (unless kicked/banned logic added later)
    const isParticipant = channel.participants && channel.participants.some((p: any) => p.user_id === user.id);
    if (isParticipant) return true;

    // 2. Public channels are open to all
    if (channel.type === 'PUBLIC') return true;

    // 3. System channels
    if (channel.type === 'SYSTEM') {
        return user.role === 'ADMIN'; 
    }

    // 4. Role Check (Enforce Strict Visibility for Admin Channels)
    if (channel.min_role_required) {
        // If min_role is set, user MUST have it or be SUPERADMIN (if we had that, for now ADMIN)
        // Check user roles
        const userRoleNames = user.rbac_roles.map((r: any) => r.role.name);
        if (user.role === 'ADMIN') userRoleNames.push('ADMIN'); // Global admin implicit

        if (!userRoleNames.includes(channel.min_role_required) && user.role !== 'ADMIN') {
             return false;
        }
        // Even if ADMIN, if specific role is required (e.g. "SUPER_ADMIN_ONLY"), regular ADMIN might be excluded?
        // Prompt says "mark as admin... only admins can see".
        // Current logic: If min_role_required is set, checks if user has it.
        // If user is basic USER, they fail.
        return userRoleNames.includes(channel.min_role_required) || user.role === 'ADMIN';
    }

    // 5. Entitlement Check
    if (channel.entitlement_required) {
        const hasEntitlement = await entitlementsService.check(user.id, channel.entitlement_required);
        if (!hasEntitlement) return false;
    }

    return true;
  }

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

  async sendMessage(
    channelId: string,
    userId: string,
    content: string,
    type: 'TEXT' | 'IMAGE' | 'SYSTEM' = 'TEXT',
    attachments?: { filename: string, path: string, mimetype: string, size: number }[]
  ): Promise<ChatMessage> {
    const membership = await db.chatParticipant.findUnique({
      where: { channel_id_user_id: { channel_id: channelId, user_id: userId } }
    });

    if (!membership && !(await this.isAdmin(userId))) {
       throw new Error('Must join channel to post');
    }

    const msg = await db.chatMessage.create({
      data: {
        channel_id: channelId,
        user_id: userId,
        content,
        type: type,
        attachments: attachments && attachments.length > 0 ? {
            create: attachments.map(att => {
                // Normalize path separators
                const normalized = att.path.replace(/\\/g, '/');
                let url = normalized;
                
                // Try to find relative path from 'uploads/'
                // Supports both /app/public/uploads/... and C:/.../public/uploads/...
                const uploadIndex = normalized.toLowerCase().indexOf('/uploads/');
                if (uploadIndex !== -1) {
                    // Extract starting from 'uploads/' (remove leading slash if present in substring)
                    url = normalized.substring(uploadIndex + 1); 
                } else if (normalized.toLowerCase().indexOf('uploads/') !== -1) {
                     // Fallback for paths starting with uploads/ or windows path normalized
                     url = normalized.substring(normalized.toLowerCase().indexOf('uploads/'));
                }
                
                return {
                    file_name: att.filename,
                    url: url,
                    file_type: att.mimetype,
                    file_size: att.size
                };
            })
        } : undefined
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatar_url: true } },
        attachments: true
      }
    });

    await this.createNotifications(msg.id, channelId, userId);
    return msg;
  }

  async editMessage(messageId: string, userId: string, newContent: string): Promise<ChatMessage> {
    const message = await db.chatMessage.findUnique({ where: { id: messageId } });
    if (!message) throw new Error('Message not found');
    if (message.user_id !== userId && !(await this.isAdmin(userId))) throw new Error('Permission denied');
    if (message.deleted_at) throw new Error('Cannot edit deleted message');

    const oldContent = message.content;
    const updated = await db.chatMessage.update({
        where: { id: messageId },
        data: { content: newContent, is_edited: true },
        include: {
            sender: { select: { id: true, name: true, email: true, avatar_url: true } },
            attachments: true
        }
    });

    await db.chatAuditLog.create({
        data: {
            message_id: messageId,
            actor_id: userId,
            action: ChatAuditAction.EDIT,
            old_content: oldContent,
            new_content: newContent
        }
    });

    return updated;
  }

  async deleteMessage(messageId: string, userId: string): Promise<ChatMessage> {
    const message = await db.chatMessage.findUnique({ where: { id: messageId } });
    if (!message) throw new Error('Message not found');
    if (message.user_id !== userId && !(await this.isAdmin(userId))) throw new Error('Permission denied');

    const updated = await db.chatMessage.update({
        where: { id: messageId },
        data: { deleted_at: new Date() },
        include: {
            sender: { select: { id: true, name: true, email: true, avatar_url: true } },
            attachments: true
        }
    });

    await db.chatAuditLog.create({
        data: {
            message_id: messageId,
            actor_id: userId,
            action: ChatAuditAction.DELETE,
            old_content: message.content
        }
    });

    return updated;
  }

  async getMessages(channelId: string, limit = 50, before?: Date): Promise<ChatMessage[]> {
    return db.chatMessage.findMany({
      where: {
        channel_id: channelId,
        created_at: before ? { lt: before } : undefined
      },
      take: limit,
      orderBy: { created_at: 'desc' },
      include: {
        sender: { select: { id: true, name: true, email: true, avatar_url: true } },
        attachments: true
      }
    });
  }

  async markAsRead(userId: string, channelId: string): Promise<void> {
    await db.chatParticipant.update({
      where: { channel_id_user_id: { channel_id: channelId, user_id: userId } },
      data: { last_read_at: new Date() }
    });
  }

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
          created_at: { gt: p.last_read_at || new Date(0) },
          user_id: { not: userId },
          deleted_at: null // Don't count deleted messages
        }
      });
      totalUnread += count;
    }
    return totalUnread;
  }

  async createNotifications(messageId: string, channelId: string, senderId: string): Promise<void> {
    const participants = await db.chatParticipant.findMany({
      where: { channel_id: channelId, user_id: { not: senderId } }
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

  async getPendingNotifications(userId: string) {
    return db.chatNotification.findMany({
      where: { user_id: userId, is_sent: false },
      include: {
        message: { include: { sender: { select: { name: true, email: true } } } },
        channel: { select: { name: true } }
      },
      orderBy: { created_at: 'asc' }
    });
  }

  async markNotificationsAsSent(ids: string[]) {
    await db.chatNotification.updateMany({
      where: { id: { in: ids } },
      data: { is_sent: true }
    });
  }

  // --- Blocking & Candidates ---

  async blockUser(blockerId: string, blockedId: string) {
      const blocker = await db.user.findUnique({ where: { id: blockerId } });
      if (!blocker?.can_block_people) throw new Error('You are not allowed to block users.');
      
      await db.userBlock.create({
          data: { blocker_id: blockerId, blocked_id: blockedId }
      });
  }

  async unblockUser(blockerId: string, blockedId: string) {
      await db.userBlock.deleteMany({
          where: { blocker_id: blockerId, blocked_id: blockedId }
      });
  }

  async isBlocked(blockerId: string, targetId: string): Promise<boolean> {
      const count = await db.userBlock.count({
          where: { blocker_id: blockerId, blocked_id: targetId }
      });
      return count > 0;
  }

  async getMsgCandidates(userId: string, query?: string): Promise<{ id: string, name: string, email: string, avatar_url: string }[]> {
      // Get blocked users (both ways) to exclude
      const blocks = await db.userBlock.findMany({
          where: {
              OR: [
                  { blocker_id: userId },
                  { blocked_id: userId }
              ]
          }
      });
      const excludeIds = blocks.map(b => b.blocker_id === userId ? b.blocked_id : b.blocker_id);
      excludeIds.push(userId); // Exclude self

      // Find users matching query
      const whereClause: any = {
          id: { notIn: excludeIds }
      };

      if (query) {
          whereClause.OR = [
              { name: { contains: query, mode: 'insensitive' } },
              { email: { contains: query, mode: 'insensitive' } }
          ];
      }

      const candidates = await db.user.findMany({
          where: whereClause,
          take: 20,
          select: { id: true, name: true, email: true, avatar_url: true }
      });

      return candidates.map(u => ({
          id: u.id,
          name: u.name || 'Unknown',
          email: u.email,
          avatar_url: u.avatar_url || ''
      }));
  }

  private async isAdmin(userId: string): Promise<boolean> {
      const user = await db.user.findUnique({ where: { id: userId } });
      return user?.role === 'ADMIN';
  }
}

export const chatService = new ChatService();
